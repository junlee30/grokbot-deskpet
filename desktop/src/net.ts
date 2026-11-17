// Pure networking helpers (no DOM): mailbox URL validation.
import { strings, type Strings } from "./i18n.ts";

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Default v2 mailbox (ntfy). */
export const DEFAULT_MAILBOX = "https://ntfy.sh";

/**
 * A v2 mailbox base URL (ntfy or a self-hosted ntfy): https anywhere, http only for localhost.
 * A path is allowed (ntfy behind a prefix); no credentials, query or fragment. Returned without
 * a trailing slash. The Rust side validates again before using it.
 */
export function validateMailboxUrl(input: string, t: Strings = strings("en")): UrlCheck {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: t.urlInvalid };
  }
  if (u.username || u.password) return { ok: false, error: t.urlCredentials };
  if (u.search || u.hash) return { ok: false, error: t.urlQuery };
  const ok = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!ok) return { ok: false, error: u.protocol === "http:" ? t.urlHttps : t.urlScheme };
  const url = (u.origin + u.pathname).replace(/\/+$/, "");
  return url.length > 200 ? { ok: false, error: t.urlTooLong } : { ok: true, url };
}
