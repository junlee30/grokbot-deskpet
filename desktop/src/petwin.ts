// One window per bot: the pure parts the webviews share (no DOM, no Tauri; unit-tested in
// test/petwin.test.ts). The windows themselves are opened, placed and closed by the Rust side
// (src-tauri/src/pet_windows.rs, pets.rs).
import type { StateEvent } from "./events.ts";

/** Same rule as the Rust side (v2 agent ids): `pet-<agent_id>`. */
export const PET_LABEL_PREFIX = "pet-";
const AGENT_ID = /^[a-z0-9_-]{1,64}$/;

export function petLabel(agentId: string): string | null {
  return AGENT_ID.test(agentId) ? PET_LABEL_PREFIX + agentId : null;
}

export function agentOfLabel(label: string): string | null {
  if (!label.startsWith(PET_LABEL_PREFIX)) return null;
  const id = label.slice(PET_LABEL_PREFIX.length);
  return AGENT_ID.test(id) ? id : null;
}

/**
 * A pet window gets its first events twice while it starts up: live (it listens first) and in
 * the backlog Rust kept for it. Each event is applied once; only this agent's events count.
 */
export class EventFeed {
  readonly agentId: string;
  private readonly max: number;
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(agentId: string, max = 256) {
    this.agentId = agentId;
    this.max = max;
  }

  static key(e: StateEvent): string {
    return `${e.session}\u0000${e.seq ?? ""}\u0000${e.ts}\u0000${e.state}\u0000${e.event}`;
  }

  /** True the first time this agent's event is seen. */
  accept(e: StateEvent): boolean {
    if (e.agent_id !== this.agentId) return false;
    const k = EventFeed.key(e);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    this.order.push(k);
    if (this.order.length > this.max) this.seen.delete(this.order.shift()!);
    return true;
  }
}

export type MainView = "pair-start" | "pair-code" | "pets";

/**
 * Whether the main (pairing + settings) window is on screen. With one window per bot it is
 * needed for pairing, for settings, and to say "waiting for your bot" while no pet is there;
 * otherwise only the pets are. (Settings stay reachable: ⚙ on a pet, right-click, menu bar icon.)
 */
export function mainWindowVisible(s: { view: MainView; settingsOpen: boolean; pets: number }): boolean {
  return s.settingsOpen || s.view !== "pets" || s.pets === 0;
}

/** Two RGBA frames (one u32 per pixel) are identical. */
export function samePixels(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
