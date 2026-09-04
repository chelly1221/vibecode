import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@/lib/ipc";
import { exportFileName, filterSessions } from "./sessionFilter";

const mk = (title: string, archived = false): SessionRecord => ({
  id: title,
  project_id: "p",
  provider: "claude",
  external_ref: null,
  title,
  model: null,
  effort: null,
  permission: "full_auto",
  total_cost_usd: 0,
  archived,
  created_at: "2026-01-01T00:00:00Z",
  last_used_at: "2026-01-01T00:00:00Z",
});

describe("session list helpers", () => {
  it("filters by title and hides archived by default", () => {
    const list = [mk("Fix login bug"), mk("Old work", true), mk("login page")];
    expect(filterSessions(list, "LOGIN", false).map((s) => s.title)).toEqual(["Fix login bug", "login page"]);
    expect(filterSessions(list, "", true)).toHaveLength(3);
    expect(filterSessions(list, "", false)).toHaveLength(2);
  });
  it("builds safe export names", () => {
    expect(exportFileName('a/b:c*"d')).toBe("a b c d.md");
    expect(exportFileName("")).toBe("session.md");
  });
});
