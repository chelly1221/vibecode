//! Execution backends. Everything that runs a program (agents, git, scaffolding,
//! tool detection, PTYs) goes through an `ExecBackend`, so the app can run on
//! Windows while the actual tools live either on Windows (`Native`) or inside
//! WSL (`Wsl`). Paths handed to the backend are always host (Windows) paths;
//! the backend translates them.

pub mod native;
pub mod paths;
pub mod process;
pub mod wsl;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::process::Command;

use crate::error::{CoreError, Result};
use crate::types::{BackendConfig, BackendKind};

/// Marker line the WSL backend prints on stderr before exec'ing the program
/// when `report_pid` is set: `__VIBECODE_PID__:<pid>`.
pub const PID_MARKER: &str = "__VIBECODE_PID__:";

#[derive(Clone, Debug, Default)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    /// Host (Windows) path. Translated by the backend.
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    /// Ask the backend to report the real pid of the program (WSL only; see PID_MARKER).
    pub report_pid: bool,
}

impl CommandSpec {
    pub fn new(program: impl Into<String>) -> Self {
        CommandSpec { program: program.into(), ..Default::default() }
    }
    pub fn arg(mut self, a: impl Into<String>) -> Self {
        self.args.push(a.into());
        self
    }
    pub fn args<I, S>(mut self, it: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(it.into_iter().map(Into::into));
        self
    }
    pub fn cwd(mut self, p: impl Into<PathBuf>) -> Self {
        self.cwd = Some(p.into());
        self
    }
    pub fn env(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.env.push((k.into(), v.into()));
        self
    }
    pub fn report_pid(mut self, yes: bool) -> Self {
        self.report_pid = yes;
        self
    }
}

#[derive(Clone, Debug)]
pub struct CommandOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
    pub fn into_result(self) -> Result<CommandOutput> {
        if self.success() {
            Ok(self)
        } else {
            Err(CoreError::Process { code: self.code, stderr: if self.stderr.trim().is_empty() { self.stdout } else { self.stderr } })
        }
    }
}

#[async_trait]
pub trait ExecBackend: Send + Sync {
    fn kind(&self) -> BackendKind;

    /// Human-readable label, e.g. "Windows" or "WSL (Ubuntu)".
    fn label(&self) -> String;

    /// WSL distribution name when this backend runs inside WSL (used by callers that
    /// must build a `wsl.exe` command themselves, e.g. the PTY manager).
    fn wsl_distro(&self) -> Option<String> {
        None
    }

    /// Translate a host (Windows) path into the path the backend program sees.
    fn to_backend_path(&self, host: &Path) -> String;

    /// Translate a backend path back into a host path.
    fn to_host_path(&self, backend: &str) -> PathBuf;

    /// Build a tokio `Command` for the spec. Stdio is left unconfigured so the
    /// caller can pipe/inherit as needed. Use `process::spawn_tracked` to spawn.
    fn command(&self, spec: &CommandSpec) -> Command;

    /// Build a spec that runs a shell one-liner (PowerShell natively, `bash -lc` in WSL).
    fn shell(&self, script: &str, cwd: Option<&Path>) -> CommandSpec;

    /// Locate a program on the backend. Returns the backend-side path.
    async fn which(&self, program: &str) -> Option<String>;

    /// Send a signal to a backend pid (WSL only). Native returns NotImplemented.
    async fn signal(&self, pid: u32, signal: &str) -> Result<()>;

    /// Run to completion, capturing output.
    async fn run(&self, spec: &CommandSpec) -> Result<CommandOutput> {
        let mut cmd = self.command(spec);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = process::spawn_tracked(&mut cmd)?;
        let out = child.wait_with_output().await?;
        Ok(CommandOutput {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

/// Create the backend described by `cfg`. Resolves the WSL distro name when needed.
pub async fn create_backend(cfg: &BackendConfig) -> Result<Arc<dyn ExecBackend>> {
    match cfg.kind {
        BackendKind::Native => Ok(Arc::new(native::NativeBackend::new())),
        BackendKind::Wsl => {
            let distro = match &cfg.wsl_distro {
                Some(d) if !d.trim().is_empty() => d.clone(),
                _ => wsl::default_distro().await.ok_or_else(|| CoreError::msg("no WSL distribution found"))?,
            };
            Ok(Arc::new(wsl::WslBackend::new(distro)))
        }
    }
}

/// Quote for POSIX sh single-quoted string.
pub fn sh_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}
