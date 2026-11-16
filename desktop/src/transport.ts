// How the UI talks to the relay. Two implementations behind one interface:
//
//   TauriTransport  native app. Rust does all relay HTTP + SSE and keeps the token in the
//                   macOS Keychain; the webview only gets status/state events. No CORS needed.
//   WebTransport    browser prototype (vite). fetch from the page, token in memory only, needs
//                   the relay's DESKPET_CORS_ORIGINS to allow http://localhost:1420.
import { pairStart as webPairStart, StreamClient, unpair as webUnpair, type StreamHandlers } from "./relay.ts";

export interface RelayTransport {
  readonly relayUrl: string;
  hasToken(): Promise<boolean>;
  /** New pairing; the token is stored out of the UI's reach. Returns the human code. */
  pairStart(): Promise<{ code: string; expires_at: string }>;
  /** Revoke at the relay (best effort) and forget the token. */
  unpair(): Promise<void>;
  /** Forget the token locally (after the relay said 401/revoked). */
  forget(): Promise<void>;
  start(h: StreamHandlers): Promise<void>;
  stop(): void;
  /** Network came back / machine woke: skip the backoff wait. */
  reconnectNow(): void;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriTransport implements RelayTransport {
  readonly relayUrl: string;
  private unlisten: Array<() => void> = [];

  constructor(relayUrl: string) {
    this.relayUrl = relayUrl;
  }

  private async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const { invoke } = (await import("@tauri-apps/api/core")) as { invoke: Invoke };
    return invoke<T>(cmd, { relayUrl: this.relayUrl, ...args });
  }

  hasToken(): Promise<boolean> {
    return this.invoke<boolean>("relay_has_token");
  }

  pairStart(): Promise<{ code: string; expires_at: string }> {
    return this.invoke("relay_pair_start");
  }

  async unpair(): Promise<void> {
    this.detach();
    await this.invoke("relay_unpair").catch(() => {});
  }

  async forget(): Promise<void> {
    this.detach();
    await this.invoke("relay_forget").catch(() => {});
  }

  /** One-time M0 migration: move a localStorage token into the keychain. */
  importToken(token: string): Promise<void> {
    return this.invoke("relay_import_token", { token });
  }

  async start(h: StreamHandlers): Promise<void> {
    this.detach();
    const { listen } = await import("@tauri-apps/api/event");
    this.unlisten = await Promise.all([
      listen<{ status: "connecting" | "online" | "offline"; detail?: string }>("relay:status", (e) =>
        h.onStatus(e.payload.status, e.payload.detail),
      ),
      listen<unknown>("relay:state", (e) => {
        const p = e.payload as Parameters<StreamHandlers["onState"]>[0];
        if (p && typeof p === "object" && typeof p.agent_id === "string") h.onState(p);
      }),
      listen<Parameters<StreamHandlers["onPaired"]>[0]>("relay:paired", (e) => h.onPaired(e.payload)),
      listen<Parameters<StreamHandlers["onReady"]>[0]>("relay:ready", (e) => h.onReady(e.payload)),
      listen("relay:unauthorized", () => {
        this.detach();
        h.onUnauthorized();
      }),
    ]);
    const started = await this.invoke<boolean>("relay_stream_start").catch(() => false);
    if (!started) {
      this.detach();
      h.onUnauthorized();
    }
  }

  stop(): void {
    this.detach();
    void this.invoke("relay_stream_stop").catch(() => {});
  }

  reconnectNow(): void {
    void this.invoke("relay_reconnect_now").catch(() => {});
  }

  private detach(): void {
    for (const u of this.unlisten.splice(0)) u();
  }
}

export class WebTransport implements RelayTransport {
  readonly relayUrl: string;
  private token: string | null;
  private client: StreamClient | null = null;

  constructor(relayUrl: string, token: string | null = null) {
    this.relayUrl = relayUrl;
    this.token = token;
  }

  async hasToken(): Promise<boolean> {
    return this.token !== null;
  }

  async pairStart(): Promise<{ code: string; expires_at: string }> {
    const p = await webPairStart(this.relayUrl);
    this.token = p.token;
    return { code: p.code, expires_at: p.expires_at };
  }

  async unpair(): Promise<void> {
    this.stop();
    if (this.token) await webUnpair(this.relayUrl, this.token);
    this.token = null;
  }

  async forget(): Promise<void> {
    this.stop();
    this.token = null;
  }

  async start(h: StreamHandlers): Promise<void> {
    this.stop();
    if (!this.token) {
      h.onUnauthorized();
      return;
    }
    this.client = new StreamClient(this.relayUrl, this.token, h);
    this.client.start();
  }

  stop(): void {
    this.client?.stop();
    this.client = null;
  }

  reconnectNow(): void {
    this.client?.reconnectNow();
  }
}
