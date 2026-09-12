# vibecode (product name: Vibecoder)

Windows desktop (Tauri v2 + Rust + React/TS) GUI for vibe coding with Claude Code, OpenAI Codex and git.
Everything runs natively on Windows (no WSL): claude.exe, codex.cmd, git.exe from Git for Windows.
Multiple people can use named accounts on the same Windows PC, selected per project. Full design: `docs/PLAN.md`.

## Layout
- `src/` React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui + zustand. `@/` = `src/`.
  - `src/lib/ipc.ts` typed wrappers for every Tauri command (the IPC contract).
  - `src/lib/bindings/` TypeScript types generated from Rust by ts-rs. Never edit by hand.
  - `src/features/{projects,chat,git,settings,terminal,onboarding}/` feature UIs. `src/components/ui/` shadcn.
- `src-tauri/` thin Tauri shell: `commands/*.rs` wrap core calls into `Result<T, String>`.
- `crates/core/` (`vibecode-core`) Tauri-independent logic. Module ownership is listed in `crates/core/src/lib.rs`.
  - `types.rs` is the single source of truth for wire types (`#[derive(TS)]`, exported).
  - `backend/` everything that spawns a process goes through `ExecBackend` (host PowerShell/exe, `.cmd` shims via cmd.exe).

## Build & test (run from WSL, uses the Windows toolchain)
This repo is developed from WSL but compiled with the Windows toolchain so the result is a real Windows exe.
- `cargo.exe check --workspace` / `cargo.exe test -p vibecode-core` (Windows cargo; invoked directly from WSL)
- `npm run build` (Windows node via the nvm4w shim), `cargo.exe tauri build --bundles nsis` for the installer
  (`target/release/bundle/nsis/Vibecoder_<ver>_x64-setup.exe`). Its last step fails with "no private key" but the installer is done.
  Sign the updater artifact separately (the build only reads `TAURI_SIGNING_PRIVATE_KEY`, not `*_PATH`, and an empty
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` does not survive WSLENV, so the in-build signing hangs on a console password prompt):
  `cargo.exe tauri signer sign -k "$(cat /mnt/c/Users/<user>/.tauri/vibecoder.key)" -p "" 'C:\code\vibecode\target\release\bundle\nsis\Vibecoder_0.1.0_x64-setup.exe'`
- `npm run tauri dev` opens the app on the Windows desktop
- Regenerate TS bindings after touching `types.rs`: `cargo.exe test -p vibecode-core --test export_bindings`
- Do NOT run `cargo` (Linux) here: no GTK/webkit dev libs in WSL and it would build a Linux binary.

## Conventions
- Add npm packages only with `npm install <pkg>` (Windows node); note it in your report.
- Every Tauri command name appears in `src-tauri/src/commands/mod.rs` AND `src/lib/ipc.ts`. Keep them in sync.
- Streaming to the UI uses `tauri::ipc::Channel<T>`; long-lived state lives in `vibecode_core::AppContext`.
- Adapters must never block the Tokio runtime: use `tokio::process`, `spawn_blocking` for sync libs (rusqlite, portable-pty).
- No WSL code paths: settings have no execution-environment choice; tool detection/install hints are Windows-only
  (`tools::install_hint`, winget). `msvc` (VS Build Tools via vswhere) is a regular tool in `KNOWN_TOOLS` and a stack prerequisite.
- Nothing in the UI hands the user to a terminal. Login: `tools_login_start` runs `claude auth login --claudeai` /
  `codex login` in a hidden PTY (`crates/core/src/tools/login.rs` strips ANSI/OSC-8, extracts the sign-in URL and the
  "paste code" prompt) → `LoginPanel.tsx` (URL button, code input); Claude may finish automatically or request a pasted code; Codex finishes via its
  localhost callback. Installs: `tools_install` streams `ToolInstallEvent`s → inline progress in `ToolsTable` /
  `InstallProgress`. The terminal panel remains an optional feature; `.cmd` shims in the PTY go through `cmd.exe /d /c`.
- Windows child processes are spawned via `backend::process::spawn_tracked` (job object + no console window).
- New project flow: quick mode first (`ProjectWizard` → `StepDescribe` → `projects_ai_plan` → `PlanSummary` → create → `startFirstSession`);
  the six-step wizard stays behind "바꾸기 (고급)". `crates/core/src/projects/ai_plan.rs` builds the prompt/validation.
- Missing stack prerequisites are installed automatically at the start of `projects_create` (`crates/core/src/projects/install.rs`
  runs each install hint in PowerShell, winget with agreements accepted; never fatal). Progress streams as
  `ScaffoldEvent::Install` → progress bar in `InstallProgress.tsx`; the summary screen only lists what will be installed.
  `CreateProjectRequest.install_missing_tools` (advanced wizard switch) turns it off.
- CLAUDE.md and AGENTS.md of every registered project are identical copies, kept so by
  `crates/core/src/projects/docs_sync.rs` (`reconcile`: missing one cloned, newest non-empty content wins; `DocsWatcher`
  on `notify` watches each project root and mirrors after a 400 ms quiet period). Reconcile also runs at app start, project
  registration/selection (`projects_sync_agent_docs`), session start and every turn end. `agent_docs::generate` returns
  the one document written to both files.
- Runtime facts verified 2026-09-04: Claude Code CLI 2.1.260 (`--effort low|medium|high|xhigh|max`,
  `--permission-mode manual|acceptEdits|auto|plan|dontAsk|bypassPermissions`, `--permission-prompts host|none`,
  `--permission-prompt-tool`, `--input-format/--output-format stream-json`, `--include-partial-messages`,
  `--replay-user-messages`, `--resume`, `--fork-session`, `--session-id`, `--max-budget-usd`, `--bare`);
  Codex app-server JSON-RPC (`thread/start|resume|fork`, `turn/start|steer|interrupt`, `model/list`,
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/agentMessage/delta`, ...).
- On this dev machine (since 2026-09-08): Claude Code is installed natively with the official installer at
  `%USERPROFILE%\.local\bin\claude.exe` (auto-updating; settings `claude_bin` points at it because WSL-launched dev builds
  do not see the updated user PATH), Codex via `npm install -g @openai/codex` (`%APPDATA%\npm\codex.cmd`), Git for Windows
  2.55 (`C:\Program Files\Git`). Git for Windows is optional for Claude Code itself (PowerShell tool fallback) but the app's
  git panel/checkpoints need `git.exe`. Integration tests (`*_native.rs`) fall back to the default Git path when `git` is not
  on the test process's PATH.

