//! Relay client in Rust: pairing calls and the SSE subscription.
//!
//! The webview never sees the relay token and never talks to the relay directly, so the relay
//! needs no CORS and the token stays in the keychain + this process. Events are forwarded to
//! the webview as Tauri events:
//!   relay:status       {status: "connecting"|"online"|"offline", detail?}
//!   relay:state        the relay's state event JSON (passed through)
//!   relay:paired       {agent_id, agent_name, ts}
//!   relay:ready        {resumed, states, paired, version}
//!   relay:unauthorized {}   (token rejected/revoked; it has been removed from the keychain)

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::secrets;

const WATCHDOG: Duration = Duration::from_secs(45); // relay pings every 15s
const STALE_FOR_KICK: Duration = Duration::from_secs(20);
pub(crate) const WAKE_TICK: Duration = Duration::from_secs(5);
const WAKE_GAP: Duration = Duration::from_secs(10);
pub(crate) const MAX_BUFFER: usize = 64 * 1024;

// ---------------------------------------------------------------- URL validation

/// Validate and normalise a relay base URL. https anywhere; plain http only for loopback.
/// No credentials, query, fragment or path (a trailing slash is fine).
pub fn normalize_relay_url(input: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(input.trim()).map_err(|_| "not a valid URL".to_string())?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err("relay URL must not contain credentials".into());
    }
    if u.query().is_some() || u.fragment().is_some() || (u.path() != "/" && !u.path().is_empty()) {
        return Err("relay URL must be just scheme://host[:port]".into());
    }
    let loopback = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    match u.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => return Err("https is required (http only for localhost)".into()),
        _ => return Err("relay URL must be http(s)".into()),
    }
    if u.host_str().is_none() {
        return Err("relay URL needs a host".into());
    }
    Ok(u)
}

fn endpoint(base: &url::Url, path: &str) -> url::Url {
    let mut u = base.clone();
    u.set_path(path);
    u
}

// ---------------------------------------------------------------- backoff

/// Exponential backoff with jitter: base = min(30s, 1s * 2^attempt), delay in [base/2, base].
pub fn backoff_delay(attempt: u32, jitter01: f64) -> Duration {
    let base_ms = (1000u64 << attempt.min(5)).min(30_000) as f64;
    let j = jitter01.clamp(0.0, 1.0);
    Duration::from_millis((base_ms / 2.0 + j * base_ms / 2.0) as u64)
}

pub(crate) fn jitter() -> f64 {
    let mut h = RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos());
    (h.finish() >> 11) as f64 / (1u64 << 53) as f64
}

// ---------------------------------------------------------------- SSE parsing

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
}

/// Incremental text/event-stream parser (enough of the spec for our relay).
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    pub last_id: Option<String>,
    pub retry_ms: Option<u64>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend(chunk.iter().copied().filter(|&b| b != b'\r'));
        let mut out = Vec::new();
        while let Some(i) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.buf.drain(..i + 2).collect();
            let text = String::from_utf8_lossy(&block[..i]);
            let (mut event, mut data, mut id) = (String::from("message"), Vec::<&str>::new(), None);
            for line in text.split('\n') {
                if line.starts_with(':') {
                    continue; // comment
                }
                let (field, value) = match line.find(':') {
                    Some(p) => (&line[..p], line[p + 1..].strip_prefix(' ').unwrap_or(&line[p + 1..])),
                    None => (line, ""),
                };
                match field {
                    "event" => event = value.to_string(),
                    "data" => data.push(value),
                    "id" if !value.contains('\0') => id = Some(value.to_string()),
                    "retry" => self.retry_ms = value.parse().ok(),
                    _ => {}
                }
            }
            if let Some(i) = &id {
                self.last_id = Some(i.clone());
            }
            if !data.is_empty() {
                out.push(SseEvent { event, data: data.join("\n"), id });
            }
        }
        if self.buf.len() > MAX_BUFFER {
            self.buf.clear(); // never grow without bound on garbage
        }
        out
    }
}

// ---------------------------------------------------------------- HTTP calls

#[derive(Serialize)]
pub struct PairStartOut {
    pub code: String,
    pub expires_at: String,
}

#[derive(serde::Deserialize)]
struct PairStartResp {
    code: String,
    token: String,
    expires_at: String,
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("grokbot-deskpet/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

/// Short, secret-free error text for the UI.
fn net_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "relay timed out".into()
    } else if e.is_connect() {
        "can't reach the relay".into()
    } else {
        "relay request failed".into()
    }
}

