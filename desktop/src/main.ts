// The main window: pairing, settings, connection status, and "waiting for your bot" while no
// bot has posted. Every bot is drawn in its own window (pet.html, src/pet-main.ts), opened and
// placed by the Rust side; this window hides itself while only the pets are needed.
import { loadConfig, saveSettings, v2State, type DeskPetConfig } from "./config.ts";
import { bootView, headerStatus, pasteLineV2, SKILL_URL, type Conn } from "./connections.ts";
import type { ConnStatus, StateEvent } from "./events.ts";
import { CHECK_SVG, GEAR_SVG, LOCK_SVG } from "./icons.ts";
import { controlWindowSize, petWindowSize, type PetSize } from "./layout.ts";
import { NoMailbox, TauriMailbox, type Mailbox, type MailboxHandlers } from "./mailbox.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "./net.ts";
import { mainWindowVisible } from "./petwin.ts";
import { appVersion, broadcast, copyText, inTauri, invokeCmd, onEvent, quitApp, setWindowSize, setWindowVisible, startWindowDrag } from "./platform.ts";
import appIcon from "../icons-src/icon.svg?url";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="panel" id="panel">
    <header class="head" data-tauri-drag-region>
      <img class="mark" src="${appIcon}" alt="" />
      <div class="titles">
        <h1>Desk Pet</h1>
        <div class="status"><span class="dot" id="status-dot"></span><span id="status"></span></div>
      </div>
      <button class="icon-btn" id="gear" title="Settings" aria-label="Settings" aria-pressed="false">${GEAR_SVG}</button>
    </header>

    <section class="view stack hello" id="pair-start" hidden>
      <div>
        <h2>Your Grok Bots, on your desk</h2>
        <p class="sub">Each bot gets a little pet that shows what it's up to. Click a pet to open its chat.</p>
      </div>
      <button class="primary big" id="connect">Connect your Grok Bot</button>
      <p class="meta" id="pair-mode"></p>
      <p class="meta error" id="pair-error"></p>
    </section>

    <section class="view stack" id="pair-code" hidden>
      <div>
        <h2>Paste this to your Grok Bot</h2>
        <p class="sub" id="pair-note"></p>
      </div>
      <div class="code-card" id="code-card"><div class="paste" id="paste-line"></div></div>
      <div class="actions">
        <button class="plain" id="cancel-pair">Cancel</button>
        <span class="spacer"></span>
        <button id="done-pair">Done</button>
        <button class="primary" id="copy">Copy</button>
      </div>
    </section>

    <section class="view empty" id="waiting" hidden>
      <img class="pup" src="${appIcon}" alt="" />
      <h2 id="w-title">Waiting for your first bot…</h2>
      <p class="sub" id="w-sub"></p>
      <button id="w-code" hidden>Show code</button>
    </section>

    <section class="view" id="settings" hidden>
      <div class="group">
        <div class="row">
          <span class="label">Pairing</span>
          <div class="value">
            <span class="state-line" id="s-v2-state"></span>
            <button type="button" class="small" id="s-v2-code">Show code</button>
            <button type="button" class="small" id="s-v2-new">New code</button>
            <button type="button" class="small danger" id="s-v2-unpair">Unpair</button>
          </div>
        </div>
        <div class="row">
          <span class="label">Skill</span>
          <div class="value"><button type="button" class="small" id="s-skill" title="${SKILL_URL}">Copy Skill Link</button></div>
          <div class="note" id="s-skill-note"></div>
        </div>
        <div class="row">
          <label class="label" for="s-mailbox">Mailbox</label>
          <div class="value">
            <input id="s-mailbox" spellcheck="false" autocomplete="off" />
            <button type="button" class="small" id="s-ntfy" title="${DEFAULT_MAILBOX}">ntfy.sh</button>
          </div>
          <div class="note" id="s-mailbox-note"></div>
        </div>
        <div class="row">
          <span class="label">Pet size</span>
          <div class="value">
            <div class="seg" role="radiogroup" aria-label="Pet size">
              <label><input type="radio" name="s-size" value="large" /><span>Large</span></label>
              <label><input type="radio" name="s-size" value="small" /><span>Small</span></label>
            </div>
          </div>
        </div>
        <div class="row">
          <span class="label">Alerts</span>
          <div class="value"><label class="check"><input type="checkbox" id="s-notify" /><span>Notify me when a bot needs me</span></label></div>
        </div>
        <div class="row">
          <span class="label">Positions</span>
          <div class="value"><button type="button" class="small" id="s-reset-pos">Reset Pet Positions</button></div>
          <div class="note" id="s-reset-note"></div>
        </div>
      </div>
      <div class="foot">
        <button class="plain" id="s-quit">Quit Desk Pet</button>
        <span class="version" id="s-version"></span>
        <span class="spacer"></span>
        <button id="s-close">Cancel</button>
        <button class="primary" id="s-save">Save</button>
      </div>
    </section>
  </div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLSpanElement>("status");
