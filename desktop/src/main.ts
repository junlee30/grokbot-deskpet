import { loadConfig, saveSettings, secrets, urlForAgent, safeUrl, type DeskPetConfig } from "./config.ts";
import { Pet } from "./pets.ts";
import { copyText, inTauri, openExternal, quitApp, startWindowDrag } from "./platform.ts";
import { pairStart, StreamClient, unpair, type ConnStatus, type StateEvent } from "./relay.ts";
import { SpriteBank } from "./sprites.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="stage" id="stage" data-tauri-drag-region></div>
  <div class="hint" id="hint" data-tauri-drag-region></div>
  <div class="status" id="status"></div>
  <button class="gear" id="gear" title="Settings" aria-label="Settings">&#9881;</button>

  <section class="card" id="pair-start" hidden>
    <canvas class="mini" id="mini" width="32" height="32"></canvas>
    <div class="col">
      <button class="primary" id="connect">Connect your Grok Bot</button>
      <div class="small" id="pair-error"></div>
    </div>
  </section>

  <section class="card" id="pair-code" hidden>
    <div class="col">
      <div class="small">Paste this to your Grok Bot:</div>
      <div class="paste" id="paste-line"></div>
      <div class="row">
        <button class="primary" id="copy">Copy</button>
        <span class="small" id="expires"></span>
        <button class="link" id="cancel-pair">Cancel</button>
      </div>
    </div>
  </section>

  <section class="card settings" id="settings" hidden>
    <label>Relay URL <input id="s-relay" spellcheck="false" /></label>
    <label>Click opens <input id="s-default" spellcheck="false" /></label>
    <label>Per-bot links <textarea id="s-agents" rows="2" spellcheck="false" placeholder="jarvis=https://grok.com"></textarea></label>
    <div class="row">
      <button class="primary" id="s-save">Save</button>
      <button id="s-unpair">Unpair</button>
      <button id="s-quit">Quit</button>
      <button class="link" id="s-close">Close</button>
    </div>
  </section>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>("stage");
const hint = $<HTMLDivElement>("hint");
const statusEl = $<HTMLDivElement>("status");

let cfg: DeskPetConfig;
const bank = new SpriteBank();
const pets = new Map<string, Pet>();
let stream: StreamClient | null = null;
let conn: ConnStatus = "connecting";
let view: "pair-start" | "pair-code" | "pets" = "pair-start";
let codeTimer: number | undefined;

function show(v: typeof view): void {
  view = v;
  $("pair-start").hidden = v !== "pair-start";
  $("pair-code").hidden = v !== "pair-code";
  stage.hidden = v !== "pets";
  hint.hidden = v !== "pets";
  app.dataset.view = v;
}

function setStatus(s: ConnStatus, detail?: string): void {
  conn = s;
  app.classList.toggle("offline", s === "offline");
  statusEl.textContent = s === "online" ? "" : s === "connecting" ? "connecting…" : `offline · ${detail ?? "retrying"}`;
}

// ---------- pairing ----------
async function beginPairing(): Promise<void> {
  const err = $("pair-error");
  err.textContent = "";
  const btn = $<HTMLButtonElement>("connect");
  btn.disabled = true;
  try {
    const p = await pairStart(cfg.relayUrl);
    secrets.setToken(p.token);
    secrets.setPending({ code: p.code, expires_at: p.expires_at });
    secrets.setPaired(false);
    showCode();
    connect();
  } catch {
    err.textContent = `Can't reach the relay at ${cfg.relayUrl}`;
  } finally {
    btn.disabled = false;
  }
}

function pasteLine(code: string): string {
  return `Install the Desk Pet skill and pair with code ${code}`;
}

function showCode(): void {
  const p = secrets.pending();
  if (!p) return;
  $("paste-line").textContent = pasteLine(p.code);
  show("pair-code");
  clearInterval(codeTimer);
  const tick = () => {
    const left = Date.parse(p.expires_at) - Date.now();
    if (left <= 0) {
      clearInterval(codeTimer);
      $("expires").textContent = "code expired";
      void resetPairing();
      $("pair-error").textContent = "That code expired. Get a new one.";
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $("expires").textContent = `expires in ${m}:${String(s).padStart(2, "0")}`;
  };
  tick();
  codeTimer = window.setInterval(tick, 1000);
}

function markPaired(): void {
  if (secrets.paired() && view === "pets") return;
  secrets.setPaired(true);
  secrets.setPending(null);
  clearInterval(codeTimer);
  show("pets");
}

async function resetPairing(revoke = true): Promise<void> {
  const t = secrets.token();
  stream?.stop();
  stream = null;
  if (t && revoke) await unpair(cfg.relayUrl, t);
  secrets.clear();
  for (const p of pets.values()) p.el.remove();
  pets.clear();
  clearInterval(codeTimer);
  show("pair-start");
  setStatus("online");
}

// ---------- stream ----------
function connect(): void {
  const token = secrets.token();
  if (!token) return;
  stream?.stop();
  stream = new StreamClient(cfg.relayUrl, token, {
    onStatus: setStatus,
    onState: (e) => handleState(e),
    onPaired: (e) => {
      markPaired();
      if (e.agent_name) hint.textContent = `Paired with ${e.agent_name}. Waiting for its first update…`;
    },
    onUnauthorized: () => {
      void resetPairing(false).then(() => {
        $("pair-error").textContent = "Pairing was revoked. Connect again.";
      });
    },
  });
  stream.start();
}

function handleState(e: StateEvent): void {
  markPaired();
  let pet = pets.get(e.agent_id);
  if (!pet) {
    pet = new Pet(e.agent_id, e.agent_name || e.agent_id, cfg);
    pets.set(e.agent_id, pet);
    stage.append(pet.el);
    wirePet(pet);
  }
  pet.update(e, Date.now(), cfg.toastMs);
}

// ---------- pet interaction: click opens a link, drag moves the window ----------
function wirePet(pet: Pet): void {
  let down: { x: number; y: number } | null = null;
  pet.el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    down = { x: ev.screenX, y: ev.screenY };
  });
  pet.el.addEventListener("pointermove", (ev) => {
    if (!down) return;
    if (Math.hypot(ev.screenX - down.x, ev.screenY - down.y) > 4) {
      down = null;
      void startWindowDrag();
    }
  });
  pet.el.addEventListener("pointerup", () => {
    if (!down) return;
    down = null;
    void openExternal(urlForAgent(cfg, pet.id));
  });
  pet.el.addEventListener("pointerleave", () => (down = null));
}