pub async fn pair_start(client: &reqwest::Client, relay: &url::Url) -> Result<PairStartOut, String> {
    let r = client
        .post(endpoint(relay, "/v1/pair/start"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| net_err(&e))?;
    if !r.status().is_success() {
        return Err(format!("relay answered {}", r.status().as_u16()));
    }
    let body: PairStartResp = r.json().await.map_err(|_| "unexpected relay response".to_string())?;
    let PairStartResp { code, token, expires_at } = body;
    secrets::set(relay, &token)?;
    Ok(PairStartOut { code, expires_at })
}

/// Best effort: revoke the token at the relay. The caller forgets it locally either way.
pub async fn revoke(client: &reqwest::Client, relay: &url::Url, token: &str) {
    let _ = client
        .post(endpoint(relay, "/v1/unpair"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
}

// ---------------------------------------------------------------- stream task

#[derive(Serialize, Clone)]
struct Status {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

pub struct StreamHandle {
    pub(crate) task: tauri::async_runtime::JoinHandle<()>,
    pub(crate) kick: Arc<Notify>,
}

impl StreamHandle {
    pub fn stop(self) {
        self.task.abort();
    }
    /// Network change / wake / user asked: reconnect now if the stream isn't demonstrably alive.
    pub fn kick(&self) {
        self.kick.notify_one();
    }
}

#[derive(Default)]
pub struct RelayState {
    pub stream: Mutex<Option<StreamHandle>>,
}

fn emit_status(app: &AppHandle, status: &'static str, detail: Option<&str>) {
    let _ = app.emit("relay:status", Status { status, detail: detail.map(str::to_string) });
}

/// Detects a jump of the wall clock against the monotonic clock (on macOS `Instant` stops
/// while the machine sleeps), i.e. "we just woke up".
pub(crate) struct WakeDetector {
    mono: Instant,
    wall: SystemTime,
}

impl WakeDetector {
    pub(crate) fn new() -> Self {
        Self { mono: Instant::now(), wall: SystemTime::now() }
    }
    pub(crate) fn woke(&mut self) -> bool {
        let (m, w) = (Instant::now(), SystemTime::now());
        let mono = m.duration_since(self.mono);
        let wall = w.duration_since(self.wall).unwrap_or_default();
        self.mono = m;
        self.wall = w;
        wall > mono + WAKE_GAP
    }
}

pub fn start_stream(app: AppHandle, client: reqwest::Client, relay: url::Url, token: String) -> StreamHandle {
    let kick = Arc::new(Notify::new());
    let k = kick.clone();
    let task = tauri::async_runtime::spawn(async move { run(app, client, relay, token, k).await });
    StreamHandle { task, kick }
}

enum Outcome {
    Retry { min: Duration, detail: &'static str },
    RetryNow,
    Unauthorized,
}

async fn run(app: AppHandle, client: reqwest::Client, relay: url::Url, token: String, kick: Arc<Notify>) {
    let mut attempt: u32 = 0;
    let mut last_id: Option<String> = None;
    let last_byte = Arc::new(AtomicU64::new(0));
    let epoch = Instant::now();
    loop {
        emit_status(&app, if attempt == 0 { "connecting" } else { "offline" }, (attempt > 0).then_some("reconnecting"));
        let outcome = connect_once(&app, &client, &relay, &token, &kick, &mut last_id, &mut attempt, &last_byte, epoch).await;
        let (min, detail) = match outcome {
            Outcome::Unauthorized => {
                let _ = secrets::delete(&relay);
                let _ = app.emit("relay:unauthorized", serde_json::json!({}));
                return;
            }
            Outcome::RetryNow => {
                attempt = 0;
                continue;
            }
            Outcome::Retry { min, detail } => (min, detail),
        };
        emit_status(&app, "offline", Some(detail));
        let delay = backoff_delay(attempt, jitter()).max(min);
        attempt = attempt.saturating_add(1);
        let mut wake = WakeDetector::new();
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        let mut tick = tokio::time::interval(WAKE_TICK);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                _ = kick.notified() => { attempt = 0; break; }
                _ = tick.tick() => if wake.woke() { attempt = 0; break; },
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn connect_once(
    app: &AppHandle,
    client: &reqwest::Client,
    relay: &url::Url,
    token: &str,
    kick: &Notify,
    last_id: &mut Option<String>,
    attempt: &mut u32,
    last_byte: &AtomicU64,
    epoch: Instant,
) -> Outcome {
    let mut req = client
        .get(endpoint(relay, "/v1/stream"))
        .bearer_auth(token)
        .header("accept", "text/event-stream")
        .header("cache-control", "no-store");
    if let Some(id) = last_id.as_deref() {
        req = req.header("last-event-id", id);
    }
    let resp = match tokio::time::timeout(Duration::from_secs(15), req.send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) if e.is_connect() => return Outcome::Retry { min: Duration::ZERO, detail: "relay unreachable" },
        _ => return Outcome::Retry { min: Duration::ZERO, detail: "relay not responding" },
    };
    match resp.status().as_u16() {
        200 => {}
        401 => return Outcome::Unauthorized,
        429 => return Outcome::Retry { min: Duration::from_secs(15), detail: "too many open windows" },
        _ => return Outcome::Retry { min: Duration::ZERO, detail: "relay error" },
    }
    *attempt = 0;
    emit_status(app, "online", None);
    let mut parser = SseParser { last_id: last_id.clone(), ..Default::default() };
    let mut body = resp.bytes_stream();
    let mut wake = WakeDetector::new();
    let mut tick = tokio::time::interval(WAKE_TICK);
    let mut deadline = Instant::now() + WATCHDOG;
    let since = |e: Instant| Instant::now().duration_since(e).as_millis() as u64;
    last_byte.store(since(epoch), Ordering::Relaxed);
    loop {
        tokio::select! {
            chunk = body.next() => match chunk {
                Some(Ok(bytes)) => {
                    deadline = Instant::now() + WATCHDOG;
                    last_byte.store(since(epoch), Ordering::Relaxed);
                    for ev in parser.push(&bytes) {
                        match ev.event.as_str() {
                            "state" | "paired" | "ready" => {
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.data) {
                                    let _ = app.emit(&format!("relay:{}", ev.event), v);
                                }
                            }
                            "revoked" => return Outcome::Unauthorized,
                            _ => {} // ping and unknown events: liveness only
                        }
                    }
                    *last_id = parser.last_id.clone();
                }
                Some(Err(_)) | None => return Outcome::Retry { min: Duration::ZERO, detail: "connection lost" },
            },
            _ = kick.notified() => {
                // Only reconnect if the stream has gone quiet; a healthy stream keeps running.
                if since(epoch).saturating_sub(last_byte.load(Ordering::Relaxed)) > STALE_FOR_KICK.as_millis() as u64 {
                    return Outcome::RetryNow;
                }
            }
            _ = tick.tick() => {
                if wake.woke() {
                    return Outcome::RetryNow; // the TCP connection rarely survives sleep
                }
                if Instant::now() > deadline {
                    return Outcome::Retry { min: Duration::ZERO, detail: "connection timed out" };
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation() {
        assert_eq!(normalize_relay_url("http://127.0.0.1:8787").unwrap().as_str(), "http://127.0.0.1:8787/");
        assert!(normalize_relay_url("http://localhost:8787/").is_ok());
        assert!(normalize_relay_url("https://grokbot-deskpet-relay.fly.dev").is_ok());
        assert!(normalize_relay_url("http://example.com").is_err(), "plain http off-host");
        assert!(normalize_relay_url("https://u:p@example.com").is_err());
        assert!(normalize_relay_url("https://example.com/v1").is_err());
        assert!(normalize_relay_url("https://example.com/?x=1").is_err());
        assert!(normalize_relay_url("ftp://example.com").is_err());
        assert!(normalize_relay_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn backoff_is_capped_and_jittered() {
        assert_eq!(backoff_delay(0, 0.0), Duration::from_millis(500));
        assert_eq!(backoff_delay(0, 1.0), Duration::from_millis(1000));
        assert_eq!(backoff_delay(3, 0.5), Duration::from_millis(6000));
        for a in 0..100 {
            for j in [0.0, 0.3, 1.0] {
                assert!(backoff_delay(a, j) <= Duration::from_secs(30));
            }
        }
        assert_eq!(backoff_delay(40, 1.0), Duration::from_secs(30));
        let j = jitter();
        assert!((0.0..1.0).contains(&j));
    }

    #[test]
    fn sse_parser_handles_split_chunks_ids_and_retry() {
        let mut p = SseParser::default();
        assert!(p.push(b"retry: 3000\n\n").is_empty());
        assert_eq!(p.retry_ms, Some(3000));
        assert!(p.push(b"id: ab-1\nevent: sta").is_empty());
        let evs = p.push(b"te\r\ndata: {\"a\":1}\r\n\r\n: comment\n\nevent: ping\ndata: {}\n\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0], SseEvent { event: "state".into(), data: "{\"a\":1}".into(), id: Some("ab-1".into()) });
        assert_eq!(evs[1].event, "ping");
        assert_eq!(p.last_id.as_deref(), Some("ab-1"), "events without id keep the last id");
    }

    #[test]
    fn sse_parser_bounds_memory() {
        let mut p = SseParser::default();
        p.push(&vec![b'x'; MAX_BUFFER + 10]);
        assert!(p.buf.is_empty());
    }
}
