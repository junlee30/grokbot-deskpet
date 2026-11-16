import { loadConfig, pairingState, saveSettings, safeUrl, takeLegacyToken, urlForAgent, type DeskPetConfig } from "./config.ts";
import { layoutPets, orderPets, type PetSize } from "./layout.ts";
import { HOSTED_RELAY, LOCAL_RELAY, validateRelayUrl } from "./net.ts";
import { Pet } from "./pets.ts";
import { copyText, inTauri, openExternal, quitApp, startWindowDrag } from "./platform.ts";
import type { ConnStatus, ReadyEvent, StateEvent, StreamHandlers } from "./relay.ts";
import { SpriteBank } from "./sprites.ts";
import { TauriTransport, WebTransport, type RelayTransport } from "./transport.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="stage" id="stage" data-tauri-drag-region></div>
  <div class="hint" id="hint" data-tauri-drag-region></div>
  <div class="status" id="status"></div>
  <div class="more" id="more" hidden></div>
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
    <label>Relay URL <input id="s-relay" spellcheck="false" autocomplete="off" /></label>
    <div class="presets">
      <button type="button" class="chip" id="s-local">Local</button>
      <button type="button" class="chip" id="s-hosted" title="${HOSTED_RELAY}">Hosted (not deployed yet)</button>
      <span class="small" id="s-relay-note">Changing relay means pairing again.</span>
    </div>
    <label>Click opens <input id="s-default" spellcheck="false" /></label>
    <label>Per-bot links <textarea id="s-agents" rows="1" spellcheck="false" placeholder="jarvis=https://grok.com"></textarea></label>
    <label>Pet size <select id="s-size"><option value="large">Large</option><option value="small">Small</option></select></label>
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
let transport: RelayTransport;
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

function makeTransport(relayUrl: string, legacyToken: string | null = null): RelayTransport {
  return inTauri ? new TauriTransport(relayUrl) : new WebTransport(relayUrl, legacyToken);
}

// ---------- pairing ----------
async function beginPairing(): Promise<void> {
  const err = $("pair-error");
  err.textContent = "";
  const btn = $<HTMLButtonElement>("connect");
  btn.disabled = true;
  try {
    const p = await transport.pairStart(); // the token goes to the keychain, never to us
    pairingState.setPending({ code: p.code, expires_at: p.expires_at });
    pairingState.setPaired(false);
    showCode();
    void connect();
  } catch {
    err.textContent = `Can't reach the relay at ${cfg.relayUrl}`;
  } finally {
    btn.disabled = false;
  }
}

/** The bot defaults to the hosted relay; any other relay is named in the line. */
function pasteLine(code: string): string {
  const via = cfg.relayUrl === HOSTED_RELAY ? "" : ` using relay ${cfg.relayUrl}`;
  return `Install the Desk Pet skill and pair with code ${code}${via}`;
}

function pendingValid(): { code: string; expires_at: string } | null {
  const p = pairingState.pending();
  return p && Date.parse(p.expires_at) > Date.now() ? p : null;
}

