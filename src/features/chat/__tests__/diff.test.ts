import { describe, expect, it } from "vitest";
import { collapseUnchanged, diffStats, lineDiff, parseUnifiedDiff, splitLines } from "@/lib/diff";

describe("lineDiff", () => {
  it("marks changed lines and keeps context", () => {
    const d = lineDiff("a\nb\nc\n", "a\nx\nc\n");
    expect(d.map((l) => [l.type, l.text])).toEqual([
      ["context", "a"],
      ["del", "b"],
      ["add", "x"],
      ["context", "c"],
    ]);
    expect(d[0]).toMatchObject({ oldNo: 1, newNo: 1 });
    expect(d[1]).toMatchObject({ oldNo: 2 });
    expect(d[1].newNo).toBeUndefined();
    expect(d[2]).toMatchObject({ newNo: 2 });
    expect(d[3]).toMatchObject({ oldNo: 3, newNo: 3 });
  });

  it("handles pure insertions and deletions", () => {
    expect(lineDiff("", "a\nb").map((l) => l.type)).toEqual(["add", "add"]);
    expect(lineDiff("a\nb", "").map((l) => l.type)).toEqual(["del", "del"]);
    expect(lineDiff("same", "same").map((l) => l.type)).toEqual(["context"]);
  });

  it("finds a common subsequence in the middle", () => {
    const d = lineDiff("1\n2\n3\n4\n5", "1\n3\n4\n6\n5");
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
    expect(d.filter((l) => l.type === "context").map((l) => l.text)).toEqual(["1", "3", "4", "5"]);
  });

  it("splitLines drops the trailing newline and CRs", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("parseUnifiedDiff", () => {
  it("parses hunks with line numbers", () => {
    const text = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -10,3 +10,4 @@ fn x()", " ctx", "-old", "+new", "+more", " tail"].join("\n");
    const d = parseUnifiedDiff(text);
    expect(d[0]).toMatchObject({ type: "hunk" });
    expect(d[1]).toMatchObject({ type: "context", text: "ctx", oldNo: 10, newNo: 10 });
    expect(d[2]).toMatchObject({ type: "del", text: "old", oldNo: 11 });
    expect(d[3]).toMatchObject({ type: "add", text: "new", newNo: 11 });
    expect(d[4]).toMatchObject({ type: "add", text: "more", newNo: 12 });
    expect(d[5]).toMatchObject({ type: "context", text: "tail", oldNo: 12, newNo: 13 });
  });

  it("accepts header-less +/- text", () => {
    const d = parseUnifiedDiff("-a\n+b\n");
    expect(d.map((l) => l.type)).toEqual(["del", "add"]);
  });
});

describe("collapseUnchanged", () => {
  it("collapses long unchanged runs around a change", () => {
    const lines = lineDiff(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 20 }, (_, i) => (i === 10 ? "changed" : `l${i}`)).join("\n"));
    const rows = collapseUnchanged(lines, 2);
    expect(rows[0]).toMatchObject({ type: "skip", count: 8 });
    expect(rows[rows.length - 1]).toMatchObject({ type: "skip", count: 7 });
    const kept = rows.filter((r) => r.type !== "skip").length;
    expect(kept).toBe(2 + 2 + 2); // 2 context before, del+add, 2 context after
  });
});
