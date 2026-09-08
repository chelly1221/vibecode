// Pure state machine for the GUI login (CLI runs in a hidden PTY on the Rust side and streams
// LoginEvents). Kept free of React/Tauri so it can be unit-tested.
import type { LoginEvent } from "@/lib/ipc";

export type LoginPhase = "idle" | "starting" | "browser" | "code" | "finished";

export interface LoginState {
  phase: LoginPhase;
  loginId: string | null;
  url: string | null;
  /** Cleaned CLI output, newest last (kept short). */
  lines: string[];
  /** Set once the CLI exited. */
  result: { loggedIn: boolean; account: string | null; code: number | null } | null;
}

export const initialLogin: LoginState = { phase: "idle", loginId: null, url: null, lines: [], result: null };

const MAX_LINES = 12;

export function reduceLogin(state: LoginState, e: LoginEvent): LoginState {
  switch (e.type) {
    case "started":
      return { ...state, phase: "starting", url: null, lines: [], result: null };
    case "url":
      return { ...state, phase: state.phase === "code" ? "code" : "browser", url: state.url ?? e.url };
    case "code_requested":
      return { ...state, phase: "code" };
    case "output":
      return { ...state, lines: [...state.lines, e.line].slice(-MAX_LINES) };
    case "finished":
      return { ...state, phase: "finished", result: { loggedIn: e.logged_in, account: e.account ?? null, code: e.code ?? null } };
  }
}

/** Short Korean status line for the current phase. */
export function loginHint(state: LoginState): string {
  switch (state.phase) {
    case "idle":
      return "";
    case "starting":
      return "로그인 창을 준비하고 있습니다…";
    case "browser":
      return "브라우저에서 로그인을 진행하세요. 창이 열리지 않았다면 아래 버튼으로 여세요.";
    case "code":
      return "브라우저에 표시된 인증 코드를 붙여넣고 확인을 누르세요.";
    case "finished":
      return state.result?.loggedIn ? `로그인되었습니다${state.result.account ? ` · ${state.result.account}` : ""}` : "로그인이 끝나지 않았습니다. 다시 시도하세요.";
  }
}

/** Whether a pasted code looks complete enough to submit. */
export function codeLooksValid(code: string): boolean {
  return code.trim().length >= 8 && !/\s/.test(code.trim());
}
