import { loadConfig, saveSettings, safeUrl, urlForAgent, v2State, type DeskPetConfig } from "./config.ts";
import { bootView, pasteLineV2, statusLine, type Conn } from "./connections.ts";
import type { ConnStatus, StateEvent } from "./events.ts";
import { layoutPets, orderPets, type PetSize } from "./layout.ts";
import { NoMailbox, TauriMailbox, type Mailbox, type MailboxHandlers } from "./mailbox.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "./net.ts";
import { Pet } from "./pets.ts";
import { copyText, inTauri, openExternal, quitApp, startWindowDrag } from "./platform.ts";
import { SpriteBank } from "./sprites.ts";
import { AvatarBank } from "./avatar-bank.ts";

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
        <button class="link" id="done-pair">Done</button>
        <button class="link" id="cancel-pair">Cancel</button>
      </div>
    </div>
  </section>

  <section class="card settings" id="settings" hidden>
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
let mailbox: Mailbox; // the v2 private mailbox
let v2Active = false; // a pairing is in the keychain and we subscribe to its topic
let connV2: Conn | null = null;
let conn: ConnStatus = "connecting";
let view: "pair-start" | "pair-code" | "pets" = "pair-start";
/** The code on the pair-code card: in memory only while the card is visible. */
let shownV2Code: string | null = null;
let shownV2IsNew = false;

function show(v: typeof view): void {
  view = v;
  if (v !== "pair-code") {
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
  const c = statusLine(v2Active ? connV2 : null);
  conn = c.status;
  app.classList.toggle("offline", c.status === "offline");
  statusEl.textContent = c.text;
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
  $("pair-mode").textContent = mailbox.supported
    ? `Private, end-to-end encrypted · via ${hostOf(cfg.mailboxUrl)}`
    : "The private mailbox needs the desktop app";
}

// ---------- pairing ----------
/** New v2 pairing: fresh topic + key in the keychain, subscribed at once, code shown. */
async function beginV2(): Promise<void> {
  const err = $("pair-error");
  err.textContent = "";
  const btn = $<HTMLButtonElement>("connect");
  btn.disabled = true;
  try {
    const code = await mailbox.pairNew(cfg.mailboxUrl, mailboxHandlers);
    if (v2Active) dropAllPets(); // bots on the old code can't be heard any more
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
  shownV2Code = code;
  shownV2IsNew = isNew;
  $("paste-line").textContent = pasteLineV2(code);
  $("pair-note").textContent = "This code is the key to your pet: share it only with your bots. Works on any number of bots.";
  $("cancel-pair").textContent = isNew ? "Cancel" : "Close";
  show("pair-code");
}

/** v2: the first valid encrypted event on this pairing. */
function markSeenV2(): void {
  if (!v2State.seen()) v2State.setSeen(true);
  if (view === "pair-start" || (view === "pair-code" && shownV2IsNew)) show("pets");
}

function dropAllPets(): void {
  for (const p of pets.values()) p.remove();
  pets.clear();
  relayout();
}

/** Stop and delete the pairing (topic + key): back to Connect. */
async function unpairV2(): Promise<void> {
  await mailbox.unpair();
  v2State.setSeen(false);
  v2Active = false;
  connV2 = null;
  dropAllPets();
  show("pair-start");
  renderStatus();
}

// ---------- stream ----------
const mailboxHandlers: MailboxHandlers = {
  onStatus: setV2Status,
  onState: (e) => {
    markSeenV2();
    handleState(e);
  },
};

function handleState(e: StateEvent): void {
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
    ? "Pairing needs the desktop app"
    : v2.paired
      ? `Paired${v2.mailbox ? ` · ${v2.mailbox}` : ""}${v2State.seen() ? "" : " · no bot yet"}`
      : "Not paired";
  $<HTMLButtonElement>("s-v2-code").disabled = !v2?.paired;
  $<HTMLButtonElement>("s-v2-unpair").disabled = !v2?.paired;
  $<HTMLButtonElement>("s-v2-new").disabled = !v2;
  $("s-v2-new").textContent = v2?.paired ? "New code" : "Pair";
}

async function openSettings(): Promise<void> {
  $<HTMLInputElement>("s-mailbox").value = cfg.mailboxUrl;
  $("s-mailbox-note").textContent = "Used for the next new code.";
  $("s-mailbox-note").classList.remove("error");
  $<HTMLInputElement>("s-default").value = cfg.openUrls.default;
  $<HTMLTextAreaElement>("s-agents").value = Object.entries(cfg.openUrls.agents)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  $<HTMLSelectElement>("s-size").value = cfg.petSize;
  await refreshConnRows();
  $("settings").hidden = false;
}

async function saveSettingsFromForm(): Promise<void> {
  const mbNote = $("s-mailbox-note");
  const mb = validateMailboxUrl($<HTMLInputElement>("s-mailbox").value);
  if (!mb.ok) {
    mbNote.textContent = mb.error;
    mbNote.classList.add("error");
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
  saveSettings({
    mailboxUrl: mb.url,
    openUrls: { default: def, agents },
    petSize: size === "small" ? "small" : "large",
  });
  cfg = await loadConfig();
  $("settings").hidden = true;
  showPairMode();
  relayout();
}

$("gear").addEventListener("click", () => ($("settings").hidden ? void openSettings() : ($("settings").hidden = true)));
$("s-close").addEventListener("click", () => ($("settings").hidden = true));
$("s-save").addEventListener("click", () => void saveSettingsFromForm());
$("s-ntfy").addEventListener("click", () => ($<HTMLInputElement>("s-mailbox").value = DEFAULT_MAILBOX));
$("s-v2-unpair").addEventListener("click", () => {
  $("settings").hidden = true;
  void unpairV2();
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
$("connect").addEventListener("click", () => void beginV2());
$("cancel-pair").addEventListener("click", () => {
  // Cancel a code no bot has used yet; "Close" just hides an existing pairing's code.
  if (shownV2IsNew && !v2State.seen()) void unpairV2();
  else show("pets");
});
$("done-pair").addEventListener("click", () => show("pets"));
$("copy").addEventListener("click", async () => {
  if (!shownV2Code) return;
  const ok = await copyText(pasteLineV2(shownV2Code));
  $("copy").textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

// Network back or window visible again (e.g. after sleep): reconnect now instead of waiting
// out the backoff. The Rust client also detects wake-from-sleep on its own.
function reconnectNow(): void {
  if (v2Active) mailbox?.reconnectNow();
}
window.addEventListener("online", reconnectNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") reconnectNow();
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
      const want = v2Active && !v2State.seen() ? WAITING_V2 : WAITING;
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
  try {
    await Promise.all([bank.load(), art.load()]);
  } catch {
    statusEl.textContent = "sprites failed to load";
  }
  mailbox = inTauri ? new TauriMailbox() : new NoMailbox();
  showPairMode();
  v2Active = mailbox.supported && (await mailbox.status().catch(() => ({ paired: false }))).paired;
  if (!v2Active) v2State.setSeen(false);
  const v = bootView({ paired: v2Active, seen: v2State.seen() });
  if (v === "pair-code") {
    const code = await mailbox.code();
    if (code) showCodeV2(code, true);
    else show("pets");
  } else show(v);
  // The connection settles itself on the mailbox's first event.
  if (v2Active) {
    connV2 = { status: "connecting" };
    void mailbox.start(mailboxHandlers).then((ok) => {
      if (!ok) {
        v2Active = false;
        connV2 = null;
        dropAllPets();
        show("pair-start");
        renderStatus();
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