// Dragging on any non-interactive background moves the window.
app.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  const t = ev.target as HTMLElement;
  if (t.closest("button, input, textarea, a, label, .pet, .paste, .settings")) return;
  void startWindowDrag();
});

// ---------- settings ----------
function openSettings(): void {
  $<HTMLInputElement>("s-relay").value = cfg.relayUrl;
  $<HTMLInputElement>("s-default").value = cfg.openUrls.default;
  $<HTMLTextAreaElement>("s-agents").value = Object.entries(cfg.openUrls.agents)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  $<HTMLButtonElement>("s-unpair").disabled = !secrets.token();
  $("settings").hidden = false;
}

async function saveSettingsFromForm(): Promise<void> {
  const relay = $<HTMLInputElement>("s-relay").value.trim().replace(/\/+$/, "");
  const def = safeUrl($<HTMLInputElement>("s-default").value.trim()) ?? "https://grok.com";
  const agents: Record<string, string> = {};
  for (const line of $<HTMLTextAreaElement>("s-agents").value.split("\n")) {
    const m = /^\s*([a-z0-9_-]{1,64})\s*=\s*(\S+)\s*$/.exec(line);
    const u = m && safeUrl(m[2]);
    if (m && u) agents[m[1]] = u;
  }
  const relayChanged = safeUrl(relay) !== null && relay !== cfg.relayUrl;
  saveSettings({ relayUrl: safeUrl(relay) ? relay : cfg.relayUrl, openUrls: { default: def, agents } });
  const oldRelay = cfg.relayUrl;
  cfg = await loadConfig();
  $("settings").hidden = true;
  if (relayChanged) {
    // A token belongs to one relay: forget it (best-effort revoke at the old relay) and re-pair.
    const t = secrets.token();
    if (t) await unpair(oldRelay, t);
    await resetPairing(false);
  }
}

$("gear").addEventListener("click", () => ($("settings").hidden ? openSettings() : ($("settings").hidden = true)));
$("s-close").addEventListener("click", () => ($("settings").hidden = true));
$("s-save").addEventListener("click", () => void saveSettingsFromForm());
$("s-unpair").addEventListener("click", () => {
  $("settings").hidden = true;
  void resetPairing(true);
});
$("s-quit").addEventListener("click", () => void quitApp());
$("connect").addEventListener("click", () => void beginPairing());
$("cancel-pair").addEventListener("click", () => void resetPairing(true));
$("copy").addEventListener("click", async () => {
  const p = secrets.pending();
  if (!p) return;
  const ok = await copyText(pasteLine(p.code));
  $("copy").textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

// ---------- render loop ----------
function frame(): void {
  const now = Date.now();
  const offline = conn === "offline";
  const scale = pets.size > 3 ? 2 : bank.scale;
  for (const p of pets.values()) p.draw(bank, now, cfg, offline, scale);
  if (view === "pets") {
    if (pets.size > 0) hint.textContent = "";
    else if (!hint.textContent) hint.textContent = "Paired. Waiting for your Grok Bot…";
  }
  drawMini(now);
  requestAnimationFrame(frame);
}

function drawMini(now: number): void {
  if (view !== "pair-start") return;
  const c = $<HTMLCanvasElement>("mini");
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const def = bank.defs.idle;
  const sheet = bank.sheet("idle", "#2dd4bf");
  if (!def || !sheet) return;
  const f = Math.floor((now * def.fps) / 1000) % def.frames;
  ctx.clearRect(0, 0, 32, 32);
  ctx.drawImage(sheet, f * 32, 0, 32, 32, 0, 0, 32, 32);
}

// ---------- boot ----------
async function boot(): Promise<void> {
  app.classList.toggle("web", !inTauri);
  cfg = await loadConfig();
  try {
    await bank.load();
  } catch {
    statusEl.textContent = "sprites failed to load";
  }
  setStatus("online");
  if (!secrets.token()) show("pair-start");
  else if (!secrets.paired() && secrets.pending() && Date.parse(secrets.pending()!.expires_at) > Date.now()) {
    showCode();
    connect();
  } else if (!secrets.paired()) {
    await resetPairing(true);
  } else {
    show("pets");
    connect();
  }
  requestAnimationFrame(frame);
}

window.addEventListener("error", (e) => console.warn("deskpet error", e.message));
window.addEventListener("unhandledrejection", (e) => console.warn("deskpet rejection", String(e.reason)));
void boot();
