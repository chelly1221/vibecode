// Pure helpers that turn an intent (login, install hint) into a PtySpec-like command
// for the active backend. Kept free of React/Tauri so they can be unit-tested.
import type { BackendKind } from "@/lib/bindings/BackendKind";
import type { Provider } from "@/lib/bindings/Provider";

export interface TerminalCommand {
  program: string | null;
  args: string[];
  title: string;
  /** Run on the Windows host even when the backend is WSL (winget installs). */
  host?: boolean;
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
 * Run an install hint (a shell one-liner) in a shell that stays open afterwards so
 * the user can read the output.
 */
export function installCommand(hint: string, backend: BackendKind, title = "설치"): TerminalCommand {
  if (backend === "wsl") {
    return { program: "bash", args: ["-lc", `${hint}; echo; echo '[완료] Enter 키로 셸을 계속 사용하세요'; exec bash -l`], title };
  }
  return { program: "powershell.exe", args: ["-NoLogo", "-NoExit", "-Command", hint], title };
}

/** Plain interactive shell for the backend. */
export function shellCommand(): TerminalCommand {
  return { program: null, args: [], title: "터미널" };
}

/**
 * Run a PowerShell script on the Windows host regardless of the active backend and keep the
 * window open afterwards (Windows toolchain installs through winget).
 */
export function hostPowershellCommand(script: string, title: string): TerminalCommand {
  return { program: "powershell.exe", args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", script], title, host: true };
}