## Usage graph, quick sessions, auto commit, export
- Subscription usage ("남은 사용량"): Claude Code emits `rate_limit_event` (`rate_limit_info.unifiedWindows.{five_hour,seven_day}` =
  `{utilization 0..1, resetsAt}`) on every API response of a session; Codex app-server sends `account/rateLimits/updated` (account-wide,
  no threadId → `CodexHost` fans it out to every session) and answers `account/rateLimits/read`. Both become `SessionEvent::RateLimits`;
  `SessionManager` fills in the account id and stores rows in `usage_samples` (`crates/core/src/usage.rs`, commands `usage_*`).
  UI: `src/stores/usage.ts` (keyed `provider:accountId`; `orderedWindows` always drops `seven_day_overage_included`, Claude's weekly
  window with paid extra usage), `src/features/usage/`: `UsageStrip` = one transparent 5h gauge of the account in use, floating over the
  left edge of the session area (`<main>` in `App.tsx`), click → detail panel (`UsagePanel`, Ctrl+5 / title bar "사용량") with the 7d
  window and the time-series graph.
  There is no headless usage query for Claude; values refresh while a session works.
- "새 대화" starts immediately with the project defaults (`src/features/chat/quickSession.ts`, reuses `firstSessionConfig`); a missing
  account opens the project account picker (`useAppStore.accountsDialogProjectId`). `NewSessionDialog` stays behind "다른 AI·설정으로 새 대화…".
- Tool cards in the transcript are collapsed by default (`ToolCard.tsx`).
- Auto commit/push after every turn: `AutoGit` (off | commit | commit_push) — `AppSettings.auto_git` is the default, `ProjectRecord.auto_git`
  overrides. `crates/core/src/git/auto.rs` runs after `TurnEnd` (skipped for interrupted turns, serialized per project via
  `AppContext::auto_git_lock`), commit subject = first line of the user's request, outcome = `SessionEvent::AutoGit` → persisted
  `{subtype:"auto_git"}` → `AutoGitMarker`. Manager-originated events go through `SessionManager::emit` (`senders` map).
