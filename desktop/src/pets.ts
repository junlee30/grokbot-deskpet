// Pet model + view: one pet per agent_id. Which of its sessions count: sessions.ts.
import type { DeskPetConfig } from "./config.ts";
import { LABEL_OVERLAP_PX, layoutToast, tailX, toastMaxWidth, type Slot } from "./layout.ts";
import { bubbleView, carryMessage, sameView, stickyLabel, type BubbleView } from "./presence.ts";
import type { PetState, StateEvent } from "./events.ts";
import { displayFor, eventOrder, type Session } from "./sessions.ts";
import { accentFor, type AnimState, type SpriteBank } from "./sprites.ts";
import { accentHex, AVATAR_DONE_MS, avatarCue, calmCue, avatarGeometry, colorHex, FacePlayer, parseAvatar, type Avatar } from "./avatar.ts";
import { drawAvatar, type AvatarBank } from "./avatar-bank.ts";
import { samePixels } from "./petwin.ts";

const MAX_SESSIONS = 16;

export class Pet {
  /** prefers-reduced-motion: avatars hold their body still (calmCue). Set by the window. */
  static reducedMotion = false;
  readonly id: string;
  name: string;
  accent: string;
  /** Latest Grok Bot profile avatar a bot sent us (null: robot art). */
  avatar: Avatar | null = null;
  private readonly face = new FacePlayer();
  private readonly art: AvatarBank | null;
  private readonly accentOverride: string | undefined;
  private mode: "robot" | "avatar" = "robot";
  readonly sessions = new Map<string, Session>();
  lastActivity = 0;
  /** Sessions behind the state drawn last frame (the sticky label comes from these). */
  private shownSessions: Session[] = [];
  private arrivals = 0;
  private doneSeq = 0;
  private playedDoneSeq = 0;
  private anim: { state: AnimState; start: number } = { state: "idle", start: 0 };
  private toastMsg: { text: string; until: number } | null = null;
  private view: BubbleView = { mode: "hidden" };
  private slot: Slot | null = null;

  readonly el: HTMLDivElement;
  /** The toast lives in the stage (window coordinates), not inside the pet element. */
  readonly bubble: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * Frames are drawn here first and copied to the visible canvas only when a pixel changed:
   * a resting pet then leaves its window untouched (nothing to repaint or composite).
   */
  private readonly scratch: HTMLCanvasElement;
  private readonly paint: CanvasRenderingContext2D;
  private shownPixels: Uint32Array | null = null;
  /** What the scratch canvas was last painted from (same inputs: same pixels, skip it). */
  private paintedKey = "";
  private readonly label: HTMLDivElement;
  private readonly bubbleText: HTMLSpanElement;

  constructor(id: string, name: string, cfg: DeskPetConfig, art: AvatarBank | null = null) {
    this.id = id;
    this.name = name;
    this.art = art;
    const o = cfg.accents[id];
    this.accentOverride = o && /^#[0-9a-fA-F]{6}$/.test(o) ? o : undefined;
    this.accent = accentFor(id, cfg.accents);
    this.el = document.createElement("div");
    this.el.className = "pet";
    this.el.dataset.agent = id;
    this.el.style.setProperty("--accent", this.accent);
    this.bubble = document.createElement("div");
    this.bubble.className = "bubble";
    this.bubble.style.setProperty("--accent", this.accent);
    this.bubble.setAttribute("role", "status");
    this.bubbleText = document.createElement("span");
    this.bubbleText.className = "text";
    this.bubble.append(this.bubbleText);
    this.canvas = document.createElement("canvas");
    this.canvas.width = 32;
    this.canvas.height = 32;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.scratch = document.createElement("canvas");
    this.scratch.width = 32;
    this.scratch.height = 32;
    this.paint = this.scratch.getContext("2d", { willReadFrequently: true })!;
    this.paint.imageSmoothingEnabled = false;
    this.label = document.createElement("div");
    this.label.className = "name";
    this.label.textContent = name;
    this.el.title = `Open ${name} in Grok Bot`;
    this.el.append(this.canvas, this.label);
  }

