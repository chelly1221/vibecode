import { describe, expect, it } from "vitest";
import type { ToolStatus } from "@/lib/bindings/ToolStatus";
import { recommendBackend, sortTools } from "./recommend";

const t = (name: string, found: boolean): ToolStatus => ({ name, found, path: null, version: null, install_hint: null });

describe("recommendBackend", () => {
  it("prefers WSL when claude is only there (this dev machine)", () => {
    expect(recommendBackend([t("claude", false), t("git", false)], [t("claude", true), t("git", true)])).toBe("wsl");
  });
  it("prefers native when claude is only native", () => {
    expect(recommendBackend([t("claude", true)], [t("claude", false)])).toBe("native");
  });
  it("falls back to native when nothing is found", () => {
    expect(recommendBackend([], null)).toBe("native");
  });
  it("both: native unless git is WSL-only", () => {
    expect(recommendBackend([t("claude", true), t("git", true)], [t("claude", true), t("git", true)])).toBe("native");
    expect(recommendBackend([t("claude", true), t("git", false)], [t("claude", true), t("git", true)])).toBe("wsl");
  });
});

describe("sortTools", () => {
  it("puts primary tools first", () => {
    const names = sortTools([t("zsh", true), t("git", true), t("claude", true), t("cargo", true)]).map((x) => x.name);
    expect(names).toEqual(["claude", "git", "cargo", "zsh"]);
  });
});
