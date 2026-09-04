// Desktop notifications + taskbar attention for events that happen while the window is unfocused.
// Safe to call outside Tauri (no-ops) and never throws.

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let permission: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permission !== null) return permission;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    permission = granted;
  } catch {
    permission = false;
  }
  return permission;
}

/** Show a system notification and flash the taskbar entry. */
export async function notify(title: string, body: string): Promise<void> {
  if (!inTauri()) return;
  try {
    if (await ensurePermission()) sendNotification({ title, body });
  } catch (e) {
    console.warn("notification failed", e);
  }
  try {
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  } catch {
    /* window API unavailable */
  }
}

/** True when the app window is not the foreground window (or focus cannot be determined). */
export function windowUnfocused(): boolean {
  try {
    return typeof document !== "undefined" && !document.hasFocus();
  } catch {
    return false;
  }
}
