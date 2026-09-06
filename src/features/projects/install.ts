// Pure helpers for the automatic tool install that runs while a project is created
// (mirrors core::projects::install). Kept free of React/Tauri so they can be unit-tested.
import type { InstallKind } from "@/lib/bindings/InstallKind";
import type { InstallStatus } from "@/lib/bindings/InstallStatus";
import type { ToolStatus, WindowsToolStatus } from "@/lib/ipc";

export interface InstallItem {
  name: string;
  label: string;
  kind: InstallKind;
  status: InstallStatus;
  message: string | null;
  command: string | null;
}

export type InstallEvent = Omit<InstallItem, "status"> & { status: InstallStatus; index: number; total: number };

/** Upsert one install event into the list (events for one tool arrive as running → done/failed/skipped). */
export function applyInstallEvent(items: InstallItem[], e: InstallEvent): InstallItem[] {
  const next: InstallItem = { name: e.name, label: e.label, kind: e.kind, status: e.status, message: e.message, command: e.command };
  const i = items.findIndex((it) => it.name === e.name && it.kind === e.kind);
  if (i < 0) return [...items, next];
  const copy = items.slice();
  copy[i] = next;
  return copy;
}

export interface InstallProgressInfo {
  finished: number;
  total: number;
  /** 0–100 for the bar; a running item counts as half a step so the bar moves as soon as work starts. */
  percent: number;
  current: InstallItem | null;
  failed: InstallItem[];
  skipped: InstallItem[];
}

export function installProgress(items: InstallItem[], total: number): InstallProgressInfo {
  const n = Math.max(total, items.length);
  const finished = items.filter((it) => it.status !== "running").length;
  const current = items.find((it) => it.status === "running") ?? null;
  const percent = n === 0 ? 0 : Math.min(100, Math.round(((finished + (current ? 0.5 : 0)) / n) * 100));
  return {
    finished,
    total: n,
    percent,
    current,
    failed: items.filter((it) => it.status === "failed"),
    skipped: items.filter((it) => it.status === "skipped"),
  };
}

/** Human label for a backend tool name (same table as core::projects::install::tool_label). */
export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    node: "Node.js",
    npm: "npm",
    cargo: "Rust (cargo)",
    rustup: "rustup",
    python: "Python 3",
    uv: "uv (Python 패키지 관리자)",
    dotnet: ".NET SDK",
    flutter: "Flutter SDK",
    go: "Go",
    java: "JDK",
    git: "Git",
    gh: "GitHub CLI",
    claude: "Claude Code",
    codex: "Codex CLI",
  };
  return labels[name] ?? name;
}

/** Install hints that are commands (not "see this page" notes). */
export function runnableHint(hint: string | null | undefined): boolean {
  const h = (hint ?? "").trim();
  return h.length > 0 && !h.startsWith("http://") && !h.startsWith("https://");
}

/**
 * What creation will install automatically for a plan, and what the user must install by hand.
 * Tools sharing one install command (node/npm) are listed once.
 */
export function plannedInstalls(windows: WindowsToolStatus[], missing: ToolStatus[]): { auto: string[]; manual: string[]; hasWindows: boolean } {
  const auto: string[] = windows.filter((t) => !t.found).map((t) => t.label);
  const manual: string[] = [];
  const seen = new Set<string>();
  for (const t of missing) {
    if (t.found) continue;
    if (!runnableHint(t.install_hint)) {
      manual.push(toolLabel(t.name));
      continue;
    }
    if (seen.has(t.install_hint!)) continue;
    seen.add(t.install_hint!);
    auto.push(toolLabel(t.name));
  }
  return { auto, manual, hasWindows: windows.some((t) => !t.found) };
}
