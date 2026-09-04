# vibecode (product name: Vibecoder)

Windows desktop (Tauri v2 + Rust + React/TS) GUI for vibe coding with Claude Code, OpenAI Codex and git.
Personal-use app (not distributed). Full design: `docs/PLAN.md`.

## Layout
- `src/` React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui + zustand. `@/` = `src/`.
  - `src/lib/ipc.ts` typed wrappers for every Tauri command (the IPC contract).
  - `src/lib/bindings/` TypeScript types generated from Rust by ts-rs. Never edit by hand.
  - `src/features/{projects,chat,git,settings,terminal,onboarding}/` feature UIs. `src/components/ui/` shadcn.
- `src-tauri/` thin Tauri shell: `commands/*.rs` wrap core calls into `Result<T, String>`.
- `crates/core/` (`vibecode-core`) Tauri-independent logic. Module ownership is listed in `crates/core/src/lib.rs`.
  - `types.rs` is the single source of truth for wire types (`#[derive(TS)]`, exported).
  - `backend/` everything that spawns a process goes through `ExecBackend` (Native or WSL). Paths given to it are Windows paths.

## Build & test (run from WSL, uses the Windows toolchain)
This repo is developed from WSL but compiled with the Windows toolchain so the result is a real Windows exe.
- `cargo.exe check --workspace` / `cargo.exe test -p vibecode-core` (Windows cargo; invoked directly from WSL)
- `npm run build` (Windows node via the nvm4w shim), `npm run tauri build -- --bundles nsis` for the installer
- `npm run tauri dev` opens the app on the Windows desktop
- Regenerate TS bindings after touching `types.rs`: `cargo.exe test -p vibecode-core --test export_bindings`
- Do NOT run `cargo` (Linux) here: no GTK/webkit dev libs in WSL and it would build a Linux binary.

## Conventions
- Add npm packages only with `npm install <pkg>` (Windows node); note it in your report.
- Every Tauri command name appears in `src-tauri/src/commands/mod.rs` AND `src/lib/ipc.ts`. Keep them in sync.
- Streaming to the UI uses `tauri::ipc::Channel<T>`; long-lived state lives in `vibecode_core::AppContext`.
- Adapters must never block the Tokio runtime: use `tokio::process`, `spawn_blocking` for sync libs (rusqlite, portable-pty).
- Windows child processes are spawned via `backend::process::spawn_tracked` (job object + no console window).
- Runtime facts verified 2026-09-04: Claude Code CLI 2.1.260 (`--effort low|medium|high|xhigh|max`,
  `--permission-mode manual|acceptEdits|auto|plan|dontAsk|bypassPermissions`, `--permission-prompts host|none`,
  `--permission-prompt-tool`, `--input-format/--output-format stream-json`, `--include-partial-messages`,
  `--replay-user-messages`, `--resume`, `--fork-session`, `--session-id`, `--max-budget-usd`, `--bare`);
  Codex app-server JSON-RPC (`thread/start|resume|fork`, `turn/start|steer|interrupt`, `model/list`,
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/agentMessage/delta`, ...).
- On this dev machine: Claude Code is installed and logged in inside WSL (`Ubuntu`), not on Windows.
  The app therefore defaults to the WSL backend when `claude` is missing natively but present in WSL.

## Troubleshooting (dev machine)
- If every `*.exe` call from WSL fails with `cannot execute binary file: Exec format error`, the `WSLInterop`
  binfmt entry was lost. Fix without sudo/restart:
  `/init /mnt/c/WINDOWS/system32/wsl.exe wsl.exe -d Ubuntu -u root -e sh -c "echo ':WSLInterop:M::MZ::/init:PF' > /proc/sys/fs/binfmt_misc/register"`
  (`/init <exe> <argv0> <args…>` runs a Windows binary directly; repeat the exe name as argv0).
- GUI verification: start the app with `WSLENV=WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/w WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 cargo.exe tauri dev`,
  then drive it with `node.exe scripts/cdp.mjs eval|shot|run` (Chrome DevTools Protocol; screenshots land in `.tmp/`).
- Managed environment: `crates/core/src/managed/` provisions an app-owned WSL distro `Vibecoder` (user `vibe`, no systemd) under `%LOCALAPPDATA%\Vibecoder`; remove with `wsl --unregister Vibecoder`.
- WSL distros on this machine: `Ubuntu-24.04` (default, no claude) and `Ubuntu` (claude + codex installed, logged in). Pick `Ubuntu`.
