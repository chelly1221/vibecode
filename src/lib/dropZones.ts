// Helpers for Tauri drag-drop events (positions arrive in physical pixels).
export function isOverElement(position: { x: number; y: number } | undefined, el: Element | null): boolean {
  if (!position || !el) return false;
  const dpr = window.devicePixelRatio || 1;
  const x = position.x / dpr;
  const y = position.y / dpr;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** The project sidebar registers dropped folders; other drop handlers should ignore drops over it. */
export const PROJECT_DROP_ZONE = 'aside[data-drop-zone="projects"]';
