// Dev-only UI preview (preview.html, served by `npm run dev`; not in the build): one pet
// window per state with sample messages, drawn by the real Pet class, so bubbles, the working
// label and the name tag can be checked in light and dark without a bot or a pairing.
import { DEFAULTS, type DeskPetConfig } from "./config.ts";
import type { PetState, StateEvent } from "./events.ts";
import { layoutPets, petWindowSize, type PetSize } from "./layout.ts";
import { Pet } from "./pets.ts";
import { SpriteBank } from "./sprites.ts";
import { AvatarBank } from "./avatar-bank.ts";
import { LOCK_SVG } from "./icons.ts";
import { pasteLineV2 } from "./connections.ts";

interface Sample {
  caption: string;
  state: PetState;
  message?: string;
  extra?: PetState; // a second session (juggling)
  offline?: boolean;
  avatar?: { shape: string; color: string };
  name?: string;
}

const SAMPLES: Sample[] = [
  { caption: "idle", state: "idle", avatar: { shape: "blob", color: "black" } },
  { caption: "thinking + toast", state: "thinking", message: "Reading the issue and the failing test", avatar: { shape: "clover", color: "orange" }, name: "Clover" },
  { caption: "working (label)", state: "working", message: "Running the test suite", avatar: { shape: "blob", color: "black" } },
  { caption: "juggling", state: "working", extra: "working", message: "Refactoring the parser", avatar: { shape: "star", color: "blue" }, name: "Nova" },
  { caption: "needs_you", state: "needs_you", message: "Can I push to main?", avatar: { shape: "heart", color: "red" }, name: "Ruby" },
  { caption: "error", state: "error", message: "Build failed: 3 tests", avatar: { shape: "pebble", color: "gray" } },
  { caption: "done", state: "done", message: "All 87 tests pass", avatar: { shape: "leaf", color: "green" }, name: "Fern" },
  { caption: "offline", state: "idle", offline: true, avatar: { shape: "blob", color: "black" } },
  { caption: "robot fallback, long toast", state: "thinking", message: "A very long message that should clamp to two lines with an ellipsis at the end of it" },
];

const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
Pet.reducedMotion = calm.matches;
calm.addEventListener("change", () => (Pet.reducedMotion = calm.matches));

const size: PetSize = new URLSearchParams(location.search).get("size") === "small" ? "small" : "large";
const cfg: DeskPetConfig = { ...DEFAULTS, toastMs: 1e9, sleepAfterMs: 1e9 };
const bank = new SpriteBank();
const art = new AvatarBank();
const gallery = document.getElementById("gallery")!;
const pets: { pet: Pet; offline: boolean }[] = [];

function event(s: Sample, session: string, state: PetState, now: number): StateEvent {
  const iso = new Date(now).toISOString();
  return { agent_id: s.caption, agent_name: s.name ?? "Jarvis", session, state, event: "preview", message: s.message, ts: iso, received_at: iso, avatar: s.avatar };
}

async function main(): Promise<void> {
  await Promise.all([bank.load(), art.load().catch(() => {})]);
  const { width, height } = petWindowSize(size);
  const now = Date.now();
  for (const s of SAMPLES) {
    const cell = document.createElement("div");
    const win = document.createElement("div");
    win.className = "win" + (s.offline ? " offline" : "");
    win.dataset.kind = "pet";
    win.style.width = `${width}px`;
    win.style.height = `${height}px`;
    const stage = document.createElement("div");
    stage.className = "stage";
    win.append(stage);
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = s.caption;
    cell.append(win, cap);
    gallery.append(cell);
    const pet = new Pet(s.caption, s.name ?? "Jarvis", cfg, art);
    stage.append(pet.el, pet.bubble);
    pet.place(layoutPets(1, width, height, size)[0] ?? null);
    if (s.extra) pet.update(event(s, "b", s.extra, now), now, cfg.toastMs);
    pet.update(event(s, "a", s.state, now), now, cfg.toastMs);
    pets.push({ pet, offline: !!s.offline });
  }
  setInterval(() => {
    const t = Date.now();
    for (const p of pets) p.pet.draw(bank, t, cfg, p.offline);
  }, 32);
}

/** The control window (index.html) in each of its views, side by side. Uses a FAKE code. */
const VIEWS = ["pair-start", "pair-code", "waiting", "settings"] as const;
const FAKE_CODE = "dp2.EXAMPLE-not-a-real-code"; // too short to look like a real dp2 code

function showView(doc: Document, view: (typeof VIEWS)[number]): void {
  const $ = (id: string) => doc.getElementById(id);
  for (const id of ["pair-start", "pair-code", "waiting", "settings"]) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  const paired = view !== "pair-start";
  $("status-dot")!.dataset.s = paired ? "online" : "none";
  $("status")!.textContent = paired ? "Connected · ntfy.sh" : "Not paired";
  if (view === "pair-start") {
    $("pair-start")!.hidden = false;
    $("pair-mode")!.innerHTML = `${LOCK_SVG}<span>Private, end-to-end encrypted · via ntfy.sh</span>`;
  }
  if (view === "pair-code") {
    $("pair-code")!.hidden = false;
    $("paste-line")!.textContent = pasteLineV2(FAKE_CODE);
    $("pair-note")!.textContent = "It works for any number of bots. The code is the key to your pets: share it only with your own bots.";
  }
  if (view === "waiting") {
    $("waiting")!.hidden = false;
    $("w-sub")!.textContent = "Paste the pairing message to a Grok Bot. Its pet pops up on your desk the moment it posts.";
    $("w-code")!.hidden = false;
  }
  if (view === "settings") {
    $("settings")!.hidden = false;
    $("gear")!.setAttribute("aria-pressed", "true");
    $("s-v2-state")!.textContent = "Paired · ntfy.sh";
    for (const b of ["s-v2-code", "s-v2-unpair", "s-v2-new"]) ($(b) as HTMLButtonElement).disabled = false;
    ($("s-mailbox") as HTMLInputElement).value = "https://ntfy.sh";
    $("s-mailbox-note")!.textContent = "Used for the next new code.";
    (doc.querySelector('input[name="s-size"][value="large"]') as HTMLInputElement).checked = true;
    (doc.getElementById("s-notify") as HTMLInputElement).checked = true;
    $("s-version")!.textContent = "Version 0.3.0";
  }
}

function controls(): void {
  for (const v of VIEWS) {
    const cell = document.createElement("div");
    const f = document.createElement("iframe");
    f.src = `/index.html?preview=${v}`;
    f.style.cssText = "width:408px;height:440px;border:0;background:transparent";
    f.setAttribute("allowtransparency", "true");
    f.addEventListener("load", () => setTimeout(() => showView(f.contentDocument!, v), 400));
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = v;
    cell.append(f, cap);
    gallery.append(cell);
  }
}

if (new URLSearchParams(location.search).has("controls")) controls();
else void main();
