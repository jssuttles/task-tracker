/**
 * Thin, optional bridge to the Tauri runtime.
 *
 * The frontend is built to run in a plain browser tab (for fast iteration with
 * `npm run dev`) *and* inside the Tauri webview. Every call here degrades
 * gracefully when the Tauri APIs are absent, so the UI never hard-crashes
 * outside the desktop shell — and the check-in card can be designed in a browser
 * without a Rust build in the loop.
 */

import type { VaultPort } from './vault.ts';

/** `true` only when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Show, raise and focus the check-in window.
 *
 * Unlike the sibling calendar overlay, this window needs the *keyboard* — the
 * whole interaction is typing a task and hitting Enter. So it takes focus rather
 * than floating click-through above whatever you were doing.
 *
 * Windows does not grant foreground activation unconditionally
 * (`SetForegroundWindow` is refused for processes without a qualifying input
 * event), so `set_focus` may raise the window without giving it keyboard focus.
 * The Rust side follows up with an attention request; see `src-tauri/src/lib.rs`.
 */
export async function showCheckIn(): Promise<void> {
  await showWindow();
  await requestAttention();
}

/**
 * Show and focus the window, without asking for attention.
 *
 * This is the right entry point for anything the user *initiated* — opening
 * settings from the tray, say. `showCheckIn` adds the attention request because
 * a check-in arrives unbidden from a timer; flashing the taskbar for a window
 * someone just asked for is nagging them about their own click.
 */
export async function showWindow(): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  // Position before show: on a multi-monitor setup the window can otherwise land
  // on the small primary display (laptop) instead of the largest screen.
  await invoke('position_checkin');
  await win.show();
  await win.setFocus();
}

/** Hide the window. */
export async function hideWindow(): Promise<void> {
  if (!isTauri()) return;

  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
}

/**
 * Flash the taskbar/tray entry when the window could not steal focus.
 *
 * This is the honest fallback for the Windows foreground rules above: if we
 * can't take focus, at least be impossible to miss.
 */
export async function requestAttention(): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('request_attention');
}

/**
 * Resize the check-in window, then re-pin it to the corner.
 *
 * A no-op outside Tauri — there's no window to resize in the browser preview.
 * Growing downward/rightward from the top-left margin is what `position_top_left`
 * already does on every show; calling it again after a resize is cheap
 * insurance against a platform that re-centers or clamps the window when its
 * size changes.
 */
export async function setWindowSize(width: number, height: number): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');

  await getCurrentWindow().setSize(new LogicalSize(width, height));
  await invoke('position_checkin');
}

/** Copy text to the system clipboard, falling back to the browser API. */
export async function copyToClipboard(text: string): Promise<void> {
  if (!isTauri()) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
  await writeText(text);
}

/** Reveal the vault folder in the OS file manager. */
export async function openVaultFolder(): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_vault_dir');
}

/** The absolute path of the active vault, for display in settings. */
export async function vaultPath(): Promise<string> {
  if (!isTauri()) return '(browser preview — in-memory vault)';

  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<string>('vault_dir');
}

/** Point the vault at a different folder, creating it if needed. */
export async function setVaultPath(path: string): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('vault_set_dir', { path });
}

/** Enable or disable launch-at-login. */
export async function setAutostart(enabled: boolean): Promise<void> {
  if (!isTauri()) return;

  const { enable, disable } = await import('@tauri-apps/plugin-autostart');
  if (enabled) {
    await enable();
  } else {
    await disable();
  }
}

/** Whether the app is registered to launch at login. */
export async function isAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) return false;

  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return await isEnabled();
}

/** Update the tray's status line so the menu reflects the current day at a glance. */
export async function setTrayStatus(status: string): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_tray_status', { status });
}

/** Subscribe to a tray-emitted event. A no-op in the browser, where there's no tray. */
async function onTrayEvent(event: string, handler: () => void): Promise<void> {
  if (!isTauri()) return;

  const { listen } = await import('@tauri-apps/api/event');
  await listen(event, () => {
    handler();
  });
}

/** Tray "Check in now" — opens the card outside the schedule. */
export function onCheckInRequested(handler: () => void): Promise<void> {
  return onTrayEvent('check-in-now', handler);
}

/** Tray "Copy standup summary". */
export function onStandupRequested(handler: () => void): Promise<void> {
  return onTrayEvent('copy-standup', handler);
}

/** Tray "Copy week for an agent". */
export function onWeekRequested(handler: () => void): Promise<void> {
  return onTrayEvent('copy-week', handler);
}

/** Tray "Open vault folder". */
export function onOpenVaultRequested(handler: () => void): Promise<void> {
  return onTrayEvent('open-vault', handler);
}

/** Tray "Settings". */
export function onSettingsRequested(handler: () => void): Promise<void> {
  return onTrayEvent('open-settings', handler);
}

/** Tray "Team…" — always available, like every other tray item. */
export function onTeamRequested(handler: () => void): Promise<void> {
  return onTrayEvent('open-team', handler);
}

/** Tray "Copy team week for an agent". */
export function onTeamWeekRequested(handler: () => void): Promise<void> {
  return onTrayEvent('copy-team-week', handler);
}

/**
 * Surface an error to the user with a native dialog.
 *
 * Check-ins fire from a timer while the window is hidden, so a `console.error`
 * (or a webview `alert()` from a hidden window) is invisible — exactly when a
 * failed vault write is the thing you most need to know about.
 */
export async function showError(title: string, detail: string): Promise<void> {
  if (!isTauri()) {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${detail}`);
    return;
  }

  const { message } = await import('@tauri-apps/plugin-dialog');
  await message(detail, { title, kind: 'error' });
}

/** A `VaultPort` backed by the Rust vault commands. */
class TauriVault implements VaultPort {
  async read(name: string): Promise<string | null> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('vault_read', { name });
  }

  async write(name: string, contents: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('vault_write', { name, contents });
  }

  async list(): Promise<string[]> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string[]>('vault_list');
  }
}

/**
 * A `VaultPort` over `localStorage`, so `npm run dev` in a browser behaves like
 * the real thing — including carry-over across reloads — with no Rust in the
 * loop.
 */
class BrowserVault implements VaultPort {
  private readonly prefix = 'task-tracker:vault:';

  read(name: string): Promise<string | null> {
    return Promise.resolve(localStorage.getItem(this.prefix + name));
  }

  write(name: string, contents: string): Promise<void> {
    localStorage.setItem(this.prefix + name, contents);
    return Promise.resolve();
  }

  list(): Promise<string[]> {
    const names: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(this.prefix) === true) names.push(key.slice(this.prefix.length));
    }
    return Promise.resolve(names);
  }
}

/** The vault appropriate to the current runtime. */
export function createVault(): VaultPort {
  return isTauri() ? new TauriVault() : new BrowserVault();
}

/** Read `settings.json` from the app config dir, or `null` if unset. */
export async function loadSettingsJson(): Promise<string | null> {
  if (!isTauri()) return localStorage.getItem('task-tracker:settings');

  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<string | null>('settings_load');
}

/** Write `settings.json` to the app config dir. */
export async function saveSettingsJson(contents: string): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem('task-tracker:settings', contents);
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('settings_save', { contents });
}
