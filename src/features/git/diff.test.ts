import { describe, expect, it } from "vitest";
import { classifyDiffLine, diffStats, parseDiff } from "./diff";

const SAMPLE = `diff --git a/a.txt b/a.txt
index 1111..2222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
+new
\\ No newline at end of file
`;

describe("classifyDiffLine", () => {
  it("distinguishes headers from content", () => {
    expect(classifyDiffLine("--- a/a.txt")).toBe("meta");
    expect(classifyDiffLine("+++ b/a.txt")).toBe("meta");
    expect(classifyDiffLine("-old")).toBe("del");
    expect(classifyDiffLine("+new")).toBe("add");
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("hunk");
    expect(classifyDiffLine(" ctx")).toBe("ctx");
    expect(classifyDiffLine("---")).toBe("del"); // a real removed line containing dashes
  });
});

describe("parseDiff / diffStats", () => {
  it("parses and counts", () => {
    const lines = parseDiff(SAMPLE);
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add", "meta"]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });
  it("handles CRLF and empty input", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("+a\r\n-b\r\n").map((l) => l.text)).toEqual(["+a", "-b"]);
  });
});
