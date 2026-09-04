//! Runs programs inside a WSL distribution via `wsl.exe`. Commands are wrapped in
//! `bash -lc` so the user's login PATH (e.g. ~/.local/bin/claude) is available.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio::process::Command;

use super::{paths, sh_quote, CommandSpec, ExecBackend, PID_MARKER};
use crate::error::Result;
use crate::types::BackendKind;

pub struct WslBackend {
    pub distro: String,
}

impl WslBackend {
    pub fn new(distro: String) -> Self {
        WslBackend { distro }
    }

    /// Compose the bash script executed inside WSL for a spec.
    pub fn script_for(&self, spec: &CommandSpec) -> String {
        let mut s = String::new();
        if let Some(cwd) = &spec.cwd {
            s.push_str(&format!("cd {} && ", sh_quote(&paths::windows_to_wsl(cwd))));
        }
        if spec.report_pid {
            s.push_str(&format!("echo \"{PID_MARKER}$$\" >&2 && "));
        }
        for (k, v) in &spec.env {
            s.push_str(&format!("export {}={} && ", k, sh_quote(v)));
        }
        s.push_str("exec ");
        s.push_str(&sh_quote(&spec.program));
        for a in &spec.args {
            s.push(' ');
            s.push_str(&sh_quote(a));
        }
        s
    }

    fn base(&self) -> Command {
        let mut c = Command::new("wsl.exe");
        c.arg("-d").arg(&self.distro);
        c
    }
}

#[async_trait]
impl ExecBackend for WslBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Wsl
    }

    fn label(&self) -> String {
        format!("WSL ({})", self.distro)
    }

    fn to_backend_path(&self, host: &Path) -> String {
        paths::windows_to_wsl(host)
    }

    fn to_host_path(&self, backend: &str) -> PathBuf {
        paths::wsl_to_windows(backend, &self.distro)
    }

    fn command(&self, spec: &CommandSpec) -> Command {
        let mut c = self.base();
        c.arg("--").arg("bash").arg("-lc").arg(self.script_for(spec));
        c
    }

    fn shell(&self, script: &str, cwd: Option<&Path>) -> CommandSpec {
        let full = match cwd {
            Some(c) => format!("cd {} && {}", sh_quote(&paths::windows_to_wsl(c)), script),
            None => script.to_string(),
        };
        CommandSpec::new("bash").args(["-lc", &full])
    }

    async fn which(&self, program: &str) -> Option<String> {
        let spec = CommandSpec::new("bash").args(["-lc", &format!("command -v {}", sh_quote(program))]);
        let out = self.run(&spec).await.ok()?;
        if out.success() {
            let p = out.stdout.trim().to_string();
            if p.is_empty() { None } else { Some(p) }
        } else {
            None
        }
    }

    async fn signal(&self, pid: u32, signal: &str) -> Result<()> {
        let spec = CommandSpec::new("kill").args(["-s", signal, &pid.to_string()]);
        self.run(&spec).await?.into_result().map(|_| ())
    }
}

/// Decode wsl.exe's UTF-16LE output (used by `wsl -l -q`).
fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).take(8).all(|b| *b == 0) {
        let u16s: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// List installed WSL distributions (default first).
pub async fn list_distros() -> Vec<String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-l", "-q"]);
    cmd.stdin(std::process::Stdio::null());
    let Ok(child) = super::process::spawn_tracked(&mut cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())) else {
        return vec![];
    };
    let Ok(out) = child.wait_with_output().await else { return vec![] };
    decode_wsl_output(&out.stdout)
        .lines()
        .map(|l| l.trim().trim_matches('\0').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

pub async fn default_distro() -> Option<String> {
    list_distros().await.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_quotes_and_cd() {
        let b = WslBackend::new("Ubuntu".into());
        let spec = CommandSpec::new("claude").args(["-p", "hello world"]).cwd("C:\\code\\x").env("FOO", "a b").report_pid(true);
        let s = b.script_for(&spec);
        assert_eq!(s, "cd /mnt/c/code/x && echo \"__VIBECODE_PID__:$$\" >&2 && export FOO='a b' && exec claude -p 'hello world'");
    }

    #[test]
    fn decode_utf16() {
        let s: Vec<u8> = "Ubuntu\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode_wsl_output(&s).trim(), "Ubuntu");
        assert_eq!(decode_wsl_output(b"plain"), "plain");
    }
}
