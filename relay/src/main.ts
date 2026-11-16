import { loadConfig } from "./config.ts";
import { createRelay } from "./server.ts";
import { openSqlite } from "./store.ts";

const config = loadConfig();
const persistence = config.dbPath ? await openSqlite(config.dbPath) : null;
const relay = createRelay(config, persistence);
const port = await relay.listen();

console.log(`deskpet relay listening on http://${config.host}:${port}`);
if (config.ephemeralPepper) {
  console.log("DESKPET_PEPPER not set: using a random per-process pepper (tokens are invalid after restart).");
}
if (persistence) console.log("token hashes persisted to DESKPET_DB");

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: shutting down`);
    relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