function showCode(): void {
  const p = pairingState.pending();
  if (!p) return;
  $("paste-line").textContent = pasteLine(p.code);
  show("pair-code");
  clearInterval(codeTimer);
  const tick = () => {
    const left = Date.parse(p.expires_at) - Date.now();
    if (left <= 0) {
      clearInterval(codeTimer);
      $("expires").textContent = "code expired";
      void resetPairing(true).then(() => ($("pair-error").textContent = "That code expired. Get a new one."));
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
  if (pairingState.paired() && view === "pets") return;
  pairingState.setPaired(true);
  pairingState.setPending(null);
  clearInterval(codeTimer);
  show("pets");
}

async function resetPairing(revoke = true): Promise<void> {
  transport.stop();
  if (revoke) await transport.unpair();
  else await transport.forget();
  pairingState.clear();
  for (const p of pets.values()) p.remove();
  pets.clear();
  relayout();
  clearInterval(codeTimer);
  show("pair-start");
  setStatus("online");
}

// ---------- stream ----------
const handlers: StreamHandlers = {
  onStatus: setStatus,
  onState: (e) => handleState(e),
  onPaired: (e) => {
    markPaired();
    if (e.agent_name) hint.textContent = `Paired with ${e.agent_name}. Waiting for its first update…`;
  },
  onReady: (e: ReadyEvent) => {
    if (e.paired) markPaired();
    else if (view !== "pair-code") {
      // A token that was never redeemed: resume showing its code, or start over.
      if (pendingValid()) showCode();
      else void resetPairing(true);
    }
  },
  onUnauthorized: () => {
    void resetPairing(false).then(() => {
      $("pair-error").textContent = "This pairing is no longer valid. Connect again.";
    });
  },
};

async function connect(): Promise<void> {
  await transport.start(handlers);
}

function handleState(e: StateEvent): void {
  markPaired();
  let pet = pets.get(e.agent_id);
  if (!pet) {
    pet = new Pet(e.agent_id, e.agent_name || e.agent_id, cfg);
    pets.set(e.agent_id, pet);
    stage.append(pet.el);
    stage.append(pet.bubble);
    wirePet(pet);
    if (!cfg.petOrder.includes(e.agent_id)) {
      cfg.petOrder = [...cfg.petOrder, e.agent_id].slice(-64);
      saveSettings({ petOrder: cfg.petOrder });
    }
    relayout();
  }
  pet.update(e, Date.now(), cfg.toastMs);
}

/** Columns per pet (pure layout in layout.ts); pets that don't fit are summarised as "+N". */
function relayout(): void {
  const ids = orderPets([...pets.keys()], cfg.petOrder);
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  const slots = layoutPets(ids.length, w, h, cfg.petSize);
  ids.forEach((id, i) => pets.get(id)!.place(slots[i] ?? null));
  const hidden = ids.length - slots.length;
  const more = $("more");
  more.hidden = hidden <= 0;
  more.textContent = hidden > 0 ? `+${hidden} more` : "";
}
window.addEventListener("resize", relayout);

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
async function openSettings(): Promise<void> {
  $<HTMLInputElement>("s-relay").value = cfg.relayUrl;
  $<HTMLInputElement>("s-default").value = cfg.openUrls.default;
  $<HTMLTextAreaElement>("s-agents").value = Object.entries(cfg.openUrls.agents)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  $<HTMLSelectElement>("s-size").value = cfg.petSize;
  $("s-relay-note").textContent = "Changing relay means pairing again.";
  $("s-relay-note").classList.remove("error");
  $<HTMLButtonElement>("s-unpair").disabled = !(await transport.hasToken().catch(() => false));
  $("settings").hidden = false;
}

async function saveSettingsFromForm(): Promise<void> {
  const note = $("s-relay-note");
  const check = validateRelayUrl($<HTMLInputElement>("s-relay").value);
  if (!check.ok) {
    note.textContent = check.error;
    note.classList.add("error");
    return;
  }
  const def = safeUrl($<HTMLInputElement>("s-default").value.trim()) ?? "https://grok.com";
  const agents: Record<string, string> = {};
  for (const line of $<HTMLTextAreaElement>("s-agents").value.split("\n")) {
    const m = /^\s*([a-z0-9_-]{1,64})\s*=\s*(\S+)\s*$/.exec(line);
    const u = m && safeUrl(m[2]);
    if (m && u) agents[m[1]] = u;
  }
  const size = $<HTMLSelectElement>("s-size").value as PetSize;
  const relayChanged = check.url !== cfg.relayUrl;
  const oldTransport = transport;
  saveSettings({ relayUrl: check.url, openUrls: { default: def, agents }, petSize: size === "small" ? "small" : "large" });
  cfg = await loadConfig();
  $("settings").hidden = true;
  relayout();
  if (relayChanged) {
    // A token belongs to one relay: revoke + forget it there (best effort), then pair again.
    oldTransport.stop();
    await oldTransport.unpair();
    transport = makeTransport(cfg.relayUrl);
    await resetPairing(false);
  }
}

$("gear").addEventListener("click", () => ($("settings").hidden ? void openSettings() : ($("settings").hidden = true)));
$("s-close").addEventListener("click", () => ($("settings").hidden = true));
$("s-save").addEventListener("click", () => void saveSettingsFromForm());
$("s-local").addEventListener("click", () => ($<HTMLInputElement>("s-relay").value = LOCAL_RELAY));
$("s-hosted").addEventListener("click", () => ($<HTMLInputElement>("s-relay").value = HOSTED_RELAY));
$("s-unpair").addEventListener("click", () => {
  $("settings").hidden = true;
  void resetPairing(true);
});
$("s-quit").addEventListener("click", () => void quitApp());
$("connect").addEventListener("click", () => void beginPairing());
$("cancel-pair").addEventListener("click", () => void resetPairing(true));
$("copy").addEventListener("click", async () => {
  const p = pairingState.pending();
  if (!p) return;
  const ok = await copyText(pasteLine(p.code));
  $("copy").textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

// Network back or window visible again (e.g. after sleep): reconnect now instead of waiting
// out the backoff. The Rust client also detects wake-from-sleep on its own.
window.addEventListener("online", () => transport?.reconnectNow());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") transport?.reconnectNow();
});

// ---------- render loop ----------
function frame(): void {
  const now = Date.now();
  const offline = conn === "offline";
  for (const p of pets.values()) p.draw(bank, now, cfg, offline);
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
  // M0 kept the token in localStorage. Move it into the keychain once, and delete it here either
  // way. (If the old relay kept tokens in memory only, it is dead: the 401 sends us to pairing.)
  const legacy = takeLegacyToken();
  transport = makeTransport(cfg.relayUrl, legacy);
  if (legacy && transport instanceof TauriTransport) await transport.importToken(legacy).catch(() => {});
  try {
    await bank.load();
  } catch {
    statusEl.textContent = "sprites failed to load";
  }
  setStatus("online");
  if (!(await transport.hasToken().catch(() => false))) {
    pairingState.clear();
    show("pair-start");
  } else {
    // Paired (or mid-pairing): connect; the relay's "ready" event settles which view is right.
    if (!pairingState.paired() && pendingValid()) showCode();
    else show("pets");
    void connect();
  }
  relayout();
  requestAnimationFrame(frame);
}

window.addEventListener("error", (e) => console.warn("deskpet error", e.message));
window.addEventListener("unhandledrejection", (e) => console.warn("deskpet rejection", String(e.reason)));
void boot();
