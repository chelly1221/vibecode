import { describe, expect, it, vi } from "vitest";
import type { RateLimitWindow } from "@/lib/ipc";
import { emptyAccount, mergeReport, mergeSamples, orderedWindows, pushPoint, usageKey, useUsageStore } from "@/stores/usage";
import { remainingPercent, reportAge, resetCountdown, usageLevel } from "@/features/usage/format";

vi.mock("@/lib/ipc", () => ({ ipc: { usage: { latest: vi.fn(), history: vi.fn(), refresh: vi.fn() } } }));

const win = (id: string, used: number, minutes = 300): RateLimitWindow => ({ id, label: id === "five_hour" ? "5시간" : "1주일", used_percent: used, resets_at: 1_800_000_000, window_minutes: minutes });

describe("usage store merge", () => {
  it("keeps the latest value per window and builds a time series", () => {
    let acc = emptyAccount("claude", "a1");
    acc = mergeReport(acc, [win("five_hour", 10), win("seven_day", 5, 10_080)], 1000);
    acc = mergeReport(acc, [win("five_hour", 12)], 1100);
    expect(acc.windows.five_hour.window.used_percent).toBe(12);
    expect(acc.windows.five_hour.observedAt).toBe(1100);
    expect(acc.windows.five_hour.points.map((p) => p.used)).toEqual([10, 12]);
    expect(acc.windows.seven_day.points).toHaveLength(1);
    expect(orderedWindows(acc).map((w) => w.window.id)).toEqual(["five_hour", "seven_day"]);
  });

  it("skips identical repeats close together and keeps series sorted when history arrives late", () => {
    let pts = pushPoint([], { t: 1000, used: 10 });
    pts = pushPoint(pts, { t: 1010, used: 10 }); // same value 10s later → skipped
    expect(pts).toHaveLength(1);
    pts = pushPoint(pts, { t: 1200, used: 10 }); // same value later → kept (flat line still needs anchors)
    expect(pts).toHaveLength(2);
    pts = pushPoint(pts, { t: 500, used: 3 }); // older history point
    expect(pts.map((p) => p.t)).toEqual([500, 1000, 1200]);
    pts = pushPoint(pts, { t: 500, used: 3 }); // exact duplicate
    expect(pts).toHaveLength(3);
  });

  it("does not let an older sample overwrite the live value", () => {
    let acc = mergeReport(emptyAccount("codex", null), [win("primary", 40)], 2000);
    acc = mergeSamples(acc, [{ provider: "codex", account_id: null, window: win("primary", 30), observed_at: 1500 }]);
    expect(acc.windows.primary.window.used_percent).toBe(40);
    expect(acc.windows.primary.points.map((p) => p.used)).toEqual([30, 40]);
  });

  it("ingest routes by provider + account", () => {
    useUsageStore.setState({ accounts: {} });
    useUsageStore.getState().ingest("claude", "acc", [win("five_hour", 55)], 3000);
    useUsageStore.getState().ingest("claude", "acc", [], 3001);
    const acc = useUsageStore.getState().accounts[usageKey("claude", "acc")];
    expect(acc.windows.five_hour.window.used_percent).toBe(55);
    expect(Object.keys(useUsageStore.getState().accounts)).toEqual(["claude:acc"]);
  });
});

describe("usage formatting", () => {
  it("remaining / level / countdown / age", () => {
    expect(remainingPercent(37.25)).toBe(62.8);
    expect(remainingPercent(140)).toBe(0);
    expect(usageLevel(10)).toBe("ok");
    expect(usageLevel(75)).toBe("warn");
    expect(usageLevel(95)).toBe("critical");
    expect(resetCountdown(null, 0)).toBeNull();
    expect(resetCountdown(1000, 2000)).toBe("곧 초기화");
    expect(resetCountdown(2000 + 2 * 3600 + 15 * 60, 2000)).toBe("2시간 15분 후 초기화");
    expect(resetCountdown(2000 + 3 * 86_400 + 3600, 2000)).toBe("3일 1시간 후 초기화");
    expect(resetCountdown(2000 + 30, 2000)).toBe("1분 후 초기화");
    expect(reportAge(1000, 1030)).toBe("방금");
    expect(reportAge(1000, 1000 + 5 * 60)).toBe("5분 전");
    expect(reportAge(1000, 1000 + 3 * 3600)).toBe("3시간 전");
  });
});

describe("usage strip captions", () => {
  it("shortens window labels", async () => {
    const { shortWindowLabel } = await import("@/features/usage/UsageStrip");
    expect(shortWindowLabel("5시간", 300)).toBe("5h");
    expect(shortWindowLabel("1주일", 10_080)).toBe("7d");
    expect(shortWindowLabel("3일", 4320)).toBe("3d");
    expect(shortWindowLabel("2시간", 120)).toBe("2h");
    expect(shortWindowLabel("단기", null)).toBe("단기");
  });
});