- "프로그램 내보내기": `[stack.export]` in `stacks.toml` (`build_command` with `{name}`, `artifacts` globs, `format` zip|file, `extension`);
  `crates/core/src/projects/export.rs` builds through the backend shell, collects with `glob`, packages with the `zip` crate
  (a single matched directory is flattened to the zip root). Command `projects_export` streams `ExportEvent`s → `ExportDialog.tsx`
  (project menu). Stacks without a recipe show an explanation instead.

- "새 빌드 적용" (title bar 더 보기 / 설정 > 정보): `crates/core/src/selfbuild.rs`. Installed app: `npm run tauri build -- --no-bundle`
  runs in the source checkout (`AppSettings.dev_repo_path`, else a registered project that is this app, else `C:\code\vibecode`)
  while the app keeps running; on success a detached PowerShell script (`%TEMP%\vibecoder-apply\apply.ps1`, log `apply.log`)
  waits for the pid, copies `target\release\Vibecoder.exe` over the running exe and starts it (`self_build_apply` shuts core
  down and exits). Running from `target\release` itself → the script builds after exit in a visible console. Frontend state
  is `src/stores/selfBuild.ts` (5 s countdown after a successful build), dialog `src/features/settings/ApplyBuildDialog.tsx`.

## Project accounts
- AI work MUST use the installed native Claude Code / Codex CLI and their subscription login. Do not introduce direct AI API calls or API-key login UI.
- `crates/core/src/accounts.rs` stores named profile metadata and project/session account assignments in the local SQLite database. GitHub tokens use profile-specific Windows Credential Manager entries.
- Claude profiles set `CLAUDE_CONFIG_DIR`; Codex profiles set `CODEX_HOME` and use their own `config.toml` / CLI-managed auth files under the app data directory. Do not put credentials in project files or logs.
- `ExecBackend` carries child-only environment overrides/removals; PTY login uses the same backend. Never switch process-global environment or overwrite another profile's credentials.
- Codex app-server instances are grouped by account environment. Existing sessions retain their account snapshot; project changes apply to new sessions. Never silently resume a conversation using another account.
- Global login UI and automatic use of the PC's existing login are removed. Account management is `src/features/accounts/`; projects choose profiles in their menu or new-conversation dialog. GitHub remotes require an explicit project account.
- Build caches on this machine have produced MSVC unresolved LLVM symbols with incremental compilation. If that recurs, disable incremental compilation for the Windows command (`CARGO_INCREMENTAL=0`, passed via WSLENV); retain dependency caches.

## Appearance
- Use the dark rose-pink theme only. Do not add light/system theme selectors; terminal and toast colors follow the same palette.

## UI preview (디자인 모드)
- `src-tauri/src/commands/preview.rs` creates a Tauri child webview (label `preview`, `unstable` feature) positioned over the
  `PreviewPane` host element; the React side reports bounds via `preview_set_bounds` and hides it while dialogs are open.
- `src-tauri/preview-init.js` is injected into the preview page (element picker + console capture). It reports back with
  `plugin:event|emit` → event `preview:report` (allowed by `core:default` for the remote URLs listed in
  `src-tauri/capabilities/preview.json`). App commands are NOT callable from the preview page (remote origin).
- Dev servers run through `vibecode_core::preview::DevServerManager` (backend shell, URL detection from output,
  process-tree stop). Stack defaults live in `resources/stacks.toml` (`dev_command`).
- Dev-mode binary is `vibecode.exe`; kill that (not Vibecoder.exe) when restarting `cargo.exe tauri dev`. When driving the
  preview webview with `scripts/cdp.mjs`, pass the target through WSLENV: `WSLENV=CDP_TARGET/w CDP_TARGET=localhost:8123`.

## Troubleshooting (dev machine)
- If every `*.exe` call from WSL fails with `cannot execute binary file: Exec format error`, the `WSLInterop`
  binfmt entry was lost. Fix without sudo/restart:
  `/init /mnt/c/WINDOWS/system32/wsl.exe wsl.exe -d Ubuntu -u root -e sh -c "echo ':WSLInterop:M::MZ::/init:PF' > /proc/sys/fs/binfmt_misc/register"`
  (`/init <exe> <argv0> <args…>` runs a Windows binary directly; repeat the exe name as argv0).
- GUI verification: start the app with `WSLENV=WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/w WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 cargo.exe tauri dev`,
  then drive it with `node.exe scripts/cdp.mjs eval|shot|run` (Chrome DevTools Protocol; screenshots land in `.tmp/`).
