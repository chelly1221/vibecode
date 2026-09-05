import { describe, expect, it } from "vitest";
import { missingToolchains, rewriteForWindowsToolchain, windowsToolchainApplies } from "./toolchain";

describe("windows toolchain helpers", () => {
  it("applies only for WSL + Windows targets + stacks that declare one", () => {
    const tauri = { windows_toolchain: ["node", "rust", "msvc"] };
    expect(windowsToolchainApplies("wsl", "windows", tauri)).toBe(true);
    expect(windowsToolchainApplies("wsl", "cross_desktop", tauri)).toBe(true);
    expect(windowsToolchainApplies("native", "windows", tauri)).toBe(false);
    expect(windowsToolchainApplies("wsl", "web", tauri)).toBe(false);
    expect(windowsToolchainApplies("wsl", "windows", { windows_toolchain: [] })).toBe(false);
    expect(windowsToolchainApplies("wsl", "windows", null)).toBe(false);
  });

  it("rewrites the leading program only", () => {
    expect(rewriteForWindowsToolchain("npm run dev")).toBe("npm.cmd run dev");
    expect(rewriteForWindowsToolchain("  cargo test")).toBe("  cargo.exe test");
    expect(rewriteForWindowsToolchain("dotnet")).toBe("dotnet.exe");
    expect(rewriteForWindowsToolchain("flutter run -d web-server")).toBe("flutter run -d web-server");
    expect(rewriteForWindowsToolchain("")).toBe("");
  });

  it("lists missing toolchains", () => {
    const st = (name: string, found: boolean) => ({ name, label: name, found, path: null, version: null, winget_id: "x", shims: [] });
    expect(missingToolchains([st("rust", true), st("msvc", false)]).map((s) => s.name)).toEqual(["msvc"]);
  });
});
