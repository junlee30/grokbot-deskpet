// Pet model + view: one pet per agent_id, aggregating that agent's sessions.
import type { DeskPetConfig } from "./config.ts";
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

  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLDivElement;
  private readonly bubble: HTMLDivElement;

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
    this.canvas = document.createElement("canvas");
    this.canvas.width = 32;
    this.canvas.height = 32;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.label = document.createElement("div");
    this.label.className = "name";
    this.label.textContent = name;
    this.el.append(this.bubble, this.canvas, this.label);
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

  toast(text: string, ms: number): void {
    this.bubble.textContent = text; // textContent: never interpreted as HTML
    this.bubble.classList.add("show");
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

  draw(bank: SpriteBank, now: number, cfg: DeskPetConfig, offline: boolean, scale: number): void {
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
    const css = `${bank.fw * scale}px`;
    if (this.canvas.style.width !== css) {
      this.canvas.style.width = css;
      this.canvas.style.height = `${bank.fh * scale}px`;
    }
    this.el.dataset.state = want;
    this.ctx.clearRect(0, 0, 32, 32);
    if (sheet) this.ctx.drawImage(sheet, frame * bank.fw, 0, bank.fw, bank.fh, 0, 0, bank.fw, bank.fh);
  }
}
