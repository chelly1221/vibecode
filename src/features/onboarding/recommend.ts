// Pure helpers for the onboarding backend recommendation.
import type { BackendConfig } from "@/lib/bindings/BackendConfig";
import type { BackendKind } from "@/lib/bindings/BackendKind";
import type { ToolStatus } from "@/lib/bindings/ToolStatus";

export function toolFound(tools: ToolStatus[] | null | undefined, name: string): boolean {
  return !!tools?.find((t) => t.name === name && t.found);
}

/** One place agents could run, with what we learned about it. */
export interface Candidate {
  backend: BackendConfig;
  tools: ToolStatus[] | null;
  /** null = unknown / not checked */
  claudeLoggedIn: boolean | null;
}

/**
 * Score a candidate: a logged-in Claude wins, then an installed Claude, then codex, then git.
 * Native gets a tiny tie-break bonus (no WSL path translation involved).
 */
export function scoreCandidate(c: Candidate | null): number {
  if (!c || !c.tools) return -1;
  let s = 0;
  if (toolFound(c.tools, "claude")) s += 100;
  if (c.claudeLoggedIn) s += 1000;
  if (toolFound(c.tools, "codex")) s += 10;
  if (toolFound(c.tools, "git")) s += 5;
  if (c.backend.kind === "native") s += 1;
  return s;
}

/** Among WSL distros, pick the one where the tools live (claude first). */
export function pickBestDistro(byDistro: Record<string, ToolStatus[] | null>, distros: string[]): string | null {
  if (distros.length === 0) return null;
  let best = distros[0];
  let bestScore = -1;
  for (const d of distros) {
    const score = scoreCandidate({ backend: { kind: "wsl", wsl_distro: d }, tools: byDistro[d] ?? null, claudeLoggedIn: null });
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Recommend where agents should run. */
export function recommendCandidate(native: Candidate | null, wsl: Candidate | null): BackendKind {
  const n = scoreCandidate(native);
  const w = scoreCandidate(wsl);
  if (w > n) return "wsl";
  return "native";
}

export type EnvChoice = "native" | "wsl" | "managed";

/**
 * Three-way recommendation. A logged-in Claude anywhere wins; otherwise an installed Claude;
 * if nothing on the PC has Claude, the app-owned environment is the way to go.
 */
export function recommendEnv(native: Candidate | null, wsl: Candidate | null, managed: Candidate | null): EnvChoice {
  const hasClaude = (c: Candidate | null) => !!c && toolFound(c.tools, "claude");
  if (!hasClaude(native) && !hasClaude(wsl) && !hasClaude(managed)) return "managed";
  const scored: [EnvChoice, number][] = [
    ["managed", scoreCandidate(managed) + (managed ? 2 : 0)],
    ["native", scoreCandidate(native)],
    ["wsl", scoreCandidate(wsl)],
  ];
  scored.sort((a, b) => b[1] - a[1]);
  return scored[0][0];
}

/**
 * Legacy tool-only recommendation (kept for callers/tests without auth info):
 * prefer the backend where `claude` is installed; if both (or neither) have it, prefer Native
 * unless WSL is the only one with git too.
 */
export function recommendBackend(native: ToolStatus[] | null, wsl: ToolStatus[] | null): BackendKind {
  const nativeClaude = toolFound(native, "claude");
  const wslClaude = toolFound(wsl, "claude");
  if (wslClaude && !nativeClaude) return "wsl";
  if (nativeClaude && !wslClaude) return "native";
  if (nativeClaude && wslClaude) {
    if (!toolFound(native, "git") && toolFound(wsl, "git")) return "wsl";
    return "native";
  }
  if (wsl && toolFound(wsl, "git") && !toolFound(native, "git")) return "wsl";
  return "native";
}

/** Tools that matter most; shown first in the table. */
export const PRIMARY_TOOLS = ["claude", "codex", "git", "node", "npm"];

export function sortTools(tools: ToolStatus[]): ToolStatus[] {
  const rank = (n: string) => {
    const i = PRIMARY_TOOLS.indexOf(n);
    return i === -1 ? 100 : i;
  };
  return [...tools].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
