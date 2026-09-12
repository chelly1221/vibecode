// Formatting helpers for the usage panel (pure, unit-tested).

export function remainingPercent(used: number): number {
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
}

/** "2시간 15분 후 초기화" style countdown; null when the reset time is unknown. */
export function resetCountdown(resetsAt: number | null | undefined, nowSecs: number): string | null {
  if (!resetsAt) return null;
  const diff = resetsAt - nowSecs;
  if (diff <= 0) return "곧 초기화";
  const days = Math.floor(diff / 86_400);
  const hours = Math.floor((diff % 86_400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}일 ${hours}시간 후 초기화`;
  if (hours > 0) return `${hours}시간 ${mins}분 후 초기화`;
  return `${Math.max(1, mins)}분 후 초기화`;
}

/** Local clock label for a reset time. */
export function resetClock(resetsAt: number | null | undefined): string | null {
  if (!resetsAt) return null;
  const d = new Date(resetsAt * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })} ${hm}`;
}

/** Status of a window by how much is left. */
export function usageLevel(used: number): "ok" | "warn" | "critical" {
  if (used >= 90) return "critical";
  if (used >= 70) return "warn";
  return "ok";
}

/** "3분 전" style age of the latest report. */
export function reportAge(observedAt: number, nowSecs: number): string {
  const diff = Math.max(0, nowSecs - observedAt);
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86_400)}일 전`;
}

/** Axis tick label for the chart depending on the visible range. */
export function timeTick(t: number, rangeHours: number): string {
  const d = new Date(t * 1000);
  if (rangeHours <= 24) return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

/** Series colour per window slot (validated categorical palette for the dark surface). */
export const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70"] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)];
}
