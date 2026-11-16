// Structured JSON logs, one line per entry. Callers pass only whitelisted, non-secret fields:
// never headers, tokens, pairing codes, query strings or bodies.
import { hmacHex } from "./crypto.ts";
import type { RelayConfig } from "./config.ts";

export type Level = "info" | "warn" | "error";

export function log(cfg: Pick<RelayConfig, "logger" | "now">, level: Level, msg: string, fields: Record<string, string | number | boolean | null> = {}): void {
  cfg.logger(JSON.stringify({ ts: new Date(cfg.now()).toISOString(), level, msg, ...fields }));
}

/** Short keyed hash of a client IP: lets you correlate requests without logging the address. */
export function ipTag(pepper: Buffer, ip: string): string {
  return hmacHex(pepper, ip, "deskpet-ip-v1").slice(0, 12);
}
