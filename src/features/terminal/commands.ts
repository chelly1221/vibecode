// Pure helpers that turn an intent (login, install hint) into a PtySpec-like command.
// Kept free of React/Tauri so they can be unit-tested.
import type { Provider } from "@/lib/bindings/Provider";

export interface TerminalCommand {
  program: string | null;
  args: string[];
  title: string;
}

/** Command that starts the provider's interactive login flow. */
export function loginCommand(provider: Provider): TerminalCommand {
  if (provider === "claude") {
    // `claude` with no prompt opens the login flow when not authenticated.
    return { program: "claude", args: [], title: "Claude 로그인" };
  }
  return { program: "codex", args: ["login"], title: "Codex 로그인" };
}

/**
 * Run an install hint (a PowerShell one-liner) in a PowerShell window that stays open afterwards
 * so the user can read the output.
 */
export function installCommand(hint: string, title = "설치"): TerminalCommand {
  return { program: "powershell.exe", args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", hint], title };
}

/** Plain interactive PowerShell. */
export function shellCommand(): TerminalCommand {
  return { program: null, args: [], title: "터미널" };
}
