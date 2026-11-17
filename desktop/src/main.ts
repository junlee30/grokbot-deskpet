import { loadConfig, pairingState, saveSettings, safeUrl, takeLegacyToken, urlForAgent, v2State, type DeskPetConfig } from "./config.ts";
import { bootView, combineStatus, pasteLineV2, type Conn } from "./connections.ts";
import { layoutPets, orderPets, type PetSize } from "./layout.ts";
import { DEFAULT_MAILBOX, HOSTED_RELAY, LOCAL_RELAY, validateMailboxUrl, validateRelayUrl } from "./net.ts";
import { Pet } from "./pets.ts";
import { copyText, inTauri, openExternal, quitApp, startWindowDrag } from "./platform.ts";
import type { ConnStatus, ReadyEvent, StateEvent, StreamHandlers } from "./relay.ts";
import { SpriteBank } from "./sprites.ts";
import { AvatarBank } from "./avatar-bank.ts";
import { NoMailbox, TauriMailbox, TauriTransport, WebTransport, type Mailbox, type MailboxHandlers, type RelayTransport } from "./transport.ts";

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
      <div class="small" id="pair-mode"></div>
      <div class="small" id="pair-error"></div>
    </div>
  </section>

  <section class="card" id="pair-code" hidden>
    <div class="col">
      <div class="small">Paste this to your Grok Bot:</div>
      <div class="paste" id="paste-line"></div>
      <div class="small" id="pair-note"></div>
      <div class="row">
        <button class="primary" id="copy">Copy</button>
        <span class="small" id="expires"></span>
        <button class="link" id="done-pair" hidden>Done</button>
        <button class="link" id="cancel-pair">Cancel</button>
      </div>
    </div>
  </section>

  <section class="card settings" id="settings" hidden>
    <label>Connect with <select id="s-mode">
      <option value="v2">Private mailbox (v2, no server)</option>
      <option value="v1">Relay (v1)</option>
    </select></label>
    <div class="conn-row"><span class="small" id="s-v2-state"></span>
      <button type="button" class="chip" id="s-v2-code">Show code</button>
      <button type="button" class="chip" id="s-v2-new">New code</button>
      <button type="button" class="chip" id="s-v2-unpair">Unpair</button>
    </div>
    <label>Mailbox URL <input id="s-mailbox" spellcheck="false" autocomplete="off" /></label>
    <div class="presets">
      <button type="button" class="chip" id="s-ntfy" title="${DEFAULT_MAILBOX}">ntfy.sh</button>
      <span class="small" id="s-mailbox-note">Used for the next new code.</span>
    </div>
    <div class="conn-row"><span class="small" id="s-v1-state"></span>
      <button type="button" class="chip" id="s-v1-pair">Pair</button>
      <button type="button" class="chip" id="s-unpair">Unpair</button>
    </div>
    <label>Relay URL <input id="s-relay" spellcheck="false" autocomplete="off" /></label>
    <div class="presets">
      <button type="button" class="chip" id="s-local">Local</button>
      <button type="button" class="chip" id="s-hosted" title="${HOSTED_RELAY}">Hosted</button>
      <span class="small" id="s-relay-note">Changing relay means pairing again.</span>
    </div>
    <label>Click opens <input id="s-default" spellcheck="false" /></label>
    <label>Per-bot links <textarea id="s-agents" rows="1" spellcheck="false" placeholder="jarvis=https://grok.com"></textarea></label>
    <label>Pet size <select id="s-size"><option value="large">Large</option><option value="small">Small</option></select></label>
    <div class="row">
      <button class="primary" id="s-save">Save</button>
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
const art = new AvatarBank(); // Grok Bot avatar art, if it was imported at build time
const pets = new Map<string, Pet>();
let transport: RelayTransport; // v1 relay (always exists: it knows the relay URL)
let v1Active = false; // a v1 token is in the keychain and we stream from the relay
let mailbox: Mailbox; // v2 private mailbox
let v2Active = false; // a v2 pairing is in the keychain and we subscribe to its topic
let connV1: Conn | null = null;
let connV2: Conn | null = null;
let conn: ConnStatus = "connecting";
let view: "pair-start" | "pair-code" | "pets" = "pair-start";
let codeTimer: number | undefined;
/** What the pair-code card shows. A shown v2 code is kept in memory only while visible. */
let codeKind: "v1" | "v2" | null = null;
let shownV2Code: string | null = null;
let shownV2IsNew = false;
/** Which connection(s) each pet came from, so unpairing one removes only its pets. */
const petSources = new Map<string, Set<"v1" | "v2">>();

