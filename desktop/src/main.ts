// The main window: pairing, settings, connection status, and "waiting for your bot" while no
// bot has posted. Every bot is drawn in its own window (pet.html, src/pet-main.ts), opened and
// placed by the Rust side; this window hides itself while only the pets are needed.
import { loadConfig, saveSettings, v2State, type DeskPetConfig } from "./config.ts";
import { bootView, headerStatus, pasteLineV2, SKILL_URL, type Conn } from "./connections.ts";
import { strings, uiLocale } from "./i18n.ts";
import type { ConnStatus, StateEvent } from "./events.ts";
import { CHECK_SVG, GEAR_SVG, LOCK_SVG } from "./icons.ts";
import { controlWindowSize, petWindowSize, type PetSize } from "./layout.ts";
import { NoMailbox, TauriMailbox, type Mailbox, type MailboxHandlers } from "./mailbox.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "./net.ts";
import { mainWindowVisible } from "./petwin.ts";
import { appVersion, broadcast, copyText, inTauri, invokeCmd, preferredLanguages, onEvent, quitApp, setWindowSize, setWindowVisible, startWindowDrag } from "./platform.ts";
import appIcon from "../icons-src/icon.svg?url";

// The UI language: the Mac's first preferred language if we have it (as Grok Bot decides).
const ui = uiLocale(preferredLanguages());
const t = strings(ui);
document.documentElement.lang = ui;
// Menus and the menu bar tooltip are built in Rust: give it this language's labels.
void invokeCmd("set_ui_strings", {
  strings: {
    settings: t.menuSettings,
    check_updates: t.menuCheckUpdates,
    update_to: t.menuUpdateTo,
    keep_on_top: t.menuKeepOnTop,
    reset_positions: t.resetPositions,
    show_hidden: t.showHidden,
    quit: t.quit,
    tray_needs_one: t.trayNeedsOne,
    tray_needs_many: t.trayNeedsMany,
  },
}).catch(() => {});

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="panel" id="panel">
    <header class="head" data-tauri-drag-region>
      <img class="mark" src="${appIcon}" alt="" />
      <div class="titles">
        <h1>Desk Pet</h1>
        <div class="status"><span class="dot" id="status-dot"></span><span id="status"></span></div>
      </div>
      <button class="icon-btn" id="gear" title="${t.settings}" aria-label="${t.settings}" aria-pressed="false">${GEAR_SVG}</button>
    </header>

    <section class="view stack hello" id="pair-start" hidden>
      <div>
        <h2>${t.helloTitle}</h2>
        <p class="sub">${t.helloSub}</p>
      </div>
      <button class="primary big" id="connect">${t.connect}</button>
      <p class="meta" id="pair-mode"></p>
      <p class="meta error" id="pair-error"></p>
    </section>

    <section class="view stack" id="pair-code" hidden>
      <div>
        <h2>${t.pasteTitle}</h2>
        <p class="sub" id="pair-note"></p>
      </div>
      <div class="code-card" id="code-card"><div class="paste" id="paste-line"></div></div>
      <div class="actions">
        <button class="plain" id="cancel-pair">${t.cancel}</button>
        <span class="spacer"></span>
        <button id="done-pair">${t.done}</button>
        <button class="primary" id="copy">${t.copy}</button>
      </div>
    </section>

    <section class="view empty" id="waiting" hidden>
      <img class="pup" src="${appIcon}" alt="" />
      <h2 id="w-title">${t.waitingFirst}</h2>
      <p class="sub" id="w-sub"></p>
      <button id="w-code" hidden>${t.showCode}</button>
    </section>

    <section class="view" id="settings" hidden>
      <div class="group">
        <div class="row">
          <span class="label">${t.pairing}</span>
          <div class="value">
            <span class="state-line" id="s-v2-state"></span>
            <button type="button" class="small" id="s-v2-code">${t.showCode}</button>
            <button type="button" class="small" id="s-v2-new">${t.newCode}</button>
            <button type="button" class="small danger" id="s-v2-unpair">${t.unpair}</button>
          </div>
        </div>
        <div class="row">
          <span class="label">${t.skill}</span>
          <div class="value"><button type="button" class="small" id="s-skill" title="${SKILL_URL}">${t.copySkillLink}</button></div>
          <div class="note" id="s-skill-note"></div>
        </div>
        <div class="row">
          <label class="label" for="s-mailbox">${t.mailbox}</label>
          <div class="value">
            <input id="s-mailbox" spellcheck="false" autocomplete="off" />
            <button type="button" class="small" id="s-ntfy" title="${DEFAULT_MAILBOX}">ntfy.sh</button>
          </div>
          <div class="note" id="s-mailbox-note"></div>
        </div>
        <div class="row">
          <span class="label">${t.petSize}</span>
          <div class="value">
            <div class="seg" role="radiogroup" aria-label="${t.petSize}">
              <label><input type="radio" name="s-size" value="large" /><span>${t.large}</span></label>
              <label><input type="radio" name="s-size" value="small" /><span>${t.small}</span></label>
            </div>
          </div>
        </div>
        <div class="row">
          <span class="label">${t.alerts}</span>
          <div class="value"><label class="check"><input type="checkbox" id="s-notify" /><span>${t.notifyMe}</span></label></div>
        </div>
        <div class="row">
          <span class="label">${t.pets}</span>
          <div class="value checks">
            <label class="check"><input type="checkbox" id="s-on-top" /><span>${t.keepOnTop}</span></label>
            <label class="check"><input type="checkbox" id="s-animate" /><span>${t.animateResting}</span></label>
          </div>
          <div class="note">${t.keepOnTopNote}</div>
        </div>
        <div class="row">
          <span class="label">${t.positions}</span>
          <div class="value"><button type="button" class="small" id="s-reset-pos">${t.resetPositions}</button></div>
          <div class="note" id="s-reset-note"></div>
        </div>
        <div class="row" id="s-updates-row">
          <span class="label">${t.updates}</span>
          <div class="value">
            <span class="state-line" id="s-update-state"></span>
            <button type="button" class="small" id="s-update"></button>
          </div>
        </div>
      </div>
      <div class="foot">
        <button class="plain" id="s-quit">${t.quit}</button>
        <span class="version" id="s-version"></span>
        <span class="spacer"></span>
        <button id="s-close">${t.cancel}</button>
        <button class="primary" id="s-save">${t.save}</button>
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
    setText("w-title", first ? t.waitingFirst : t.waitingBots);
    setText(
      "w-sub",
      first ? t.waitingFirstSub : t.waitingSub,
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
  const h = headerStatus({ paired: v2Active, conn: connV2, host: cfg ? hostOf(cfg.mailboxUrl) : "" }, t);
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
    ? t.pairMode(hostOf(cfg.mailboxUrl))
    : t.needsDesktop;
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
    err.textContent = t.codeError(e instanceof Error ? e.message : String(e)).slice(0, 120);
    if (view !== "pair-start") show("pair-start");
  } finally {
    btn.disabled = false;
  }
}