const panel = $<HTMLDivElement>("panel");

let cfg: DeskPetConfig;
/** Bots heard from on this pairing (each has its own window, opened by the Rust side). */
const agents = new Set<string>();
let mailbox: Mailbox; // the v2 private mailbox
let v2Active = false; // a pairing is in the keychain and we subscribe to its topic
let connV2: Conn | null = null;
let view: "pair-start" | "pair-code" | "pets" = "pair-start";
/** The code on the pair-code card: in memory only while the card is visible. */
let shownV2Code: string | null = null;
let shownV2IsNew = false;

const settingsOpen = () => !$("settings").hidden;

function show(v: typeof view): void {
  view = v;
  if (v !== "pair-code") {
    shownV2Code = null; // the dp2 code is not kept around once the card is gone
    $("paste-line").textContent = "";
    resetCopy();
  }
  app.dataset.view = v;
  syncMain();
}

/** Which section is on the panel, whether this window is on screen, and its size. */
function syncMain(): void {
  const s = settingsOpen();
  $("pair-start").hidden = s || view !== "pair-start";
  $("pair-code").hidden = s || view !== "pair-code";
  $("waiting").hidden = s || view !== "pets" || agents.size > 0;
  $("gear").setAttribute("aria-pressed", String(s));
  if (view === "pets" && agents.size === 0) {
    const first = !v2State.seen();
    setText("w-title", first ? "Waiting for your first bot…" : "Waiting for your bots…");
    setText(
      "w-sub",
      first
        ? "Paste the pairing message to a Grok Bot. Its pet pops up on your desk the moment it posts."
        : "Paired and listening. Each bot's pet pops up on your desk when it posts.",
    );
    $("w-code").hidden = !v2Active;
  }
  applyVisible(mainWindowVisible({ view, settingsOpen: s, pets: agents.size }));
  fitWindow();
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

/** The window is exactly as tall as the panel (it changes with the view). */
let fitQueued = false;
function fitWindow(): void {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    const { width, height } = controlWindowSize(panel.offsetHeight);
    void setWindowSize(width, height).catch(() => {});
  });
}

/** Show/hide this window, one call at a time, ending on the latest wish. */
let wantVisible = true;
let applyingVisible = false;
function applyVisible(v: boolean): void {
  wantVisible = v;
  if (applyingVisible) return;
  applyingVisible = true;
  void (async () => {
    for (;;) {
      const target = wantVisible;
      await setWindowVisible(target).catch(() => {});
      if (wantVisible === target) break;
    }
    applyingVisible = false;
  })();
}

function renderStatus(): void {
  const h = headerStatus({ paired: v2Active, conn: connV2, host: cfg ? hostOf(cfg.mailboxUrl) : "" });
  app.classList.toggle("offline", h.tone === "offline");
  $("status-dot").dataset.s = h.tone;
  statusEl.textContent = h.text;
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
  $("pair-mode").innerHTML = mailbox.supported ? `${LOCK_SVG}<span></span>` : "<span></span>";
  $("pair-mode").querySelector("span")!.textContent = mailbox.supported
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
  $("pair-note").textContent = "It works for any number of bots. The code is the key to your pets: share it only with your own bots.";
  $("cancel-pair").textContent = isNew ? "Cancel" : "Close";
  show("pair-code");
}

