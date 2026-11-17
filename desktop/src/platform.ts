// Thin wrapper so the same frontend runs inside Tauri and as a plain web prototype (vite).

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The Mac's preferred languages, as the webview reports them (first = the system language).
 * Dev builds take `?lang=ko` to preview another language.
 */
export function preferredLanguages(): readonly string[] {
  const forced = import.meta.env.DEV ? new URLSearchParams(location.search).get("lang") : null;
  if (forced) return [forced];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export async function openExternal(url: string): Promise<void> {
  if (inTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function startWindowDrag(): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

/** Call a Rust command (desktop app only; the web prototype gets undefined). */
export async function invokeCmd<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T | undefined> {
  if (!inTauri) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Quit the app (every pet window too), not just this window. */
export async function quitApp(): Promise<void> {
  if (!inTauri) {
    window.close();
    return;
  }
  await invokeCmd("app_quit");
}

/** This window's label ("main", "pet-<agent_id>"); "main" in the web prototype. */
export async function windowLabel(): Promise<string> {
  if (!inTauri) return "main";
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

/** Show or hide this window (no-op if it already is). */
export async function setWindowVisible(visible: boolean): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if ((await w.isVisible()) === visible) return;
  await (visible ? w.show() : w.hide());
}

/** Resize this window (logical px; no-op if it already has that size). */
export async function setWindowSize(width: number, height: number): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  const [inner, scale] = await Promise.all([w.innerSize(), w.scaleFactor()]);
  const cur = inner.toLogical(scale);
  if (Math.round(cur.width) === width && Math.round(cur.height) === height) return;
  await w.setSize(new LogicalSize(width, height));
}

/** The app version ("" in the web prototype). */
export async function appVersion(): Promise<string> {
  if (!inTauri) return "";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Tell every window (the pets) that the saved settings changed. */
export async function broadcast(event: string, payload: unknown = null): Promise<void> {
  if (!inTauri) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload);
}

/**
 * Listen to an app event; returns the unlisten function (a no-op in the web prototype). With
 * `target` (a window label) only events sent to that window arrive, not every window's.
 */
export async function onEvent<T>(event: string, handler: (payload: T) => void, target?: string): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload), target ? { target } : undefined);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
