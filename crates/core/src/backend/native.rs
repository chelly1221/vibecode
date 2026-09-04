//! Runs programs directly on the host OS.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio::process::Command;

use super::{CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::BackendKind;

pub struct NativeBackend;

impl NativeBackend {
    pub fn new() -> Self {
        NativeBackend
    }

    /// Resolve `program` through PATH (honouring PATHEXT on Windows).
    fn resolve(&self, program: &str) -> Option<PathBuf> {
        which::which(program).ok()
    }
}

impl Default for NativeBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ExecBackend for NativeBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Native
    }

    fn label(&self) -> String {
        if cfg!(windows) { "Windows".into() } else { std::env::consts::OS.to_string() }
    }

    fn to_backend_path(&self, host: &Path) -> String {
        host.to_string_lossy().into_owned()
    }

    fn to_host_path(&self, backend: &str) -> PathBuf {
        PathBuf::from(backend)
    }

    fn command(&self, spec: &CommandSpec) -> Command {
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
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd
    }

    fn shell(&self, script: &str, cwd: Option<&Path>) -> CommandSpec {
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

    async fn which(&self, program: &str) -> Option<String> {
        self.resolve(program).map(|p| p.to_string_lossy().into_owned())
    }

    async fn signal(&self, _pid: u32, _signal: &str) -> Result<()> {
        Err(CoreError::NotImplemented("signals are not supported on the native Windows backend"))
    }
}
