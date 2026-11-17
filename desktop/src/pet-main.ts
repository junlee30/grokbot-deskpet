// One bot's own window (pet.html): its pet, toast / working label, thought cloud and name.
// Rust (src-tauri/src/pet_windows.rs) opens this window on the bot's first event, sends it
// only this bot's events ("pet:state"), remembers where it is dragged and closes it on unpair.
import { loadConfig, type DeskPetConfig } from "./config.ts";
import { isStateEvent, type StateEvent } from "./events.ts";
import { layoutPets } from "./layout.ts";
import { Pet } from "./pets.ts";
import { agentOfLabel, EventFeed, frameDelay, grokbotId, grokbotUrl } from "./petwin.ts";
import { invokeCmd, onEvent, openExternal, startWindowDrag, windowLabel } from "./platform.ts";
import { SpriteBank } from "./sprites.ts";
import { AvatarBank } from "./avatar-bank.ts";
import { GEAR_SVG } from "./icons.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
// Reduced motion: avatars hold their body still (the state still shows in its overlays).
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
Pet.reducedMotion = calm.matches;
calm.addEventListener("change", () => {
  Pet.reducedMotion = calm.matches;
  kick();
});
app.innerHTML = `<div class="stage" id="stage"></div>`;
const stage = document.getElementById("stage") as HTMLDivElement;
/**
 * The hover ⚙ hangs off the name tag (Pet.attachToTag; CSS .tag > .gear), so it shares the
 * tag's centre line by construction. GEAR_RESERVE = its 6px gap + 18px width (style.css).
 */
const gear = document.createElement("button");
gear.className = "gear";
gear.title = "Settings (or right-click the pet)";
gear.setAttribute("aria-label", "Settings");
gear.innerHTML = GEAR_SVG;
gear.addEventListener("click", () => void invokeCmd("open_settings_window"));
const GEAR_RESERVE = 24;

/**
 * One tick per 32 ms (~30 fps) on a timer rather than requestAnimationFrame: half the wakeups
 * per window, and still shorter than the shortest held frame that matters (a 35 ms blink).
 * A tick whose pixels didn't change touches nothing (Pet.present).
 */

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
  kick();
}
window.addEventListener("resize", relayout);

function apply(e: StateEvent): void {
  if (!feed?.accept(e)) return;
  chatId = grokbotId(e.grokbot_id) ?? chatId;
  if (!pet) {
    pet = new Pet(e.agent_id, e.agent_name || e.agent_id, cfg, art);
    stage.append(pet.el, pet.bubble);
    pet.attachToTag(gear, GEAR_RESERVE);
    wirePet(pet);
    relayout();
  }
  pet.update(e, Date.now(), cfg.toastMs);
  kick();
}

function setOffline(status: unknown): void {
  const was = offline;
  offline = (status as { status?: string } | null)?.status === "offline";
  app.classList.toggle("offline", offline);
  if (was && !offline) refresh(); // back from sleep or a network drop
  else kick();
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
    down = null;
    if (ev.button !== 0 || (ev.target as Element).closest(".gear")) return; // the ⚙ is its own button
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

// ---------- render loop ----------
// One tick per change: a resting pet sleeps until its next blink, breath or z (petwin.ts
// nextChangeAt), at most a second; anything busy runs at FRAME_MS. A new event ticks at once.
let timer: ReturnType<typeof setTimeout> | null = null;

function frame(): void {
  if (!pet) return;
  pet.draw(bank, Date.now(), cfg, offline);
  const call = pet.attention.step(pet.el.dataset.state ?? "");
  if (call) {
    void invokeCmd("pet_attention", {
      needs: call.needs,
      notify: call.notify && cfg.notifyNeedsYou,
      name: pet.name,
      message: call.message ?? null,
    }).catch(() => {});
  }
}

function tick(): void {
  timer = null;
  frame();
  const now = Date.now();
  timer = setTimeout(tick, frameDelay(pet ? pet.nextFrameAt(now) : now, now));
}

/**
 * Rebuild every cached canvas and repaint. WebKit may silently drop canvas pixels while a
 * window is hidden or the Mac sleeps; this brings a vanished avatar back. Runs when the window
 * shows again, after the connection comes back, and every 30 s as a safety net.
 */
function refresh(): void {
  // No art yet (Rust may still be copying it, or Grok Bot isn't installed): look again.
  if (!art.manifest) void art.load().then(kick);
  bank.invalidate();
  art.invalidate();
  pet?.invalidate();
  kick();
}
const REFRESH_MS = 30_000;

/** Draw now (an event arrived, the window resized, settings changed). */
function kick(): void {
  if (timer === null) return; // not started yet
  clearTimeout(timer);
  tick();
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
  // The app copied (or re-copied) Grok Bot's avatar art: load it and redraw.
  await onEvent<unknown>("art:ready", async () => {
    await art.load();
    refresh();
  });
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
  tick();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
  window.addEventListener("pageshow", refresh);
}

window.addEventListener("error", (e) => console.warn("deskpet pet error", e.message));
window.addEventListener("unhandledrejection", (e) => console.warn("deskpet pet rejection", String(e.reason)));
void boot();
