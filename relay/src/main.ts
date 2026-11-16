import { ConfigError, loadConfig, type RelayConfig } from "./config.ts";
import { log } from "./log.ts";
import { createRelay, VERSION } from "./server.ts";
import { Store } from "./store.ts";

let config: RelayConfig;
try {
  config = loadConfig();
} catch (e) {
  // Fail closed with a clear message. ConfigError messages never contain secret values.
  const msg = e instanceof ConfigError ? e.message : "invalid configuration";
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "config", error: msg }) + "\n");
  process.exit(78); // EX_CONFIG
}

let store: Store;
try {
  store = Store.open(config.dbPath, config.now);
} catch (e) {
  log(config, "error", "database open failed", { error: (e as Error)?.name ?? "Error" });
  process.exit(1);
}

const relay = createRelay(config, store);
const port = await relay.listen();

log(config, "info", "listening", {
  version: VERSION,
  host: config.host,
  port,
  production: config.production,
  db: config.dbPath === ":memory:" ? "memory" : "file",
  pepper: config.pepperSource,
  cors_origins: config.corsOrigins.length,
  trust_proxy: config.trustProxy,
});
if (config.pepperSource === "ephemeral") {
  log(config, "warn", "random per-process pepper: tokens stop working after a restart (set DESKPET_PEPPER or use a DESKPET_DB file)");
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log(config, "info", "shutting down", { signal: sig });
    const hard = setTimeout(() => process.exit(1), 5000);
    hard.unref();
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
