//! vibecode core library. Tauri-independent: agent adapters, host command execution,
//! git/GitHub, project scaffolding, persistence, secrets and PTY sessions.
//!
//! Module ownership (see CLAUDE.md):
//! - `types`      shared serializable types exported to TypeScript via ts-rs
//! - `backend`    command execution on the Windows host (PATH resolution, .cmd shims, no console window)
//! - `agents`     `AgentSession` trait + Claude Code / Codex adapters
//! - `permission` in-app MCP HTTP server used as Claude's `--permission-prompt-tool`
//! - `git`        git operations through the backend (+ `git::ssh` key helpers, `git::auto` commit after turns)
//! - `checkpoint` working-tree snapshots per agent turn and rollback
//! - `fs`         read-only project file listing/reading for the explorer
//! - `github`     GitHub REST (create repo, whoami)
//! - `projects`   stack catalog, automatic prerequisite install (`projects::install`), scaffolding, CLAUDE.md/AGENTS.md
//!                generation and mirroring (`projects::docs_sync`), build-and-package export (`projects::export`)
//! - `db`         SQLite persistence (projects, sessions, messages, settings)
//! - `secrets`    OS keyring wrapper
//! - `pty`        interactive terminal sessions (login flows)
//! - `preview`    dev-server runner for the UI preview
//! - `tools`      CLI detection and auth status
//! - `usage`      subscription rate-limit windows reported by the CLIs (usage graph)
//! - `selfbuild`  "새 빌드 적용": rebuild this app from its checkout and restart on the new exe

pub mod accounts;
pub mod agents;
pub mod backend;
pub mod checkpoint;
pub mod context;
pub mod db;
pub mod error;
pub mod fs;
pub mod git;
pub mod github;
pub mod permission;
pub mod preview;
pub mod projects;
pub mod pty;
pub mod secrets;
pub mod selfbuild;
pub mod tools;
pub mod types;
pub mod usage;

pub use context::AppContext;
pub use error::{CoreError, Result};
