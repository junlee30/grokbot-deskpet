// Token, pairing-code and at-rest protection helpers.
//
// The relay never stores a raw token. It stores:
//   - HMAC-SHA-256(pepper, token) for every live token (lookup + constant-time compare)
//   - for a pending pairing code: the token encrypted with AES-256-GCM under a key
//     derived from (pepper, code). Only someone holding the code can recover the
//     token, and the ciphertext is deleted as soon as the code is redeemed or expires.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/** Unambiguous alphabet: no 0/O, 1/I/L, so codes survive being read aloud or retyped. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/;

/** 32 random bytes, base64url (43 chars). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newPairCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/** Normalise user-typed codes: case, whitespace, missing dash. Returns null if not a valid code. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  let s = input.toUpperCase().replace(/[\s_]/g, "");
  if (/^[A-Z0-9]{6}$/.test(s)) s = `${s.slice(0, 3)}-${s.slice(3)}`;
  return CODE_RE.test(s) ? s : null;
}

export function hmacHex(pepper: Buffer, value: string, domain: string): string {
  return createHmac("sha256", pepper).update(domain).update("\0").update(value).digest("hex");
}

export function hashToken(pepper: Buffer, token: string): string {
  return hmacHex(pepper, token, "deskpet-token-v1");
}

export function hashCode(pepper: Buffer, code: string): string {
  return hmacHex(pepper, code, "deskpet-code-v1");
}

/** Constant-time comparison of two hex digests. */
export function digestEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function codeKey(pepper: Buffer, code: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(code, "utf8"), pepper, "deskpet-pair-seal-v1", 32));
}

export interface Sealed {
  iv: string;
  ct: string;
  tag: string;
}

export function sealForCode(pepper: Buffer, code: string, token: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", codeKey(pepper, code), iv);
  const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function openForCode(pepper: Buffer, code: string, sealed: Sealed): string | null {
  try {
    const d = createDecipheriv("aes-256-gcm", codeKey(pepper, code), Buffer.from(sealed.iv, "base64"));
    d.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(sealed.ct, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Extract a bearer token from an Authorization header. Never log the result. */
export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,256})\s*$/.exec(header);
  return m ? m[1]! : null;
}