function show(v: typeof view): void {
  view = v;
  if (v !== "pair-code") {
    codeKind = null;
    shownV2Code = null; // the dp2 code is not kept around once the card is gone
    $("paste-line").textContent = "";
  }
  $("pair-start").hidden = v !== "pair-start";
  $("pair-code").hidden = v !== "pair-code";
  stage.hidden = v !== "pets";
  hint.hidden = v !== "pets";
  app.dataset.view = v;
}

function renderStatus(): void {
  const c = combineStatus(v1Active ? connV1 : null, v2Active ? connV2 : null);
  conn = c.status;
  app.classList.toggle("offline", c.status === "offline");
  statusEl.textContent = c.text;
}

function setStatus(s: ConnStatus, detail?: string): void {
  connV1 = { status: s, detail };
  renderStatus();
}

function setV2Status(s: ConnStatus, detail?: string): void {
  connV2 = { status: s, detail };
  renderStatus();
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function showPairMode(): void {
  $("pair-mode").textContent =
    cfg.pairMode === "v2" && mailbox.supported
      ? `Private, end-to-end encrypted · via ${hostOf(cfg.mailboxUrl)}`
      : `Via relay ${hostOf(cfg.relayUrl)}`;
}

function makeTransport(relayUrl: string, legacyToken: string | null = null): RelayTransport {
  return inTauri ? new TauriTransport(relayUrl) : new WebTransport(relayUrl, legacyToken);
}

// ---------- pairing ----------
/** "Connect your Grok Bot": a v2 private-mailbox code by default, or a v1 relay code. */
function beginPairing(): Promise<void> {
  return cfg.pairMode === "v2" && mailbox.supported ? beginV2() : beginV1();
}

async function beginV1(): Promise<void> {
  const err = $("pair-error");
  err.textContent = "";
  const btn = $<HTMLButtonElement>("connect");
  btn.disabled = true;
  try {
    const p = await transport.pairStart(); // the token goes to the keychain, never to us
    pairingState.setPending({ code: p.code, expires_at: p.expires_at });
    pairingState.setPaired(false);
    v1Active = true;
    showCode();
    void connect();
  } catch {
    err.textContent = `Can't reach the relay at ${cfg.relayUrl}`;
    if (view !== "pair-start") show("pair-start");
  } finally {
    btn.disabled = false;
  }
}

/** New v2 pairing: fresh topic + key in the keychain, subscribed at once, code shown. */
async function beginV2(): Promise<void> {
  const err = $("pair-error");
  err.textContent = "";
  const btn = $<HTMLButtonElement>("connect");
  btn.disabled = true;
  try {
    const code = await mailbox.pairNew(cfg.mailboxUrl, mailboxHandlers);
    if (v2Active) dropSourcePets("v2"); // bots on the old code can't be heard any more
    v2Active = true;
    v2State.setSeen(false);
    connV2 = { status: "connecting" };
    renderStatus();
    showCodeV2(code, true);
  } catch (e) {
    err.textContent = `Couldn't create a code: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    if (view !== "pair-start") show("pair-start");
  } finally {
    btn.disabled = false;
  }
}

function showCodeV2(code: string, isNew: boolean): void {
  clearInterval(codeTimer);
  shownV2Code = code;
  shownV2IsNew = isNew;
  $("paste-line").textContent = pasteLineV2(code);
  $("pair-note").textContent = "This code is the key to your pet: share it only with your bots. Works on any number of bots.";
  $("expires").textContent = "";
  $("done-pair").hidden = false;
  $("cancel-pair").textContent = isNew ? "Cancel" : "Close";
  show("pair-code");
  codeKind = "v2";
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
  $("pair-note").textContent = "";
  $("done-pair").hidden = true;
  $("cancel-pair").textContent = "Cancel";
  show("pair-code");
  codeKind = "v1";
  clearInterval(codeTimer);
  const tick = () => {
    const left = Date.parse(p.expires_at) - Date.now();
    if (left <= 0) {
      clearInterval(codeTimer);
      $("expires").textContent = "code expired";
      void dropV1(true).then(() => ($("pair-error").textContent = "That code expired. Get a new one."));
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $("expires").textContent = `expires in ${m}:${String(s).padStart(2, "0")}`;
  };
  tick();
  codeTimer = window.setInterval(tick, 1000);
}

/** v1: the relay says a bot redeemed our code (or sent a state). */
function markPaired(): void {
  if (pairingState.paired() && view === "pets") return;
  pairingState.setPaired(true);
  pairingState.setPending(null);
  if (codeKind === "v1") clearInterval(codeTimer);
  if (view === "pair-start" || codeKind === "v1") show("pets");
}

/** v2: the first valid encrypted event on this pairing. */
function markSeenV2(): void {
  if (!v2State.seen()) v2State.setSeen(true);
  if (view === "pair-start" || (codeKind === "v2" && shownV2IsNew)) show("pets");
}

function dropSourcePets(src: "v1" | "v2"): void {
  for (const [id, set] of petSources) {
    set.delete(src);
    if (set.size === 0) {
      pets.get(id)?.remove();
      pets.delete(id);
      petSources.delete(id);
    }
  }
  relayout();
}

/** After a connection is dropped: back to Connect if none is left. */
function afterDrop(): void {
  if (!v1Active && !v2Active) {
    for (const p of pets.values()) p.remove();
    pets.clear();
    petSources.clear();
    relayout();
    show("pair-start");
  } else if (view === "pair-code" && codeKind === null) {
    show("pets");
  }
  renderStatus();
}

/** Stop v1, revoke at the relay (best effort) or just forget the token, keep v2 running. */
async function dropV1(revoke = true): Promise<void> {
  transport.stop();
  if (revoke) await transport.unpair();
  else await transport.forget();
  pairingState.clear();
  v1Active = false;
  connV1 = null;
  if (codeKind === "v1") {
    clearInterval(codeTimer);
    show(v2Active ? "pets" : "pair-start");
  }
  dropSourcePets("v1");
  afterDrop();
}

/** Stop v2 and delete its topic + key; keep v1 running. */
async function dropV2(): Promise<void> {
  await mailbox.unpair();
  v2State.setSeen(false);
  v2Active = false;
  connV2 = null;
  if (codeKind === "v2") show(v1Active ? "pets" : "pair-start");
  dropSourcePets("v2");
  afterDrop();
}

// ---------- stream ----------
const handlers: StreamHandlers = {
  onStatus: setStatus,
  onState: (e) => {
    markPaired();
    handleState(e, "v1");
  },
  onPaired: (e) => {
    markPaired();
    if (e.agent_name) hint.textContent = `Paired with ${e.agent_name}. Waiting for its first update…`;
  },
  onReady: (e: ReadyEvent) => {
    if (e.paired) markPaired();
    else if (codeKind !== "v1") {
      // A token that was never redeemed: resume showing its code (unless the v2 code card is
      // up), or start over.
      if (pendingValid()) {
        if (view !== "pair-code") showCode();
      } else void dropV1(true);
    }
  },
  onUnauthorized: () => {
    void dropV1(false).then(() => {
      $("pair-error").textContent = "This pairing is no longer valid. Connect again.";
    });
  },
};

const mailboxHandlers: MailboxHandlers = {
  onStatus: setV2Status,
  onState: (e) => {
    markSeenV2();
    handleState(e, "v2");
  },
};

async function connect(): Promise<void> {
  await transport.start(handlers);
}

function handleState(e: StateEvent, src: "v1" | "v2"): void {
  const set = petSources.get(e.agent_id) ?? new Set();
  set.add(src);
  petSources.set(e.agent_id, set);
  let pet = pets.get(e.agent_id);
  if (!pet) {
    pet = new Pet(e.agent_id, e.agent_name || e.agent_id, cfg, art);
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
let confirmNewTimer: number | undefined;

async function refreshConnRows(): Promise<void> {
  const v2 = mailbox.supported ? await mailbox.status().catch(() => ({ paired: false, mailbox: null })) : null;
  $("s-v2-state").textContent = !v2
    ? "v2: needs the desktop app"
    : v2.paired
      ? `v2: paired${v2.mailbox ? ` · ${v2.mailbox}` : ""}${v2State.seen() ? "" : " · no bot yet"}`
      : "v2: not paired";
  $<HTMLButtonElement>("s-v2-code").disabled = !v2?.paired;
  $<HTMLButtonElement>("s-v2-unpair").disabled = !v2?.paired;
  $<HTMLButtonElement>("s-v2-new").disabled = !v2;
  $("s-v2-new").textContent = v2?.paired ? "New code" : "Pair";
  const v1 = await transport.hasToken().catch(() => false);
  $("s-v1-state").textContent = v1 ? `v1: paired · ${hostOf(cfg.relayUrl)}` : "v1: not paired";
  $<HTMLButtonElement>("s-unpair").disabled = !v1;
  $<HTMLButtonElement>("s-v1-pair").hidden = v1;
}

async function openSettings(): Promise<void> {
  $<HTMLSelectElement>("s-mode").value = cfg.pairMode;
  $<HTMLInputElement>("s-mailbox").value = cfg.mailboxUrl;
  $("s-mailbox-note").textContent = "Used for the next new code.";
  $("s-mailbox-note").classList.remove("error");
  $<HTMLInputElement>("s-relay").value = cfg.relayUrl;
  $<HTMLInputElement>("s-default").value = cfg.openUrls.default;
  $<HTMLTextAreaElement>("s-agents").value = Object.entries(cfg.openUrls.agents)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  $<HTMLSelectElement>("s-size").value = cfg.petSize;
  $("s-relay-note").textContent = "Changing relay means pairing again.";
  $("s-relay-note").classList.remove("error");
  await refreshConnRows();
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
  const mbNote = $("s-mailbox-note");
  const mb = validateMailboxUrl($<HTMLInputElement>("s-mailbox").value);
  if (!mb.ok) {
    mbNote.textContent = mb.error;
    mbNote.classList.add("error");
    return;
  }
  const mode = $<HTMLSelectElement>("s-mode").value === "v1" ? "v1" : "v2";
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
  saveSettings({
    relayUrl: check.url,
    pairMode: mode,
    mailboxUrl: mb.url,
    openUrls: { default: def, agents },
    petSize: size === "small" ? "small" : "large",
  });
  cfg = await loadConfig();
  $("settings").hidden = true;
  showPairMode();
  relayout();
  if (relayChanged) {
    // A v1 token belongs to one relay: revoke + forget it there (best effort). v2 is unaffected.
    const had = v1Active;
    oldTransport.stop();
    if (had) await oldTransport.unpair();
    transport = makeTransport(cfg.relayUrl);
    if (had) await dropV1(false);
  }
}

$("gear").addEventListener("click", () => ($("settings").hidden ? void openSettings() : ($("settings").hidden = true)));
$("s-close").addEventListener("click", () => ($("settings").hidden = true));
$("s-save").addEventListener("click", () => void saveSettingsFromForm());
$("s-local").addEventListener("click", () => ($<HTMLInputElement>("s-relay").value = LOCAL_RELAY));
$("s-hosted").addEventListener("click", () => ($<HTMLInputElement>("s-relay").value = HOSTED_RELAY));
$("s-ntfy").addEventListener("click", () => ($<HTMLInputElement>("s-mailbox").value = DEFAULT_MAILBOX));
$("s-unpair").addEventListener("click", () => {
  $("settings").hidden = true;
  void dropV1(true);
});
$("s-v1-pair").addEventListener("click", () => {
  $("settings").hidden = true;
  void beginV1();
});
$("s-v2-unpair").addEventListener("click", () => {
  $("settings").hidden = true;
  void dropV2();
});
$("s-v2-code").addEventListener("click", async () => {
  const code = await mailbox.code();
  $("settings").hidden = true;
  if (code) showCodeV2(code, false);
});
$("s-v2-new").addEventListener("click", () => {
  const btn = $<HTMLButtonElement>("s-v2-new");
  // Replacing a working pairing silences every bot on the old code: ask for a second click.
  if (v2Active && btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Sure? Old code stops";
    clearTimeout(confirmNewTimer);
    confirmNewTimer = window.setTimeout(() => {
      delete btn.dataset.confirm;
      btn.textContent = "New code";
    }, 4000);
    return;
  }
  delete btn.dataset.confirm;
  clearTimeout(confirmNewTimer);
  $("settings").hidden = true;
  void beginV2();
});
$("s-quit").addEventListener("click", () => void quitApp());
$("connect").addEventListener("click", () => void beginPairing());
$("cancel-pair").addEventListener("click", () => {
  if (codeKind === "v2") {
    // Cancel a code no bot has used yet; "Close" just hides an existing pairing's code.
    if (shownV2IsNew && !v2State.seen()) void dropV2();
    else show("pets");
  } else void dropV1(true);
});
$("done-pair").addEventListener("click", () => show("pets"));
$("copy").addEventListener("click", async () => {
  let line: string | null = null;
  if (codeKind === "v2" && shownV2Code) line = pasteLineV2(shownV2Code);
  else if (codeKind === "v1") {
    const p = pairingState.pending();
    if (p) line = pasteLine(p.code);
  }
  if (!line) return;
  const ok = await copyText(line);
  $("copy").textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

// Network back or window visible again (e.g. after sleep): reconnect now instead of waiting
// out the backoff. The Rust client also detects wake-from-sleep on its own.
window.addEventListener("online", () => {
  transport?.reconnectNow();
  mailbox?.reconnectNow();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  transport?.reconnectNow();
  mailbox?.reconnectNow();
});

// ---------- render loop ----------
const WAITING = "Paired. Waiting for your Grok Bot…";
const WAITING_V2 = "Paired. Waiting for your Grok Bot… (⚙ → Show code)";
function frame(): void {
  const now = Date.now();
  const offline = conn === "offline";
  for (const p of pets.values()) p.draw(bank, now, cfg, offline);
  if (view === "pets") {
    if (pets.size > 0) hint.textContent = "";
    else {
      const want = v2Active && !v1Active && !v2State.seen() ? WAITING_V2 : WAITING;
      if (!hint.textContent || ((hint.textContent === WAITING || hint.textContent === WAITING_V2) && hint.textContent !== want)) {
        hint.textContent = want;
      }
    }
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
    await Promise.all([bank.load(), art.load()]);
  } catch {
    statusEl.textContent = "sprites failed to load";
  }
  mailbox = inTauri ? new TauriMailbox() : new NoMailbox();
  showPairMode();
  v1Active = await transport.hasToken().catch(() => false);
  v2Active = mailbox.supported && (await mailbox.status().catch(() => ({ paired: false }))).paired;
  if (!v1Active) pairingState.clear();
  if (!v2Active) v2State.setSeen(false);
  const b = bootView({ v1: v1Active, v1Pending: !pairingState.paired() && pendingValid() !== null, v2: v2Active, v2Seen: v2State.seen() });
  if (b.code === "v2") {
    const code = await mailbox.code();
    if (code) showCodeV2(code, true);
    else show("pets");
  } else if (b.code === "v1") showCode();
  else show(b.view);
  // Each connection settles itself: the relay's "ready" event, the mailbox's first event.
  if (v1Active) {
    connV1 = { status: "connecting" };
    void connect();
  }
  if (v2Active) {
    connV2 = { status: "connecting" };
    void mailbox.start(mailboxHandlers).then((ok) => {
      if (!ok) {
        v2Active = false;
        connV2 = null;
        afterDrop();
      }
    });
  }
  renderStatus();
  relayout();
  requestAnimationFrame(frame);
}

window.addEventListener("error", (e) => console.warn("deskpet error", e.message));
window.addEventListener("unhandledrejection", (e) => console.warn("deskpet rejection", String(e.reason)));
void boot();
