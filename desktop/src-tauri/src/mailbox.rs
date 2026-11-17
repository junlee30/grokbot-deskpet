//! Desk Pet v2 mailbox client: subscribes to the pairing's ntfy topic over SSE, decrypts each
//! message (see `v2.rs`), drops anything forged, replayed, stale or oversize, and hands valid
//! events to a sink. In the app the sink emits Tauri events:
//!   mailbox:status  {status: "connecting"|"online"|"offline", detail?}
//!   mailbox:state   the state event JSON the UI draws pets from (plus "via":"v2")
//!
//! The mailbox (ntfy.sh by default, or a self-hosted ntfy) only ever sees ciphertext. The topic
//! is in the request URL (that's how ntfy works) and is never logged; the key never leaves this
//! process and the keychain.
//!
//! Catch-up: the first connection asks for `since=10m` (the replay window), reconnects ask for
//! `since=<last message id>`, so nothing is missed across short drops and nothing old is shown.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::stream::{backoff_delay, jitter, SseParser, StreamHandle, WakeDetector, WAKE_TICK};
use crate::v2::{now_ms, parse_event, Pairing, ReplayGuard, MAX_ENVELOPE};

/// ntfy sends a keepalive every 45 s (ntfy.sh default); allow for two to go missing.
const WATCHDOG: Duration = Duration::from_secs(100);
const STALE_FOR_KICK: Duration = Duration::from_secs(60);
const INITIAL_SINCE: &str = "10m";

#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Status { status: &'static str, detail: Option<&'static str> },
    State(Value),
}

pub type Sink = Arc<dyn Fn(Out) + Send + Sync>;

/// Counters for rejected messages (never their contents).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Stats {
    pub accepted: u64,
    pub bad_envelope: u64,
    pub bad_mac: u64,
    pub bad_event: u64,
    pub replayed: u64,
}

/// Decrypt + validate + replay-check one ntfy SSE data line. Pure apart from its own state.
pub struct Inbox {
    pairing: Pairing,
    guard: ReplayGuard,
    pub stats: Stats,
    /// The newest ntfy message id seen (for `since=` on reconnect).
    pub last_id: Option<String>,
}

impl Inbox {
    pub fn new(pairing: Pairing) -> Self {
        Self { pairing, guard: ReplayGuard::default(), stats: Stats::default(), last_id: None }
    }

    /// Returns the UI event for a valid message, None for anything else (keepalives, junk).
    pub fn handle(&mut self, data: &str, now: i64) -> Option<Value> {
        if data.len() > MAX_ENVELOPE * 2 {
            self.stats.bad_envelope += 1;
            return None;
        }
        let v: Value = serde_json::from_str(data).ok()?;
        if v.get("event").and_then(Value::as_str) != Some("message") {
            return None; // open / keepalive / poll_request
        }
        if let Some(id) = v.get("id").and_then(Value::as_str).filter(|s| s.len() <= 64) {
            if id.bytes().all(|b| b.is_ascii_alphanumeric()) {
                self.last_id = Some(id.to_string());
            }
        }
        // A body over ntfy's message limit turns into an attachment: never ours.
        let Some(body) = v.get("message").and_then(Value::as_str).filter(|_| v.get("attachment").is_none()) else {
            self.stats.bad_envelope += 1;
            return None;
        };
        let plaintext = match self.pairing.open(body) {
            Ok(p) => p,
            Err("bad mac") => {
                self.stats.bad_mac += 1;
                return None;
            }
            Err(_) => {
                self.stats.bad_envelope += 1;
                return None;
            }
        };
        let Ok(ev) = parse_event(&plaintext) else {
            self.stats.bad_event += 1;
            return None;
        };
        if self.guard.check(&ev, now).is_err() {
            self.stats.replayed += 1;
            return None;
        }
        self.stats.accepted += 1;
        // When the mailbox received it: catch-up messages are old, so the UI won't toast them.
        let received = v.get("time").and_then(Value::as_i64).map(|t| (t * 1000).min(now)).unwrap_or(now);
        Some(ev.to_ui_json(received))
    }
}

pub fn sse_url(p: &Pairing, since: &str) -> String {
    format!("{}/{}/sse?since={}", p.base, p.topic_name(), since)
}

pub fn start(client: reqwest::Client, pairing: Pairing, sink: Sink) -> StreamHandle {
    let kick = Arc::new(Notify::new());
    let k = kick.clone();
    let task = tauri::async_runtime::spawn(async move { run(client, pairing, sink, k).await });
    StreamHandle { task, kick }
}