  /** Put the pet in its column (or hide it when it doesn't fit: slot null). */
  place(slot: Slot | null): void {
    this.slot = slot;
    this.el.hidden = slot === null;
    if (!slot) {
      this.bubble.classList.remove("show");
      this.view = { mode: "hidden" };
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
    const overlap = this.view.mode === "sticky" ? LABEL_OVERLAP_PX : undefined;
    // Fractional size: offsetWidth rounds down, and a box 0.4 px too narrow wraps its last word.
    const r = this.bubble.getBoundingClientRect();
    const box = layoutToast(s, r.width + 0.5, r.height, winW, winH, overlap);
    this.bubble.style.left = `${box.left}px`;
    this.bubble.style.top = `${box.top}px`;
    this.bubble.style.width = `${box.width}px`;
    this.bubble.style.setProperty("--tail-x", `${tailX(s, box)}px`);
  }

  remove(): void {
    this.el.remove();
    this.bubble.remove();
  }

  /** Adopt a (validated) avatar: its colour becomes the pet's accent unless the user set one. */
  setAvatar(av: Avatar | null): void {
    if (!av || (this.avatar && this.avatar.shape === av.shape && this.avatar.color === av.color)) return;
    this.avatar = av;
    this.el.dataset.avatar = `${av.shape}/${av.color}`;
    const accent = this.accentOverride ?? accentHex(av.color, this.art?.palette ?? null);
    if (accent !== this.accent) {
      this.accent = accent;
      this.el.style.setProperty("--accent", accent);
      this.bubble.style.setProperty("--accent", accent);
    }
  }

  update(e: StateEvent, now: number, toastMs = 5000): void {
    // An event without an avatar keeps the one we have (bots re-send the latest anyway).
    this.setAvatar(parseAvatar(e.avatar));
    if (e.agent_name && e.agent_name !== this.name) {
      this.name = e.agent_name;
      this.label.textContent = e.agent_name;
      this.el.title = `Open ${e.agent_name} in Grok Bot`;
    }
    const at = Math.min(now, Date.parse(e.received_at) || now);
    const fresh = now - at < 10_000;
    const prev = this.sessions.get(e.session);
    this.sessions.delete(e.session);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const message = carryMessage(prev, e.state, typeof e.message === "string" ? e.message : undefined);
    this.sessions.set(e.session, { state: e.state, at, ...eventOrder(e.ts, e.seq, at), n: ++this.arrivals, message });
    this.lastActivity = Math.max(this.lastActivity, at);
    // "done" plays once per fresh done event; catch-up replays don't re-trigger it.
    if (e.state === "done" && fresh) this.doneSeq++;
    else if (e.state === "done") this.playedDoneSeq = this.doneSeq;
    if (e.message && fresh) this.toast(e.message, toastMs, now);
  }

  /** Newest message replaces the previous one; one toast per pet (shown on the next frame). */
  toast(text: string, ms: number, now = Date.now()): void {
    this.toastMsg = { text, until: now + ms };
  }

  /**
   * Show the toast, or the persistent working label, or nothing (presence.ts decides). Called
   * every frame; touches the DOM only when what's shown changes.
   */
  private syncBubble(now: number, shown: AnimState, staleMs: number): void {
    const next: BubbleView = this.slot
      ? bubbleView(this.toastMsg, stickyLabel(shown, this.shownSessions, now, staleMs), now)
      : { mode: "hidden" };
    if (this.toastMsg && now >= this.toastMsg.until) this.toastMsg = null;
    const tone = shown === "needs_you" || shown === "error" ? shown : "";
    if ((this.bubble.dataset.tone ?? "") !== tone) {
      if (tone) this.bubble.dataset.tone = tone;
      else delete this.bubble.dataset.tone;
    }
    if (sameView(next, this.view)) return;
    this.view = next;
    this.bubble.classList.toggle("sticky", next.mode === "sticky");
    if (next.mode === "hidden") {
      this.bubble.classList.remove("show");
      return;
    }
    this.bubbleText.textContent = next.text; // textContent: never interpreted as HTML
    this.bubble.title = next.full;
    this.bubble.style.width = ""; // re-measure at natural width
    this.positionToast();
    this.bubble.classList.add("show");
  }

  renderState(now: number, cfg: DeskPetConfig, offline: boolean): AnimState {
    if (offline) {
      this.shownSessions = [];
      return "offline";
    }
    const d = displayFor(this.sessions.values(), now, cfg.staleActiveMs);
    this.shownSessions = d.sessions;
    let s: PetState = d.state;
    if (s === "done") {
      if (this.playedDoneSeq < this.doneSeq) return "done";
      s = "idle";
    } else {
      this.playedDoneSeq = this.doneSeq; // a done hidden behind a higher state is not replayed later
    }
    if (s === "idle" && now - this.lastActivity > cfg.sleepAfterMs) s = "sleeping";
    return s;
  }

  /** Canvas backing size: 32 for the robot, the avatar geometry's size for avatars. */
  private setMode(mode: "robot" | "avatar", backing: number): void {
    this.mode = mode;
    this.el.dataset.art = mode;
    if (this.canvas.width !== backing || this.canvas.height !== backing) {
      this.canvas.width = backing;
      this.canvas.height = backing;
      this.ctx.imageSmoothingEnabled = false;
      this.scratch.width = backing;
      this.scratch.height = backing;
      this.paint.imageSmoothingEnabled = false;
      this.shownPixels = null;
      this.paintedKey = "";
    }
  }

  /** Draw the Grok Bot avatar. False when its art isn't available (caller draws the robot). */
  private drawAvatarFrame(want: AnimState, now: number): boolean {
    const av = this.avatar;
    const art = this.art;
    const slot = this.slot;
    if (!av || !art || !slot || !art.has(av.shape)) return false;
    const sizes = art.manifest?.shapes[av.shape];
    const g = avatarGeometry(slot.spriteSize, sizes?.["2x"]?.frameSize ?? 36, sizes?.["1x"]?.frameSize ?? 18);
    const strip = art.strip(av.shape, g.res, colorHex(av.color, art.palette));
    if (strip === null) return false;
    this.setMode("avatar", g.backing);
    if (strip === "pending") {
      this.paintIf("pending", () => this.paint.clearRect(0, 0, g.backing, g.backing));
      return true;
    }
    const t = now - this.anim.start;
    if (want === "done" && t >= AVATAR_DONE_MS) this.playedDoneSeq = this.doneSeq;
    const cue = Pet.reducedMotion ? calmCue(avatarCue(want, t, g)) : avatarCue(want, t, g);
    const face = this.face.frameAt(cue.face, now);
    const key = `avatar|${g.backing}|${g.res}|${av.shape}|${colorHex(av.color, art.palette)}|${face}|${JSON.stringify(cue)}`;
    this.paintIf(key, () => drawAvatar(this.paint, strip, g, face, cue));
    return true;
  }

  get artMode(): "robot" | "avatar" {
    return this.mode;
  }

  draw(bank: SpriteBank, now: number, cfg: DeskPetConfig, offline: boolean): void {
    if (!this.slot) return;
    const want = this.renderState(now, cfg, offline);
    if (want !== this.anim.state) this.anim = { state: want, start: now };
    if (this.el.dataset.state !== want) this.el.dataset.state = want;
    this.syncBubble(now, want, cfg.staleActiveMs);
    if (!this.drawAvatarFrame(want, now)) this.drawRobotFrame(bank, want, now);
  }

  /** Paint the scratch frame and show it, unless it was already painted from the same inputs. */
  private paintIf(key: string, paint: () => void): void {
    if (key === this.paintedKey) return;
    this.paintedKey = key;
    paint();
    this.present();
  }

  /** Copy the scratch frame to the visible canvas if any pixel differs from what is shown. */
  private present(): void {
    const { width: w, height: h } = this.scratch;
    const px = new Uint32Array(this.paint.getImageData(0, 0, w, h).data.buffer);
    if (this.shownPixels && samePixels(this.shownPixels, px)) return;
    this.shownPixels = px;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(this.scratch, 0, 0);
  }

  private drawRobotFrame(bank: SpriteBank, want: AnimState, now: number): void {
    this.setMode("robot", 32);
    const def = bank.defs[want];
    if (!def) return;
    let frame = Math.floor(((now - this.anim.start) * def.fps) / 1000);
    if (def.loop) frame %= def.frames;
    else if (frame >= def.frames) {
      frame = def.frames - 1;
      if (want === "done") this.playedDoneSeq = this.doneSeq;
    }
    const sheet = bank.sheet(want, this.accent);
    this.paintIf(`robot|${want}|${frame}|${this.accent}|${sheet ? 1 : 0}`, () => {
      this.paint.clearRect(0, 0, 32, 32);
      if (sheet) this.paint.drawImage(sheet, frame * bank.fw, 0, bank.fw, bank.fh, 0, 0, bank.fw, bank.fh);
    });
  }
}
