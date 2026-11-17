// Pure networking helpers (no DOM): mailbox URL validation.

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
