// Pure helpers for the onboarding backend recommendation.
import type { BackendKind } from "@/lib/bindings/BackendKind";
import type { ToolStatus } from "@/lib/bindings/ToolStatus";

export function toolFound(tools: ToolStatus[] | null | undefined, name: string): boolean {
  return !!tools?.find((t) => t.name === name && t.found);
}

/**
 * Recommend where agents should run: prefer the backend where `claude` is installed;
 * if both (or neither) have it, prefer Native unless WSL is the only one with git too.
 */
export function recommendBackend(native: ToolStatus[] | null, wsl: ToolStatus[] | null): BackendKind {
  const nativeClaude = toolFound(native, "claude");
  const wslClaude = toolFound(wsl, "claude");
  if (wslClaude && !nativeClaude) return "wsl";
  if (nativeClaude && !wslClaude) return "native";
  if (nativeClaude && wslClaude) {
    // Both: prefer the one that also has git (Claude's Bash tool needs it natively).
    if (!toolFound(native, "git") && toolFound(wsl, "git")) return "wsl";
    return "native";
  }
  // Neither has claude yet: WSL when it exists and has git, else native.
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
