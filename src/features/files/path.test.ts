import { describe, expect, it } from "vitest";
import { basename, extOf, formatSize, joinRel, langFromPath, matchesFilter, parentOf } from "./path";

describe("files/path helpers", () => {
  it("joins and splits relative paths", () => {
    expect(joinRel("", "src")).toBe("src");
    expect(joinRel("src", "App.tsx")).toBe("src/App.tsx");
    expect(basename("src/App.tsx")).toBe("App.tsx");
    expect(parentOf("src/App.tsx")).toBe("src");
    expect(parentOf("README.md")).toBe("");
  });
  it("maps extensions to viewer languages", () => {
    expect(langFromPath("a.ts")).toBe("typescript");
    expect(langFromPath("a.tsx")).toBe("tsx");
    expect(langFromPath("lib.rs")).toBe("rust");
    expect(langFromPath("x/y.PY")).toBe("python");
    expect(langFromPath("package.json")).toBe("json");
    expect(langFromPath("notes.md")).toBe("markdown");
    expect(langFromPath("Makefile")).toBe("plain");
    expect(extOf(".gitignore")).toBe("");
  });
  it("filters and formats", () => {
    expect(matchesFilter("App.tsx", "app")).toBe(true);
    expect(matchesFilter("App.tsx", "zzz")).toBe(false);
    expect(matchesFilter("App.tsx", "  ")).toBe(true);
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
  });
});