function showCodeV2(code: string, isNew: boolean): void {
  shownV2Code = code;
  shownV2IsNew = isNew;
  $("paste-line").textContent = pasteLineV2(code, t);
  $("pair-note").textContent = t.pairNote;
  $("cancel-pair").textContent = isNew ? t.cancel : t.close;
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
    ? t.pairingNeedsDesktop
    : v2.paired
      ? t.paired(v2.mailbox ?? null, !v2State.seen())
      : t.notPaired;
  $<HTMLButtonElement>("s-v2-code").disabled = !v2?.paired;
  $<HTMLButtonElement>("s-v2-unpair").disabled = !v2?.paired;
  $<HTMLButtonElement>("s-v2-new").disabled = !v2;
  $("s-v2-new").textContent = v2?.paired ? t.newCode : t.pair;
  $("s-v2-new").classList.toggle("primary", !v2?.paired);
}

async function openSettings(): Promise<void> {
  $<HTMLInputElement>("s-mailbox").value = cfg.mailboxUrl;
  $("s-mailbox-note").textContent = t.mailboxNote;
  $("s-mailbox-note").classList.remove("error");
  for (const r of sizeRadios()) r.checked = r.value === cfg.petSize;
  $<HTMLInputElement>("s-notify").checked = cfg.notifyNeedsYou;
  $<HTMLInputElement>("s-animate").checked = cfg.animateResting;
  $<HTMLInputElement>("s-on-top").checked = (await invokeCmd<boolean>("pets_on_top").catch(() => undefined)) ?? true;
  $("s-reset-note").textContent = "";
  $("s-skill-note").textContent = "";
  disarm($<HTMLButtonElement>("s-v2-new"), t.newCode);
  disarm($<HTMLButtonElement>("s-v2-unpair"), t.unpair);
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
  const mb = validateMailboxUrl($<HTMLInputElement>("s-mailbox").value, t);
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
    animateResting: $<HTMLInputElement>("s-animate").checked,
  });
  await invokeCmd("pets_set_on_top", { onTop: $<HTMLInputElement>("s-on-top").checked }).catch(() => {});
  cfg = await loadConfig();
  await applyPetSize();
  void broadcast("deskpet:config").catch(() => {}); // the pets reload their settings
  closeSettings();
  showPairMode();
}

// ---------- updates (Rust: src-tauri/src/updater.rs) ----------
// Check for Updates… in the menu bar opens Settings and checks; a newer version found by the
// app's own background check shows up here too. Install downloads, verifies the signature,
// replaces the app and relaunches it.
type UpdateView =
  | { kind: "idle" | "checking" | "latest" | "installing" | "check-failed" | "install-failed" }
  | { kind: "found"; version: string }
  | { kind: "downloading"; pct: number | null };
