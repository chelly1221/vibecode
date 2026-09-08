//! Command execution on the Windows host. Everything that runs a program (agents, git,
//! scaffolding, tool detection, dev servers) builds a `CommandSpec` and hands it to `ExecBackend`,
//! which resolves the program through PATH (honouring PATHEXT and `.cmd` shims) and spawns it
//! without a console window (see `process`).

pub mod process;

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use crate::error::{CoreError, Result};

#[derive(Clone, Debug, Default)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
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

/// Runs programs directly on the host OS.
#[derive(Default, Clone)]
pub struct ExecBackend {
    pub(crate) environment: Vec<(String, String)>,
    pub(crate) remove_environment: Vec<String>,
    pub(crate) account_key: String,
}

impl ExecBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn account_key(&self) -> &str { &self.account_key }

    /// Human-readable label shown in logs ("Windows").
    pub fn label(&self) -> String {
        if cfg!(windows) { "Windows".into() } else { std::env::consts::OS.to_string() }
    }

    /// Resolve `program` through PATH (honouring PATHEXT on Windows).
    fn resolve(&self, program: &str) -> Option<PathBuf> {
        which::which(program).ok()
    }

    /// Build a tokio `Command` for the spec. Stdio is left unconfigured so the caller can
    /// pipe/inherit as needed. Use `process::spawn_tracked` to spawn.
    pub fn command(&self, spec: &CommandSpec) -> Command {
        let resolved = self.resolve(&spec.program);
        let mut cmd = match &resolved {
            // .cmd/.bat shims (npm, codex on Windows) must go through cmd.exe
            Some(p) if cfg!(windows) && matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("cmd") | Some("bat")) => {
                let mut c = Command::new("cmd.exe");
                c.arg("/d").arg("/c").arg(p);
                c.args(&spec.args);
                c
            }
            Some(p) => {
                let mut c = Command::new(p);
                c.args(&spec.args);
                c
            }
            None => {
                let mut c = Command::new(&spec.program);
                c.args(&spec.args);
                c
            }
        };
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        for k in &self.remove_environment { cmd.env_remove(k); }
        for (k, v) in &self.environment { cmd.env(k, v); }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd
    }

    /// Build a spec that runs a shell one-liner (PowerShell on Windows, `bash -lc` elsewhere).
    pub fn shell(&self, script: &str, cwd: Option<&Path>) -> CommandSpec {
        let mut spec = if cfg!(windows) {
            CommandSpec::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        } else {
            CommandSpec::new("bash").args(["-lc", script])
        };
        if let Some(c) = cwd {
            spec = spec.cwd(c);
        }
        spec
    }

    /// Locate a program on PATH.
    pub async fn which(&self, program: &str) -> Option<String> {
        self.resolve(program).map(|p| p.to_string_lossy().into_owned())
    }

    /// Run to completion, capturing output.
    pub async fn run(&self, spec: &CommandSpec) -> Result<CommandOutput> {
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
