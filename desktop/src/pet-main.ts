// One bot's own window (pet.html): its pet, toast / working label, thought cloud and name.
// Rust (src-tauri/src/pet_windows.rs) opens this window on the bot's first event, sends it
// only this bot's events ("pet:state"), remembers where it is dragged and closes it on unpair.
import { loadConfig, type DeskPetConfig } from "./config.ts";
import { isStateEvent, type StateEvent } from "./events.ts";
import { layoutPets } from "./layout.ts";
import { Pet } from "./pets.ts";
import { agentOfLabel, EventFeed, grokbotId, grokbotUrl } from "./petwin.ts";
import { invokeCmd, onEvent, openExternal, startWindowDrag, windowLabel } from "./platform.ts";
import { SpriteBank } from "./sprites.ts";
import { AvatarBank } from "./avatar-bank.ts";
import { GEAR_SVG } from "./icons.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
// Reduced motion: avatars hold their body still (the state still shows in its overlays).
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
Pet.reducedMotion = calm.matches;
calm.addEventListener("change", () => (Pet.reducedMotion = calm.matches));
app.innerHTML = `
  <div class="stage" id="stage"></div>
  <button class="gear" id="gear" title="Settings (or right-click the pet)" aria-label="Settings">${GEAR_SVG}</button>
`;
const stage = document.getElementById("stage") as HTMLDivElement;

/**
 * One tick per 32 ms (~30 fps) on a timer rather than requestAnimationFrame: half the wakeups
 * per window, and still shorter than the shortest held frame that matters (a 35 ms blink).
 * A tick whose pixels didn't change touches nothing (Pet.present).
 */
const FRAME_MS = 32;

let cfg: DeskPetConfig;
const bank = new SpriteBank();
const art = new AvatarBank();
let feed: EventFeed | null = null;
let pet: Pet | null = null;
let offline = false;
/** The bot's Grok Bot agent UUID from its newest event that had a valid one. */
let chatId: string | null = null;

function relayout(): void {
  if (!pet) return;
  const [slot] = layoutPets(1, window.innerWidth, window.innerHeight, cfg.petSize);
  pet.place(slot ?? null);
}
window.addEventListener("resize", relayout);

function apply(e: StateEvent): void {
  if (!feed?.accept(e)) return;
  chatId = grokbotId(e.grokbot_id) ?? chatId;
  if (!pet) {
    pet = new Pet(e.agent_id, e.agent_name || e.agent_id, cfg, art);
    stage.append(pet.el, pet.bubble);
    wirePet(pet);
    relayout();
  }
  pet.update(e, Date.now(), cfg.toastMs);
}

function setOffline(status: unknown): void {
  offline = (status as { status?: string } | null)?.status === "offline";
  app.classList.toggle("offline", offline);
}

/**
 * A click opens the Grok Bot desktop app on this bot's chat (or just brings Grok Bot to the
 * front if the bot hasn't sent its id). If Grok Bot isn't installed, nothing happens (Rust
 * logs that once).
 */
async function openInGrokBot(): Promise<void> {
  const installed = await invokeCmd<boolean>("grokbot_installed").catch(() => false);
  if (!installed) return;
  await openExternal(grokbotUrl(chatId)).catch((err) => console.warn("deskpet: opening Grok Bot failed", String(err)));
}

// ---------- interaction: click opens Grok Bot on this bot's chat, drag moves this window ----------
function wirePet(p: Pet): void {
  let down: { x: number; y: number } | null = null;
  p.el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    down = { x: ev.screenX, y: ev.screenY };
  });
  p.el.addEventListener("pointermove", (ev) => {
    if (!down) return;
    if (Math.hypot(ev.screenX - down.x, ev.screenY - down.y) > 4) {
      down = null;
      void startWindowDrag();
    }
  });
  p.el.addEventListener("pointerup", () => {
    if (!down) return;
    down = null;
    void openInGrokBot();
  });
  p.el.addEventListener("pointerleave", () => (down = null));
}

// The rest of the window (around the pet) drags too.
app.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  if ((ev.target as HTMLElement).closest("button, .pet")) return;
  void startWindowDrag();
});
// Right-click: Settings…, Reset pet positions, Quit (the same menu as the menu bar icon).
app.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  void invokeCmd("pet_menu");
});
document.getElementById("gear")!.addEventListener("click", () => void invokeCmd("open_settings_window"));

// ---------- render loop ----------
function frame(): void {
  pet?.draw(bank, Date.now(), cfg, offline);
}

async function boot(): Promise<void> {
  cfg = await loadConfig();
  try {
    await Promise.all([bank.load(), art.load()]);
  } catch {
    /* robot fallback / nothing drawn: the window still works */
  }
  const label = await windowLabel();
  // Listen first, then fetch the backlog: an event in between arrives twice, EventFeed keeps one.
  const early: StateEvent[] = [];
  let ready = false;
  await onEvent<unknown>(
    "pet:state",
    (p) => {
      if (!isStateEvent(p)) return;
      if (ready) apply(p);
      else early.push(p);
    },
    label, // only this bot's events (Rust sends each bot's to its own window)
  );
  await onEvent<unknown>("mailbox:status", setOffline);
  await onEvent<unknown>("deskpet:config", async () => {
    cfg = await loadConfig();
    relayout();
  });
  const init = await invokeCmd<{ agent_id: string; events: unknown[]; status: unknown }>("pet_init").catch(() => undefined);
  const agent = init?.agent_id ?? agentOfLabel(label);
  if (!agent) return;
  feed = new EventFeed(agent);
  setOffline(init?.status ?? null);
  for (const e of init?.events ?? []) if (isStateEvent(e)) apply(e);
  ready = true;
  for (const e of early.splice(0)) apply(e);
  setInterval(frame, FRAME_MS);
}

window.addEventListener("error", (e) => console.warn("deskpet pet error", e.message));
window.addEventListener("unhandledrejection", (e) => console.warn("deskpet pet rejection", String(e.reason)));
void boot();
