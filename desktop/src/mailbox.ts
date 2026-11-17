// The v2 private mailbox, as seen from the UI. The client lives in Rust
// (src-tauri/src/mailbox.rs): ntfy SSE, XChaCha20-Poly1305 decrypt, replay checks. The webview
// gets status and state events and, only when it asks to show the paste line, the dp2 code.
//
//   TauriMailbox  the desktop app.
//   NoMailbox     browser prototype (vite, no Rust side): no pairing, no network.
import { isStateEvent, type ConnStatus, type StateEvent } from "./events.ts";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface MailboxHandlers {
  onState(e: StateEvent): void;
  onStatus(s: ConnStatus, detail?: string): void;
}

export interface Mailbox {
  readonly supported: boolean;
  status(): Promise<{ paired: boolean; mailbox: string | null }>;
  /** Fresh topic + key (replacing any old pairing), subscribed at once. Returns the dp2 code. */
  pairNew(mailboxUrl: string, h: MailboxHandlers): Promise<string>;
  /** The current dp2 code, to show the paste line again. */
  code(): Promise<string | null>;
  /** Subscribe with the stored pairing. False when there is none. */
  start(h: MailboxHandlers): Promise<boolean>;
  stop(): void;
  /** Stop and delete topic + key. */
  unpair(): Promise<void>;
  reconnectNow(): void;
}

export class TauriMailbox implements Mailbox {
  readonly supported = true;
  private unlisten: Array<() => void> = [];

  private async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const { invoke } = (await import("@tauri-apps/api/core")) as { invoke: Invoke };
    return invoke<T>(cmd, args);
  }

  status(): Promise<{ paired: boolean; mailbox: string | null }> {
    return this.invoke("v2_status");
  }

  private async attach(h: MailboxHandlers): Promise<void> {
    this.detach();
    const { listen } = await import("@tauri-apps/api/event");
    this.unlisten = await Promise.all([
      listen<{ status: ConnStatus; detail?: string }>("mailbox:status", (e) => h.onStatus(e.payload.status, e.payload.detail)),
      listen<unknown>("mailbox:state", (e) => {
        if (isStateEvent(e.payload)) h.onState(e.payload);
      }),
    ]);
  }

  async pairNew(mailboxUrl: string, h: MailboxHandlers): Promise<string> {
    await this.attach(h); // listen first: the Rust side subscribes immediately
    try {
      return await this.invoke<string>("v2_pair_new", { mailboxUrl });
    } catch (e) {
      this.detach();
      throw e;
    }
  }

  async code(): Promise<string | null> {
    return (await this.invoke<string | null>("v2_pairing_code").catch(() => null)) ?? null;
  }

  async start(h: MailboxHandlers): Promise<boolean> {
    await this.attach(h);
    const ok = await this.invoke<boolean>("v2_stream_start").catch(() => false);
    if (!ok) this.detach();
    return ok;
  }

  stop(): void {
    this.detach();
    void this.invoke("v2_stream_stop").catch(() => {});
  }

  async unpair(): Promise<void> {
    this.detach();
    await this.invoke("v2_unpair").catch(() => {});
  }

  reconnectNow(): void {
    void this.invoke("v2_reconnect_now").catch(() => {});
  }

  private detach(): void {
    for (const u of this.unlisten.splice(0)) u();
  }
}

/** Browser prototype: v2 needs the desktop app (decryption and keys live in Rust). */
export class NoMailbox implements Mailbox {
  readonly supported = false;
  async status(): Promise<{ paired: boolean; mailbox: string | null }> {
    return { paired: false, mailbox: null };
  }
  async pairNew(): Promise<string> {
    throw new Error("The private mailbox (v2) needs the desktop app");
  }
  async code(): Promise<string | null> {
    return null;
  }
  async start(): Promise<boolean> {
    return false;
  }
  stop(): void {}
  async unpair(): Promise<void> {}
  reconnectNow(): void {}
}
