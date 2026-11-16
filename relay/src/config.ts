import { randomBytes } from "node:crypto";

export interface RelayConfig {
  host: string;
  port: number;
  /** Secret pepper for HMACs. Random per process when DESKPET_PEPPER is unset (dev). */
  pepper: Buffer;
  /** True when the pepper was generated (tokens won't survive a restart). */
  ephemeralPepper: boolean;
  /** Public base URL returned to bots from /v1/pair. Falls back to the request Host. */
  publicUrl: string | null;
  /** Optional SQLite file for token hashes (dev convenience). */
  dbPath: string | null;
  maxBodyBytes: number;
  ratePerMin: number;
  rateBurst: number;
  pairRatePerMin: number;
  pairRateBurst: number;
  pingMs: number;
  maxSubscribers: number;
  codeTtlMs: number;
  stateTtlMs: number;
  maxAgentsPerToken: number;
  maxSessionsPerAgent: number;
  corsOrigins: string[];
  log: boolean;
  now: () => number;
}

export const DEFAULT_CORS_ORIGINS = [
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

function int(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${key}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<RelayConfig> = {}): RelayConfig {
  const pepperEnv = env.DESKPET_PEPPER;
  if (pepperEnv !== undefined && pepperEnv.length < 16) {
    throw new Error("DESKPET_PEPPER must be at least 16 characters");
  }
  const extraOrigins = (env.DESKPET_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cfg: RelayConfig = {
    host: env.HOST ?? "127.0.0.1",
    port: int(env, "PORT", 8787),
    pepper: pepperEnv ? Buffer.from(pepperEnv, "utf8") : randomBytes(32),
    ephemeralPepper: !pepperEnv,
    publicUrl: env.DESKPET_PUBLIC_URL || null,
    dbPath: env.DESKPET_DB || null,
    maxBodyBytes: int(env, "DESKPET_MAX_BODY", 4096),
    ratePerMin: int(env, "DESKPET_RATE_PER_MIN", 60),
    rateBurst: int(env, "DESKPET_RATE_BURST", 20),
    pairRatePerMin: int(env, "DESKPET_PAIR_RATE_PER_MIN", 10),
    pairRateBurst: int(env, "DESKPET_PAIR_RATE_BURST", 10),
    pingMs: int(env, "DESKPET_PING_MS", 15_000),
    maxSubscribers: int(env, "DESKPET_MAX_SUBSCRIBERS", 3),
    codeTtlMs: int(env, "DESKPET_CODE_TTL_MS", 15 * 60_000),
    stateTtlMs: int(env, "DESKPET_STATE_TTL_MS", 24 * 3_600_000),
    maxAgentsPerToken: 32,
    maxSessionsPerAgent: 16,
    corsOrigins: [...DEFAULT_CORS_ORIGINS, ...extraOrigins],
    log: env.DESKPET_LOG !== "0",
    now: Date.now,
  };
  return { ...cfg, ...overrides };
}