/** v2: the first valid encrypted event on this pairing. */
function markSeenV2(): void {
  if (!v2State.seen()) v2State.setSeen(true);
  if (view === "pair-start" || (view === "pair-code" && shownV2IsNew)) show("pets");
}

/** Close every bot's window (unpair, new code). Their saved positions stay. */
function dropAllPets(): void {
  agents.clear();
  void invokeCmd("pets_close_all").catch(() => {});
  syncMain();
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
  if (agents.has(e.agent_id)) return;
  agents.add(e.agent_id); // its window is opened by the Rust side
  syncMain();
}

// Dragging on any non-interactive background moves the window.
app.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  const t = ev.target as HTMLElement;
  if (t.closest("button, input, textarea, a, label, .paste, .group")) return;
  void startWindowDrag();
});

// ---------- settings ----------

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
  $("s-v2-new").classList.toggle("primary", !v2?.paired);
}

async function openSettings(): Promise<void> {
  $<HTMLInputElement>("s-mailbox").value = cfg.mailboxUrl;
  $("s-mailbox-note").textContent = "Used for the next new code.";
  $("s-mailbox-note").classList.remove("error");
  for (const r of sizeRadios()) r.checked = r.value === cfg.petSize;
  $<HTMLInputElement>("s-notify").checked = cfg.notifyNeedsYou;
  $("s-reset-note").textContent = "";
  $("s-skill-note").textContent = "";
  disarm($<HTMLButtonElement>("s-v2-new"), "New code");
  disarm($<HTMLButtonElement>("s-v2-unpair"), "Unpair");
  await refreshConnRows();
  $("settings").hidden = false;
  syncMain();
}

const sizeRadios = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="s-size"]'));

function closeSettings(): void {
  $("settings").hidden = true;
  syncMain();
}

/** Every bot's window is sized for the pet size (Rust resizes open ones in place). */
function applyPetSize(): Promise<unknown> {
  const { width, height } = petWindowSize(cfg.petSize);
  return invokeCmd("pets_set_size", { width, height }).catch(() => {});
}

async function saveSettingsFromForm(): Promise<void> {
  const mbNote = $("s-mailbox-note");
  const mb = validateMailboxUrl($<HTMLInputElement>("s-mailbox").value);
  if (!mb.ok) {
    mbNote.textContent = mb.error;
    mbNote.classList.add("error");
    return;
  }
  const size = (sizeRadios().find((r) => r.checked)?.value ?? cfg.petSize) as PetSize;
  saveSettings({
    mailboxUrl: mb.url,
    petSize: size === "small" ? "small" : "large",
    notifyNeedsYou: $<HTMLInputElement>("s-notify").checked,
  });
  cfg = await loadConfig();
  await applyPetSize();
  void broadcast("deskpet:config").catch(() => {}); // the pets reload their settings
  closeSettings();
  showPairMode();
}

$("gear").addEventListener("click", () => ($("settings").hidden ? void openSettings() : closeSettings()));
$("s-close").addEventListener("click", closeSettings);
$("s-reset-pos").addEventListener("click", () => {
  void invokeCmd("pets_reset_positions").catch(() => {});
  $("s-reset-note").textContent = agents.size ? "Done: lined up at the bottom right." : "Done: new bots start at the bottom right.";
  fitWindow();
});
$("s-save").addEventListener("click", () => void saveSettingsFromForm());
// For adding Desk Pet to the Grok Bot skill library by hand, or giving it to a bot to update.
$("s-skill").addEventListener("click", async () => {
  const ok = await copyText(SKILL_URL);
  $("s-skill-note").textContent = ok
    ? "Copied. Add it to your Grok Bot skill library, or send it to a bot to update its Desk Pet skill."
    : SKILL_URL;
  fitWindow();
});
$("s-ntfy").addEventListener("click", () => ($<HTMLInputElement>("s-mailbox").value = DEFAULT_MAILBOX));
/**
 * Destructive buttons take a second click: the first one arms it ("Sure? …") for 4 s.
 * Returns true when this click should go ahead.
 */
