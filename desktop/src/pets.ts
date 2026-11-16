// Pet model + view: one pet per agent_id, aggregating that agent's sessions.
import type { DeskPetConfig } from "./config.ts";
import { layoutToast, toastMaxWidth, type Slot } from "./layout.ts";
import type { PetState, StateEvent } from "./relay.ts";
import { accentFor, type AnimState, type SpriteBank } from "./sprites.ts";

/** Highest priority first. */
export const PRIORITY: PetState[] = ["needs_you", "error", "juggling", "working", "thinking", "done", "idle", "sleeping"];
const ACTIVE = new Set<PetState>(["thinking", "working", "juggling"]);
const MAX_SESSIONS = 16;

interface Session {
  state: PetState;
  at: number;
}

export function effectiveState(sessions: Iterable<Session>, now: number, staleActiveMs: number): PetState {
  let bestRank = Infinity;
  for (const s of sessions) {
    // An active session that has gone quiet (no heartbeat) is treated as idle.
    const st: PetState = ACTIVE.has(s.state) && now - s.at > staleActiveMs ? "idle" : s.state;
    bestRank = Math.min(bestRank, PRIORITY.indexOf(st));
  }
  return bestRank === Infinity ? "idle" : PRIORITY[bestRank];
}

export class Pet {
  readonly id: string;
  name: string;
  readonly accent: string;
  readonly sessions = new Map<string, Session>();
  lastActivity = 0;
  private doneSeq = 0;
  private playedDoneSeq = 0;
  private anim: { state: AnimState; start: number } = { state: "idle", start: 0 };
  private toastTimer: number | undefined;
  private slot: Slot | null = null;

  readonly el: HTMLDivElement;
  /** The toast lives in the stage (window coordinates), not inside the pet element. */
  readonly bubble: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLDivElement;

  constructor(id: string, name: string, cfg: DeskPetConfig) {
    this.id = id;
    this.name = name;
    this.accent = accentFor(id, cfg.accents);
    this.el = document.createElement("div");
    this.el.className = "pet";
    this.el.dataset.agent = id;
    this.el.style.setProperty("--accent", this.accent);
    this.bubble = document.createElement("div");
    this.bubble.className = "bubble";
    this.bubble.style.setProperty("--accent", this.accent);
    this.bubble.setAttribute("role", "status");
    this.canvas = document.createElement("canvas");
    this.canvas.width = 32;
    this.canvas.height = 32;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.label = document.createElement("div");
    this.label.className = "name";
    this.label.textContent = name;
    this.el.append(this.canvas, this.label);
  }

  /** Put the pet in its column (or hide it when it doesn't fit: slot null). */
  place(slot: Slot | null): void {
    this.slot = slot;
    this.el.hidden = slot === null;
    if (!slot) {
      this.bubble.classList.remove("show");
      return;
    }
    const w = slot.x1 - slot.x0;
    this.el.style.left = `${slot.x0}px`;
    this.el.style.width = `${w}px`;
    this.label.style.maxWidth = `${Math.max(24, w - 4)}px`;
    const css = `${slot.spriteSize}px`;
    if (this.canvas.style.width !== css) {
      this.canvas.style.width = css;
      this.canvas.style.height = css;
    }
    this.positionToast();
  }

  /** Measure the toast at its column's max width, then clamp it with the pure layout. */
  private positionToast(): void {
    const s = this.slot;
    if (!s || !this.bubble.textContent) return;
    const parent = this.bubble.parentElement;
    const winW = parent?.clientWidth || window.innerWidth;
    const winH = parent?.clientHeight || window.innerHeight;
    this.bubble.style.maxWidth = `${toastMaxWidth(s)}px`;
    const box = layoutToast(s, this.bubble.offsetWidth, this.bubble.offsetHeight, winW, winH);
    this.bubble.style.left = `${box.left}px`;
    this.bubble.style.top = `${box.top}px`;
    this.bubble.style.width = `${box.width}px`;
  }

  remove(): void {
    clearTimeout(this.toastTimer);
    this.el.remove();
    this.bubble.remove();
  }

  update(e: StateEvent, now: number, toastMs = 5000): void {
    if (e.agent_name && e.agent_name !== this.name) {
      this.name = e.agent_name;
      this.label.textContent = e.agent_name;
    }
    const at = Math.min(now, Date.parse(e.received_at) || now);
    const fresh = now - at < 10_000;
    this.sessions.delete(e.session);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(e.session, { state: e.state, at });
    this.lastActivity = Math.max(this.lastActivity, at);
    // "done" plays once per fresh done event; catch-up replays don't re-trigger it.
    if (e.state === "done" && fresh) this.doneSeq++;
    else if (e.state === "done") this.playedDoneSeq = this.doneSeq;
    if (e.message && fresh) this.toast(e.message, toastMs);
  }

  /** Newest message replaces the previous one; one toast per pet. */
  toast(text: string, ms: number): void {
    this.bubble.textContent = text; // textContent: never interpreted as HTML
    this.bubble.title = text;
    this.bubble.style.width = ""; // re-measure at natural width
    this.positionToast();
    if (this.slot) this.bubble.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.bubble.classList.remove("show"), ms);
  }

  renderState(now: number, cfg: DeskPetConfig, offline: boolean): AnimState {
    if (offline) return "offline";
    let s: PetState = effectiveState(this.sessions.values(), now, cfg.staleActiveMs);
    if (s === "done") {
      if (this.playedDoneSeq < this.doneSeq) return "done";
      s = "idle";
    } else {
      this.playedDoneSeq = this.doneSeq; // a done hidden behind a higher state is not replayed later
    }
    if (s === "idle" && now - this.lastActivity > cfg.sleepAfterMs) s = "sleeping";
    return s;
  }

  draw(bank: SpriteBank, now: number, cfg: DeskPetConfig, offline: boolean): void {
    if (!this.slot) return;
    const want = this.renderState(now, cfg, offline);
    if (want !== this.anim.state) this.anim = { state: want, start: now };
    const def = bank.defs[want];
    if (!def) return;
    let frame = Math.floor(((now - this.anim.start) * def.fps) / 1000);
    if (def.loop) frame %= def.frames;
    else if (frame >= def.frames) {
      frame = def.frames - 1;
      if (want === "done") this.playedDoneSeq = this.doneSeq;
    }
    const sheet = bank.sheet(want, this.accent);
    this.el.dataset.state = want;
    this.ctx.clearRect(0, 0, 32, 32);
    if (sheet) this.ctx.drawImage(sheet, frame * bank.fw, 0, bank.fw, bank.fh, 0, 0, bank.fw, bank.fh);
  }
}
