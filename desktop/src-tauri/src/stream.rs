//! Shared plumbing for the v2 mailbox subscription (`mailbox.rs`): the HTTP client, reconnect
//! backoff, an incremental SSE parser, wake-from-sleep detection and the stream task handle.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::Notify;

pub(crate) const WAKE_TICK: Duration = Duration::from_secs(5);
const WAKE_GAP: Duration = Duration::from_secs(10);
pub(crate) const MAX_BUFFER: usize = 64 * 1024;

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("grokbot-deskpet/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(redirect_policy))
        .build()
        .expect("http client")
}

const MAX_REDIRECTS: usize = 5;

/// Follow a mailbox's redirects, but never from https down to plain http: the request URL
/// carries the topic name. At most `MAX_REDIRECTS` hops.
fn redirect_policy(attempt: reqwest::redirect::Attempt) -> reqwest::redirect::Action {
    let was_https = attempt.previous().first().is_some_and(|u| u.scheme() == "https");
    if was_https && attempt.url().scheme() != "https" {
        attempt.error("refusing to follow a redirect from https to http")
    } else if attempt.previous().len() > MAX_REDIRECTS {
        attempt.stop()
    } else {
        attempt.follow()
    }
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

/// Incremental text/event-stream parser (enough of the spec for ntfy).
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

// ---------------------------------------------------------------- stream task

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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// A tiny local server: `/hop/<n>` redirects to `/hop/<n-1>`, `/hop/0` answers "ok", and
    /// `/to-elsewhere` redirects to `target`.
    async fn redirect_server(target: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let mut buf = vec![0; 2048];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let resp = match path.strip_prefix("/hop/").and_then(|n| n.parse::<u32>().ok()) {
                    Some(0) => "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok".to_string(),
                    Some(n) => format!("HTTP/1.1 302 Found\r\nlocation: /hop/{}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", n - 1),
                    None => format!("HTTP/1.1 302 Found\r\nlocation: {target}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"),
                };
                let _ = s.write_all(resp.as_bytes()).await;
            }
        });
        base
    }

    #[tokio::test]
    async fn redirects_are_followed_a_few_times() {
        let base = redirect_server("/hop/0").await;
        let c = http_client();
        let ok = c.get(format!("{base}/hop/3")).send().await.unwrap();
        assert_eq!(ok.text().await.unwrap(), "ok");
        // Past MAX_REDIRECTS the client stops and hands back the redirect itself.
        let stopped = c.get(format!("{base}/hop/{}", MAX_REDIRECTS + 3)).send().await.unwrap();
        assert_eq!(stopped.status(), 302);
        // http → http is allowed (local dev mailboxes); only https → http is refused.
        let same = c.get(format!("{base}/to-elsewhere")).send().await.unwrap();
        assert_eq!(same.text().await.unwrap(), "ok");
    }
}