const armTimers = new Map<HTMLButtonElement, number>();
function confirmed(btn: HTMLButtonElement, ask: string, label: string): boolean {
  if (btn.dataset.confirm === "1") {
    disarm(btn, label);
    return true;
  }
  btn.dataset.confirm = "1";
  btn.textContent = ask;
  fitWindow();
  armTimers.set(btn, window.setTimeout(() => disarm(btn, label), 4000));
  return false;
}
function disarm(btn: HTMLButtonElement, label: string): void {
  clearTimeout(armTimers.get(btn));
  armTimers.delete(btn);
  if (btn.dataset.confirm !== "1") return;
  delete btn.dataset.confirm;
  btn.textContent = label;
}

$("s-v2-unpair").addEventListener("click", () => {
  // Unpairing silences every bot and deletes the key: ask for a second click.
  if (!confirmed($<HTMLButtonElement>("s-v2-unpair"), "Sure? Unpair", "Unpair")) return;
  closeSettings();
  void unpairV2();
});
$("s-v2-code").addEventListener("click", async () => {
  const code = await mailbox.code();
  closeSettings();
  if (code) showCodeV2(code, false);
});
$("s-v2-new").addEventListener("click", () => {
  // Replacing a working pairing silences every bot on the old code: ask for a second click.
  if (v2Active && !confirmed($<HTMLButtonElement>("s-v2-new"), "Sure? Old code stops", "New code")) return;
  closeSettings();
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
$("w-code").addEventListener("click", async () => {
  const code = await mailbox.code();
  if (code) showCodeV2(code, false);
});

// Copy: the button says "Copied" with a check, the card flashes, and Done becomes the main
// button. If the clipboard refuses, the text is selected so ⌘C works.
let copyTimer: number | undefined;
function resetCopy(): void {
  clearTimeout(copyTimer);
  const b = $<HTMLButtonElement>("copy");
  b.textContent = "Copy";
  b.className = "primary";
  $("done-pair").className = "";
  $("code-card").classList.remove("copied");
}
$("copy").addEventListener("click", async () => {
  if (!shownV2Code) return;
  const ok = await copyText(pasteLineV2(shownV2Code));
  const b = $<HTMLButtonElement>("copy");
  clearTimeout(copyTimer);
  if (ok) {
    b.innerHTML = `${CHECK_SVG}<span>Copied</span>`;
    b.className = "ok copied-btn";
    $("done-pair").className = "primary";
    $("code-card").classList.add("copied");
  } else {
    b.textContent = "Press ⌘C to copy";
    const range = document.createRange();
    range.selectNodeContents($("paste-line"));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }
  copyTimer = window.setTimeout(() => {
    b.textContent = "Copy again";
    b.className = "";
    $("code-card").classList.remove("copied");
  }, 1800);
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

// ---------- boot ----------
async function boot(): Promise<void> {
  app.classList.toggle("web", !inTauri);
  app.classList.toggle("vibrant", inTauri); // the window has macOS vibrancy behind the panel
  cfg = await loadConfig();
  await applyPetSize(); // before the first bot window opens
  void onEvent("ui:open-settings", () => void openSettings()); // menu bar icon, ⚙ or right-click on a pet
  void appVersion().then((v) => v && setText("s-version", `Version ${v}`));
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
  syncMain();
}

window.addEventListener("error", (e) => console.warn("deskpet error", e.message));
window.addEventListener("unhandledrejection", (e) => console.warn("deskpet rejection", String(e.reason)));
void boot();
