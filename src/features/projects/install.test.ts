import { describe, expect, it } from "vitest";
import { applyInstallEvent, installProgress, plannedInstalls, runnableHint, type InstallEvent, type InstallItem } from "./install";

const ev = (name: string, status: InstallEvent["status"], extra: Partial<InstallEvent> = {}): InstallEvent => ({
  name,
  label: name,
  kind: "backend_tool",
  status,
  message: null,
  command: null,
  index: 1,
  total: 2,
  ...extra,
});

describe("install progress", () => {
  it("upserts events per tool", () => {
    let items: InstallItem[] = [];
    items = applyInstallEvent(items, ev("uv", "running"));
    items = applyInstallEvent(items, ev("uv", "done", { message: "uv 0.5.0" }));
    items = applyInstallEvent(items, ev("rust", "running", { kind: "windows_toolchain" }));
    expect(items.map((i) => `${i.name}:${i.status}`)).toEqual(["uv:done", "rust:running"]);
    expect(items[0].message).toBe("uv 0.5.0");
  });

  it("computes the bar from finished items and the running one", () => {
    const items = [applyInstallEvent([], ev("uv", "done"))[0], applyInstallEvent([], ev("rust", "running"))[0]];
    const p = installProgress(items, 3);
    expect(p.finished).toBe(1);
    expect(p.total).toBe(3);
    expect(p.percent).toBe(50);
    expect(p.current?.name).toBe("rust");
    expect(installProgress([], 0).percent).toBe(0);
    const done = installProgress([applyInstallEvent([], ev("a", "done"))[0], applyInstallEvent([], ev("b", "failed"))[0]], 2);
    expect(done.percent).toBe(100);
    expect(done.failed.map((f) => f.name)).toEqual(["b"]);
  });

  it("lists planned installs once per command and separates manual ones", () => {
    const win = (name: string, found: boolean) => ({ name, label: `${name}-label`, found, path: null, version: null, winget_id: "x", shims: [] });
    const tool = (name: string, hint: string | null) => ({ name, found: false, path: null, version: null, install_hint: hint });
    const hint = "curl nodesource | sudo -E bash - && sudo apt install -y nodejs";
    const p = plannedInstalls([win("rust", false), win("node", true)], [tool("node", hint), tool("npm", hint), tool("flutter", "https://docs.flutter.dev 참고")]);
    expect(p.auto).toEqual(["rust-label", "Node.js"]);
    expect(p.manual).toEqual(["Flutter SDK"]);
    expect(p.hasWindows).toBe(true);
    expect(runnableHint("sudo apt install -y git")).toBe(true);
    expect(runnableHint(null)).toBe(false);
  });
});
