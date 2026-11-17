// Pure networking helpers (no DOM): relay/mailbox URL validation and reconnect backoff.

/** A v1 relay you run yourself on this Mac (`scripts/dev.sh relay`). v1 is deprecated. */
export const LOCAL_RELAY = "http://127.0.0.1:8787";

/**
 * v1 relays that no longer exist. The hosted relay was shut down when v1 was deprecated: its
 * URL is refused, and a saved setting or Keychain token for it is dropped at startup.
 */
export const RETIRED_RELAY_HOSTS: readonly string[] = ["grokbot-deskpet-relay.fly.dev"];

export function isRetiredRelay(input: string): boolean {
  try {
    return RETIRED_RELAY_HOSTS.includes(new URL(input.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A (self-hosted, deprecated v1) relay base URL: https anywhere, plain http only for localhost. Just scheme://host[:port]
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
  if (RETIRED_RELAY_HOSTS.includes(u.hostname.toLowerCase())) {
    return { ok: false, error: "That hosted relay was shut down. Use v2 or your own relay" };
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

/** Default v2 mailbox (ntfy). */
export const DEFAULT_MAILBOX = "https://ntfy.sh";

/**
 * A v2 mailbox base URL (ntfy or a self-hosted ntfy): https anywhere, http only for localhost.
 * A path is allowed (ntfy behind a prefix); no credentials, query or fragment. Returned without
 * a trailing slash. The Rust side validates again before using it.
 */
export function validateMailboxUrl(input: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }
  if (u.username || u.password) return { ok: false, error: "No credentials in the URL" };
  if (u.search || u.hash) return { ok: false, error: "No query or fragment" };
  const ok = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!ok) return { ok: false, error: u.protocol === "http:" ? "https is required (http only for localhost)" : "Must be http(s)" };
  const url = (u.origin + u.pathname).replace(/\/+$/, "");
  return url.length > 200 ? { ok: false, error: "URL too long" } : { ok: true, url };
}