let update: UpdateView = { kind: "idle" };
const updateBusy = () => update.kind === "checking" || update.kind === "downloading" || update.kind === "installing";

function renderUpdate(): void {
  const btn = $<HTMLButtonElement>("s-update");
  const u = update;
  const line =
    u.kind === "checking" ? t.checking
    : u.kind === "latest" ? t.upToDate
    : u.kind === "found" ? t.updateFound(u.version)
    : u.kind === "downloading" ? t.downloading(u.pct)
    : u.kind === "installing" ? t.installing
    : u.kind === "check-failed" ? t.checkFailed
    : u.kind === "install-failed" ? t.installFailed
    : "";
  setText("s-update-state", line);
  $("s-update-state").hidden = !line;
  btn.textContent = u.kind === "found" ? t.installRelaunch : u.kind.endsWith("failed") ? t.tryAgain : t.checkNow;
  btn.classList.toggle("primary", u.kind === "found" || u.kind === "install-failed");
  btn.disabled = updateBusy();
  fitWindow();
}

async function checkForUpdates(): Promise<void> {
  if (updateBusy()) return;
  update = { kind: "checking" };
  renderUpdate();
  try {
    const found = await invokeCmd<{ version: string } | null>("update_check");
    update = found ? { kind: "found", version: found.version } : { kind: "latest" };
  } catch {
    update = { kind: "check-failed" };
  }
  renderUpdate();
}

async function installUpdate(): Promise<void> {
  if (updateBusy()) return;
  update = { kind: "downloading", pct: null };
  renderUpdate();
  try {
    await invokeCmd("update_install"); // relaunches the app when it works
  } catch {
    update = { kind: "install-failed" };
    renderUpdate();
  }
}

$("s-update").addEventListener("click", () => {
  if (update.kind === "found" || update.kind === "install-failed") void installUpdate();
  else void checkForUpdates();
});
$("s-updates-row").hidden = !inTauri;
renderUpdate();

$("gear").addEventListener("click", () => ($("settings").hidden ? void openSettings() : closeSettings()));
$("s-close").addEventListener("click", closeSettings);
$("s-reset-pos").addEventListener("click", () => {
  void invokeCmd("pets_reset_positions").catch(() => {});
  $("s-reset-note").textContent = agents.size ? t.resetDoneSome : t.resetDoneNone;
  fitWindow();
});
$("s-save").addEventListener("click", () => void saveSettingsFromForm());
// For adding Desk Pet to the Grok Bot skill library by hand, or giving it to a bot to update.
$("s-skill").addEventListener("click", async () => {
  const ok = await copyText(SKILL_URL);
  $("s-skill-note").textContent = ok
    ? t.skillCopied
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
  if (!confirmed($<HTMLButtonElement>("s-v2-unpair"), t.sureUnpair, t.unpair)) return;
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
  if (v2Active && !confirmed($<HTMLButtonElement>("s-v2-new"), t.sureNewCode, t.newCode)) return;
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
  b.textContent = t.copy;
  b.className = "primary";
  $("done-pair").className = "";
  $("code-card").classList.remove("copied");
}
$("copy").addEventListener("click", async () => {
  if (!shownV2Code) return;
  const ok = await copyText(pasteLineV2(shownV2Code, t));
  const b = $<HTMLButtonElement>("copy");
  clearTimeout(copyTimer);
  if (ok) {
    b.innerHTML = `${CHECK_SVG}<span>${t.copied}</span>`;
    b.className = "ok copied-btn";
    $("done-pair").className = "primary";
    $("code-card").classList.add("copied");
  } else {
    b.textContent = t.pressCmdC;
    const range = document.createRange();
    range.selectNodeContents($("paste-line"));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }
  copyTimer = window.setTimeout(() => {
    b.textContent = t.copyAgain;
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
  void onEvent("ui:check-updates", () => void checkForUpdates()); // menu bar: Check for Updates…
  void onEvent<{ version: string } | null>("update:found", (f) => {
    if (updateBusy() || update.kind === "install-failed") return;
    update = f ? { kind: "found", version: f.version } : update.kind === "found" ? { kind: "idle" } : update;
    renderUpdate();
  });
  void onEvent<{ done?: number; total?: number | null; installing?: boolean }>("update:progress", (p) => {
    if (update.kind !== "downloading" && update.kind !== "installing") return;
    update = p.installing
      ? { kind: "installing" }
      : { kind: "downloading", pct: p.total ? Math.min(100, Math.floor(((p.done ?? 0) * 100) / p.total)) : null };
    renderUpdate();
  });
  // Keep Pets on Top changed from the menu bar: an open Settings card follows it.
  void onEvent<boolean>("pets:on-top", (on) => ($<HTMLInputElement>("s-on-top").checked = on));
  void appVersion().then((v) => v && setText("s-version", t.version(v)));
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
