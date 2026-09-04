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

import { pickBestDistro, recommendCandidate, recommendEnv, scoreCandidate } from "./recommend";

const tool = (name: string, found: boolean) => ({ name, found, path: null, version: null, install_hint: null });

describe("auth-aware recommendation", () => {
  it("prefers the distro that has claude", () => {
    const byDistro = {
      "Ubuntu-24.04": [tool("claude", false), tool("git", true)],
      Ubuntu: [tool("claude", true), tool("codex", true), tool("git", true)],
    };
    expect(pickBestDistro(byDistro, ["Ubuntu-24.04", "Ubuntu"])).toBe("Ubuntu");
  });

  it("recommends the backend where claude is logged in", () => {
    const native = { backend: { kind: "native" as const, wsl_distro: null }, tools: [tool("claude", true)], claudeLoggedIn: false };
    const wsl = { backend: { kind: "wsl" as const, wsl_distro: "Ubuntu" }, tools: [tool("claude", true), tool("git", true)], claudeLoggedIn: true };
    expect(recommendCandidate(native, wsl)).toBe("wsl");
    expect(scoreCandidate(wsl)).toBeGreaterThan(scoreCandidate(native));
  });

  it("falls back to native on ties", () => {
    const native = { backend: { kind: "native" as const, wsl_distro: null }, tools: [tool("claude", true), tool("git", true)], claudeLoggedIn: true };
    const wsl = { backend: { kind: "wsl" as const, wsl_distro: "Ubuntu" }, tools: [tool("claude", true), tool("git", true)], claudeLoggedIn: true };
    expect(recommendCandidate(native, wsl)).toBe("native");
    expect(recommendCandidate(null, null)).toBe("native");
  });
});

describe("recommendEnv", () => {
  const native = (claude: boolean, login: boolean | null) => ({ backend: { kind: "native" as const, wsl_distro: null }, tools: [tool("claude", claude), tool("git", false)], claudeLoggedIn: login });
  const wsl = (claude: boolean, login: boolean | null) => ({ backend: { kind: "wsl" as const, wsl_distro: "Ubuntu" }, tools: [tool("claude", claude), tool("git", true)], claudeLoggedIn: login });
  const managed = (ready: boolean) => (ready ? { backend: { kind: "wsl" as const, wsl_distro: "Vibecoder" }, tools: [tool("claude", true), tool("git", true)], claudeLoggedIn: false } : null);

  it("picks managed when nothing on the PC has claude", () => {
    expect(recommendEnv(native(false, null), wsl(false, null), null)).toBe("managed");
    expect(recommendEnv(null, null, null)).toBe("managed");
  });
  it("keeps a logged-in existing install", () => {
    expect(recommendEnv(native(true, false), wsl(true, true), managed(true))).toBe("wsl");
  });
  it("prefers a ready managed env over a not-logged-in native install", () => {
    expect(recommendEnv(native(true, false), null, managed(true))).toBe("managed");
  });
});
