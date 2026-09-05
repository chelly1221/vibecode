// Pure helpers mirroring core::toolchain for the UI: when a project is developed from WSL but must
// produce a Windows program, backend commands go through the Windows shims (npm.cmd, cargo.exe ...).
import type { BackendKind } from "@/lib/bindings/BackendKind";
import type { StackInfo, TargetOs, WindowsToolStatus } from "@/lib/ipc";

export function windowsToolchainApplies(backend: BackendKind, target: TargetOs | null | undefined, stack: Pick<StackInfo, "windows_toolchain"> | null | undefined): boolean {
  return backend === "wsl" && (target === "windows" || target === "cross_desktop") && !!stack && stack.windows_toolchain.length > 0;
}

const SHIMS: Record<string, string> = {
  npm: "npm.cmd",
  npx: "npx.cmd",
  node: "node.exe",
  cargo: "cargo.exe",
  rustup: "rustup.exe",
  rustc: "rustc.exe",
  dotnet: "dotnet.exe",
  go: "go.exe",
};

/** `npm run dev` → `npm.cmd run dev`; commands that have no shim are returned unchanged. */
export function rewriteForWindowsToolchain(cmd: string): string {
  const m = /^(\s*)(\S+)([\s\S]*)$/.exec(cmd);
  if (!m) return cmd;
  const shim = SHIMS[m[2]];
  return shim ? `${m[1]}${shim}${m[3]}` : cmd;
}

/** Toolchains still missing from a status list. */
export function missingToolchains(statuses: WindowsToolStatus[]): WindowsToolStatus[] {
  return statuses.filter((s) => !s.found);
}
