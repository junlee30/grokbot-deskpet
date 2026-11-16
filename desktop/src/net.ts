// Pure networking helpers (no DOM): relay URL validation and reconnect backoff.

export const LOCAL_RELAY = "http://127.0.0.1:8787";
export const HOSTED_RELAY = "https://grokbot-deskpet-relay.fly.dev";

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A relay base URL: https anywhere, plain http only for localhost. Just scheme://host[:port]
 * (a trailing slash is fine), no credentials, path, query or fragment. Returns it without the
 * trailing slash. The Rust side validates again before using it.
 */
export function validateRelayUrl(input: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }
  if (u.username || u.password) return { ok: false, error: "No credentials in the URL" };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    return { ok: false, error: "Use just https://host[:port]" };
  }
  if (u.protocol === "https:") return { ok: true, url: u.origin };
  if (u.protocol === "http:") {
    return LOOPBACK.has(u.hostname) ? { ok: true, url: u.origin } : { ok: false, error: "https is required (http only for localhost)" };
  }
  return { ok: false, error: "Must be http(s)" };
}

/** Exponential backoff with jitter: base = min(30s, 1s * 2^attempt), delay in [base/2, base]. */
export function backoffDelay(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(Math.max(0, attempt), 5));
  const j = Math.min(1, Math.max(0, rand));
  return Math.round(base / 2 + j * (base / 2));
}
