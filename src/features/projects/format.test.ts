import { describe, expect, it } from "vitest";
import { basename, formatRelative } from "./format";

describe("formatRelative", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");
  it("buckets by unit", () => {
    expect(formatRelative("2026-09-04T11:59:40Z", now)).toBe("방금");
    expect(formatRelative("2026-09-04T11:45:00Z", now)).toBe("15분 전");
    expect(formatRelative("2026-09-04T09:00:00Z", now)).toBe("3시간 전");
    expect(formatRelative("2026-09-01T12:00:00Z", now)).toBe("3일 전");
  });
  it("falls back to a date after a month", () => {
    expect(formatRelative("2026-06-01T12:00:00Z", now)).toBe("2026.06.01");
  });
  it("returns empty for invalid input", () => {
    expect(formatRelative("nope", now)).toBe("");
  });
});

describe("basename", () => {
  it("handles both separators", () => {
    expect(basename("C:\\code\\app")).toBe("app");
    expect(basename("C:\\code\\app\\")).toBe("app");
    expect(basename("/home/me/app")).toBe("app");
    expect(basename("app")).toBe("app");
  });
});