enum Outcome {
    Retry { min: Duration, detail: &'static str },
    RetryNow,
}

pub async fn run(client: reqwest::Client, pairing: Pairing, sink: Sink, kick: Arc<Notify>) {
    let mut inbox = Inbox::new(pairing);
    let mut attempt: u32 = 0;
    let last_byte = AtomicU64::new(0);
    let epoch = Instant::now();
    loop {
        sink(Out::Status { status: if attempt == 0 { "connecting" } else { "offline" }, detail: (attempt > 0).then_some("reconnecting") });
        let (min, detail) = match connect_once(&client, &mut inbox, &sink, &kick, &mut attempt, &last_byte, epoch).await {
            Outcome::RetryNow => {
                attempt = 0;
                continue;
            }
            Outcome::Retry { min, detail } => (min, detail),
        };
        sink(Out::Status { status: "offline", detail: Some(detail) });
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

async fn connect_once(
    client: &reqwest::Client,
    inbox: &mut Inbox,
    sink: &Sink,
    kick: &Notify,
    attempt: &mut u32,
    last_byte: &AtomicU64,
    epoch: Instant,
) -> Outcome {
    let since = inbox.last_id.clone().unwrap_or_else(|| INITIAL_SINCE.to_string());
    let req = client
        .get(sse_url(&inbox.pairing, &since))
        .header("accept", "text/event-stream")
        .header("cache-control", "no-store");
    let resp = match tokio::time::timeout(Duration::from_secs(15), req.send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) if e.is_connect() => return Outcome::Retry { min: Duration::ZERO, detail: "mailbox unreachable" },
        _ => return Outcome::Retry { min: Duration::ZERO, detail: "mailbox not responding" },
    };
    match resp.status().as_u16() {
        200 => {}
        429 => return Outcome::Retry { min: Duration::from_secs(60), detail: "mailbox rate limit" },
        _ => return Outcome::Retry { min: Duration::from_secs(5), detail: "mailbox error" },
    }
    *attempt = 0;
    sink(Out::Status { status: "online", detail: None });
    let mut parser = SseParser::default();
    let mut body = resp.bytes_stream();
    let mut wake = WakeDetector::new();
    let mut tick = tokio::time::interval(WAKE_TICK);
    let mut deadline = Instant::now() + WATCHDOG;
    let since_epoch = |e: Instant| Instant::now().duration_since(e).as_millis() as u64;
    last_byte.store(since_epoch(epoch), Ordering::Relaxed);
    loop {
        tokio::select! {
            chunk = body.next() => match chunk {
                Some(Ok(bytes)) => {
                    deadline = Instant::now() + WATCHDOG;
                    last_byte.store(since_epoch(epoch), Ordering::Relaxed);
                    for ev in parser.push(&bytes) {
                        if let Some(state) = inbox.handle(&ev.data, now_ms()) {
                            sink(Out::State(state));
                        }
                    }
                }
                Some(Err(_)) | None => return Outcome::Retry { min: Duration::ZERO, detail: "connection lost" },
            },
            _ = kick.notified() => {
                if since_epoch(epoch).saturating_sub(last_byte.load(Ordering::Relaxed)) > STALE_FOR_KICK.as_millis() as u64 {
                    return Outcome::RetryNow;
                }
            }
            _ = tick.tick() => {
                if wake.woke() {
                    return Outcome::RetryNow;
                }
                if Instant::now() > deadline {
                    return Outcome::Retry { min: Duration::ZERO, detail: "connection timed out" };
                }
            }
        }
    }
}

/// Status JSON for the webview.
pub fn status_json(status: &str, detail: Option<&str>) -> Value {
    match detail {
        Some(d) => json!({"status": status, "detail": d}),
        None => json!({"status": status}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::{iso_from_ms, DEFAULT_MAILBOX};

    fn ntfy(id: &str, time_s: i64, message: &str) -> String {
        json!({"id": id, "time": time_s, "expires": time_s + 43200, "event": "message", "topic": "t", "message": message}).to_string()
    }

    fn plaintext(seq: u64, ts_ms: i64, session: &str) -> Vec<u8> {
        json!({"agent_id":"scout","agent_name":"Scout","session":session,"state":"working","event":"tool_start",
               "message":"Running tests","ts":iso_from_ms(ts_ms),"seq":seq})
        .to_string()
        .into_bytes()
    }

    #[test]
    fn inbox_accepts_valid_and_rejects_forged_replayed_stale_oversize() {
        let p = Pairing::generate(DEFAULT_MAILBOX).unwrap();
        let mut inbox = Inbox::new(p.clone());
        let now = 1_794_832_496_000;
        let ok = p.seal(&plaintext(1, now - 2000, "s")).unwrap();
        let ui = inbox.handle(&ntfy("abc123", now / 1000 - 1, &ok), now).expect("valid message");
        assert_eq!(ui["agent_id"], "scout");
        assert_eq!(ui["state"], "working");
        assert_eq!(ui["via"], "v2");
        assert_eq!(ui["received_at"], iso_from_ms(now - 1000), "received_at = ntfy time");
        assert_eq!(inbox.last_id.as_deref(), Some("abc123"));

        // Exact replay of the same ntfy message (e.g. catch-up after reconnect).
        assert!(inbox.handle(&ntfy("abc123", now / 1000, &ok), now).is_none());
        // Re-published copy under a new id: still a replay (seq).
        assert!(inbox.handle(&ntfy("zzz999", now / 1000, &ok), now).is_none());
        assert_eq!(inbox.stats.replayed, 2);

        // Forged with another key.
        let other = Pairing::generate(DEFAULT_MAILBOX).unwrap();
        let forged = other.seal(&plaintext(2, now, "s")).unwrap();
        assert!(inbox.handle(&ntfy("f1", now / 1000, &forged), now).is_none());
        assert_eq!(inbox.stats.bad_mac, 1);

        // Stale (catch-up of something older than 10 min).
        let stale = p.seal(&plaintext(3, now - 11 * 60_000, "s")).unwrap();
        assert!(inbox.handle(&ntfy("s1", now / 1000, &stale), now).is_none());
        assert_eq!(inbox.stats.replayed, 3);

        // Plain text, oversize, attachments, non-message events.
        assert!(inbox.handle(&ntfy("x1", now / 1000, "hello"), now).is_none());
        assert!(inbox.handle(&ntfy("x2", now / 1000, &"a".repeat(5000)), now).is_none());
        let mut att: Value = serde_json::from_str(&ntfy("x3", now / 1000, &ok)).unwrap();
        att["attachment"] = json!({"name": "attachment.txt"});
        assert!(inbox.handle(&att.to_string(), now).is_none());
        assert!(inbox.handle(r#"{"id":"k","time":1,"event":"keepalive","topic":"t"}"#, now).is_none());
        assert!(inbox.handle("not json", now).is_none());
        assert_eq!(inbox.stats.bad_envelope, 3);

        // Valid plaintext shape errors.
        let bad = p.seal(br#"{"agent_id":"BAD","session":"s","state":"idle","event":"e","ts":"2026-11-16T12:00:00Z","seq":1}"#).unwrap();
        assert!(inbox.handle(&ntfy("b1", now / 1000, &bad), now).is_none());
        assert_eq!(inbox.stats.bad_event, 1);

        // Newer seq is fine again; received_at never in the future.
        let next = p.seal(&plaintext(4, now, "s")).unwrap();
        let ui = inbox.handle(&ntfy("n1", now / 1000 + 100, &next), now).unwrap();
        assert_eq!(ui["received_at"], iso_from_ms(now));
        assert_eq!(inbox.stats.accepted, 2);
    }

    #[test]
    fn sse_url_shape() {
        let p = Pairing::decode(&Pairing::generate("http://127.0.0.1:9/ntfy").unwrap().encode()).unwrap();
        let u = sse_url(&p, "10m");
        assert!(u.starts_with("http://127.0.0.1:9/ntfy/"));
        assert!(u.ends_with("/sse?since=10m"));
        assert_eq!(u.len(), "http://127.0.0.1:9/ntfy/".len() + 22 + "/sse?since=10m".len());
    }

    /// Reconnect after a dropped stream resumes with since=<last message id>; the first
    /// connection asks for since=10m. Uses a tiny in-process SSE server.
    #[tokio::test(flavor = "multi_thread")]
    async fn reconnects_with_since_last_id() {
        use std::sync::Mutex;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let p = Pairing::generate("http://127.0.0.1:1").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let p = Pairing { base: format!("http://127.0.0.1:{port}"), ..p };
        let now = now_ms();
        let msg = |seq: u64, id: &str| {
            let pt = plaintext(seq, now, "s");
            format!("data: {}\n\n", ntfy(id, now / 1000, &p.seal(&pt).unwrap()))
        };
        let (m1, m2) = (msg(1, "first0000001"), msg(2, "second000002"));
        let paths: Arc<Mutex<Vec<String>>> = Arc::default();
        let paths2 = paths.clone();
        let server = tokio::spawn(async move {
            for body in [m1, m2] {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                paths2.lock().unwrap().push(req.lines().next().unwrap_or("").to_string());
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                let open = r#"event: open
data: {"id":"o","time":1,"event":"open","topic":"t"}

"#;
                sock.write_all(format!("{head}{open}{body}").as_bytes()).await.unwrap();
                sock.shutdown().await.ok(); // drop the stream: the client must reconnect
            }
        });
        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let g2 = got.clone();
        let sink: Sink = Arc::new(move |o| {
            if let Out::State(v) = o {
                g2.lock().unwrap().push(v);
            }
        });
        let client = reqwest::Client::new();
        let task = tokio::spawn(run(client, p.clone(), sink, Arc::new(Notify::new())));
        let deadline = Instant::now() + Duration::from_secs(10);
        while got.lock().unwrap().len() < 2 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        task.abort();
        server.abort();
        let paths = paths.lock().unwrap();
        assert_eq!(got.lock().unwrap().len(), 2);
        assert!(paths[0].contains(&format!("/{}/sse?since=10m ", p.topic_name())), "first connect");
        assert!(paths[1].contains("/sse?since=first0000001 "), "resume after the last id");
    }

    /// End to end with the real publisher script and a mailbox (local fake ntfy or ntfy.sh).
    /// Run via scripts/e2e-v2.sh, which sets DESKPET_E2E_MAILBOX (and starts the fake if local).
    /// Publishes N events with skill/deskpet-publish and expects to decrypt all of them here.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn e2e_publish_script_to_pet_client() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        use std::sync::Mutex;

        let mailbox = std::env::var("DESKPET_E2E_MAILBOX").expect("DESKPET_E2E_MAILBOX");
        let n: usize = std::env::var("DESKPET_E2E_EVENTS").ok().and_then(|s| s.parse().ok()).unwrap_or(5);
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../skill/deskpet-publish");
        let home = std::env::temp_dir().join(format!("deskpet-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);

        // Pet side: new pairing, start subscribing right away (as the app does).
        let pairing = Pairing::generate(&mailbox).unwrap();
        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let online = Arc::new(Notify::new());
        let (g2, o2) = (got.clone(), online.clone());
        let sink: Sink = Arc::new(move |o| match o {
            Out::State(v) => g2.lock().unwrap().push(v),
            Out::Status { status: "online", .. } => o2.notify_one(),
            Out::Status { .. } => {}
        });
        let kick = Arc::new(Notify::new());
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().unwrap();
        let task = tokio::spawn(run(client, pairing.clone(), sink, kick));
        tokio::time::timeout(Duration::from_secs(20), online.notified()).await.expect("pet client online");

        // Bot side: pair the script (code via stdin, never argv), then publish.
        let mut child = Command::new(script)
            .arg("pair")
            .env("DESK_PET_HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("run deskpet-publish");
        child.stdin.take().unwrap().write_all(pairing.encode().as_bytes()).unwrap();
        assert!(child.wait().unwrap().success(), "pair");
        let states = ["thinking", "working", "juggling", "needs_you", "done"];
        let t0 = Instant::now();
        for i in 0..n {
            let st = states[i % states.len()];
            let out = Command::new(script)
                .args(["e2e-bot", "E2E Bot", st, "e2e_step", &format!("step {}", i + 1), "--avatar", "star/blue"])
                .env("DESK_PET_HOME", &home)
                .env("DESK_PET_SESSION", "e2e-1")
                .env("DESK_PET_DEBUG", "1")
                .output()
                .unwrap();
            let err = String::from_utf8_lossy(&out.stderr);
            assert!(err.contains("sent"), "publish {i}: {err}");
        }
        let publish_ms = t0.elapsed().as_millis();
        let deadline = Instant::now() + Duration::from_secs(20);
        while got.lock().unwrap().len() < n && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        task.abort();
        let _ = std::fs::remove_dir_all(&home);
        let got = got.lock().unwrap();
        for (i, v) in got.iter().enumerate() {
            println!("e2e event {}: {} {} {} {:?} avatar={}", i + 1, v["agent_id"], v["state"], v["event"], v["message"], v["avatar"]);
        }
        println!("e2e: {} published in {publish_ms} ms, {} decrypted", n, got.len());
        assert_eq!(got.len(), n, "every published event decrypted");
        for (i, v) in got.iter().enumerate() {
            assert_eq!(v["state"], states[i % states.len()]);
            assert_eq!(v["message"], format!("step {}", i + 1));
            assert_eq!(v["avatar"], json!({"shape": "star", "color": "blue"}));
        }
    }
}
