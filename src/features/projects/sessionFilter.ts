// Pure helpers for the session list (search + archive visibility).
import type { SessionRecord } from "@/lib/ipc";

export function filterSessions(sessions: SessionRecord[], query: string, showArchived: boolean): SessionRecord[] {
  const q = query.trim().toLowerCase();
  return sessions.filter((s) => (showArchived || !s.archived) && (!q || (s.title || "").toLowerCase().includes(q)));
}

/** Safe default file name for a Markdown export. */
export function exportFileName(title: string): string {
  const base = (title || "session").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "session";
  return `${base}.md`;
}
