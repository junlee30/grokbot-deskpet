import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Raised for bad configuration. Messages name the variable, never its value. */
export class ConfigError extends Error {}

export type PepperSource = "env" | "dev-file" | "ephemeral" | "override";
export type LogFn = (line: string) => void;

export interface RelayConfig {
  /** true when NODE_ENV=production or DESKPET_ENV=production. */
  production: boolean;
  host: string;
  port: number;
  /** Secret pepper for HMACs. */
  pepper: Buffer;
  pepperSource: PepperSource;
  /** Public base URL returned to bots from /v1/pair. Falls back to the request Host. */
  publicUrl: string | null;
  /** SQLite file, or ":memory:". */
  dbPath: string;
  maxBodyBytes: number;
  ratePerMin: number;
  rateBurst: number;
  /** Per client IP, shared by /v1/pair/start and /v1/pair. */
  pairRatePerMin: number;
  pairRateBurst: number;
  /** Global: this many failed code redemptions (any IP) inside the window locks /v1/pair. */
  pairGlobalFailMax: number;
  pairGlobalWindowMs: number;
  pairGlobalLockMs: number;
  /** Global cap on new pairings per minute (all IPs together). */
  pairStartGlobalPerMin: number;
  /** Trust the Fly-Client-IP header (only behind Fly's proxy). */
  trustProxy: boolean;
  pingMs: number;
  sweepMs: number;
  maxSubscribers: number;
  codeTtlMs: number;
  stateTtlMs: number;
  maxAgentsPerToken: number;
  maxSessionsPerAgent: number;
  /** Exact origins allowed for CORS. Empty = no CORS headers at all (production default). */
  corsOrigins: string[];
  log: boolean;
  logger: LogFn;
  now: () => number;
}

export const MIN_PROD_PEPPER = 32;
export const MIN_DEV_PEPPER = 16;

function int(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`invalid ${key}`);
  return n;
}

export function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.DESKPET_ENV === "production";
}

/**
 * Dev only: a persistent pepper in `<dir>/dev-pepper` (mode 0600, gitignored) so tokens keep
 * working across relay restarts. Created on first use.
 */
export function ensureDevPepper(dir: string): string {
  const file = join(dir, "dev-pepper");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const v = readFileSync(file, "utf8").trim();
    if (v.length >= MIN_DEV_PEPPER) {
      chmodSync(file, 0o600);
      return v;
    }
  } catch {
    /* create below */
  }
  const v = randomBytes(48).toString("base64url");
  writeFileSync(file, v + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return v;
}

function resolvePepper(env: NodeJS.ProcessEnv, production: boolean, dbPath: string): { pepper: Buffer; source: PepperSource } {
  const v = env.DESKPET_PEPPER;
  if (production) {
    // Fail closed. Never echo the value (or its length) in the message.
    if (!v || v.length < MIN_PROD_PEPPER) {
      throw new ConfigError(
        `DESKPET_PEPPER must be set to a secret of at least ${MIN_PROD_PEPPER} characters in production; refusing to start`,
      );
    }
    return { pepper: Buffer.from(v, "utf8"), source: "env" };
  }
  if (v !== undefined && v !== "") {
    if (v.length < MIN_DEV_PEPPER) throw new ConfigError(`DESKPET_PEPPER must be at least ${MIN_DEV_PEPPER} characters`);
    return { pepper: Buffer.from(v, "utf8"), source: "env" };
  }
  if (dbPath !== ":memory:") {
    return { pepper: Buffer.from(ensureDevPepper(dirname(dbPath)), "utf8"), source: "dev-file" };
  }
  return { pepper: randomBytes(32), source: "ephemeral" };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<RelayConfig> = {}): RelayConfig {
  const production = overrides.production ?? isProduction(env);
  const dbRaw = env.DESKPET_DB || (production ? "/data/deskpet.sqlite" : "./data/deskpet.sqlite");
  const dbPath = overrides.dbPath ?? (dbRaw === ":memory:" ? dbRaw : resolve(dbRaw));
  const { pepper, source } = overrides.pepper
    ? { pepper: overrides.pepper, source: "override" as const }
    : resolvePepper(env, production, dbPath);
  const corsOrigins = (env.DESKPET_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  for (const o of corsOrigins) {
    if (!/^(https?|tauri):\/\/[^/\s]+$/.test(o)) throw new ConfigError("invalid DESKPET_CORS_ORIGINS entry");
  }
  const publicUrl = (env.DESKPET_PUBLIC_URL || "").replace(/\/+$/, "") || null;
  if (publicUrl && !/^https?:\/\/[^/\s]+$/.test(publicUrl)) throw new ConfigError("invalid DESKPET_PUBLIC_URL");
  const cfg: RelayConfig = {
    production,
    host: env.HOST ?? "127.0.0.1",
    port: int(env, "PORT", 8787),
    pepper,
    pepperSource: source,
    publicUrl,
    dbPath,
    maxBodyBytes: int(env, "DESKPET_MAX_BODY", 4096),
    ratePerMin: int(env, "DESKPET_RATE_PER_MIN", 60),
    rateBurst: int(env, "DESKPET_RATE_BURST", 20),
    pairRatePerMin: int(env, "DESKPET_PAIR_RATE_PER_MIN", 10),
    pairRateBurst: int(env, "DESKPET_PAIR_RATE_BURST", 10),
    pairGlobalFailMax: int(env, "DESKPET_PAIR_GLOBAL_FAIL_MAX", 30),
    pairGlobalWindowMs: int(env, "DESKPET_PAIR_GLOBAL_WINDOW_MS", 60_000),
    pairGlobalLockMs: int(env, "DESKPET_PAIR_GLOBAL_LOCK_MS", 60_000),
    pairStartGlobalPerMin: int(env, "DESKPET_PAIR_START_GLOBAL_PER_MIN", 120),
    trustProxy: env.DESKPET_TRUST_PROXY === "1",
    pingMs: int(env, "DESKPET_PING_MS", 15_000),
    sweepMs: int(env, "DESKPET_SWEEP_MS", 60_000),
    maxSubscribers: int(env, "DESKPET_MAX_SUBSCRIBERS", 3),
    codeTtlMs: int(env, "DESKPET_CODE_TTL_MS", 15 * 60_000),
    stateTtlMs: int(env, "DESKPET_STATE_TTL_MS", 24 * 3_600_000),
    maxAgentsPerToken: 32,
    maxSessionsPerAgent: 16,
    corsOrigins,
    log: env.DESKPET_LOG !== "0",
    logger: (line) => process.stdout.write(line + "\n"),
    now: Date.now,
  };
  return { ...cfg, ...overrides, pepperSource: overrides.pepper ? "override" : source };
}
