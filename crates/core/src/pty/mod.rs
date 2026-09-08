//! Interactive terminal sessions (portable-pty / ConPTY) for login flows and a
//! general-purpose terminal: PowerShell by default, or the requested program.
//!
//! Threads per pty: a reader (pty output -> callback) and a waiter (child exit ->
//! drop the master so the reader sees EOF -> `PtyEvent::Exit`).

mod utf8;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{CoreError, Result};
use crate::types::{PtyEvent, PtySpec};

pub use utf8::Utf8Decoder;

pub type PtyCallback = Box<dyn Fn(PtyEvent) + Send + Sync + 'static>;

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

type Handles = Arc<Mutex<HashMap<String, PtyHandle>>>;

#[derive(Default)]
pub struct PtyManager {
    handles: Handles,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager { handles: Arc::new(Mutex::new(HashMap::new())) }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, PtyHandle>>> {
        self.handles.lock().map_err(|_| CoreError::msg("pty mutex poisoned"))
    }

    /// Build the command for `spec`. `.cmd`/`.bat` shims (npm-installed CLIs such as codex) cannot be
    /// spawned directly by CreateProcess, so they run through `cmd.exe /d /c`.
    pub fn build_command(spec: &PtySpec) -> CommandBuilder {
        let mut cmd = match &spec.program {
            Some(program) if !program.trim().is_empty() => {
                let resolved = which::which(program).ok();
                let is_shim = resolved.as_ref().map(|p| matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("cmd") | Some("bat"))).unwrap_or(false);
                if let (true, Some(p)) = (is_shim && cfg!(windows), resolved.as_ref()) {
                    let mut c = CommandBuilder::new("cmd.exe");
                    c.arg("/d");
                    c.arg("/c");
                    c.arg(p);
                    c.args(&spec.args);
                    c
                } else {
                    let mut c = CommandBuilder::new(program);
                    c.args(&spec.args);
                    c
                }
            }
            _ => default_shell(),
        };
        if let Some(cwd) = &spec.cwd {
            if !cwd.trim().is_empty() && std::path::Path::new(cwd).is_dir() {
                cmd.cwd(cwd);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd
    }

    /// Open a pty; returns its id. `on_event` is called from a reader thread.
    pub fn open(&self, spec: PtySpec, on_event: PtyCallback) -> Result<String> {
        self.open_with_backend(spec, &crate::backend::ExecBackend::new(), on_event)
    }

    pub fn open_with_backend(&self, spec: PtySpec, backend: &crate::backend::ExecBackend, on_event: PtyCallback) -> Result<String> {
        let mut cmd = Self::build_command(&spec);
        for k in &backend.remove_environment { cmd.env_remove(k); }
        for (k, v) in &backend.environment { cmd.env(k, v); }
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: spec.rows.max(2), cols: spec.cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| CoreError::msg(format!("openpty failed: {e:#}")))?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| CoreError::msg(format!("pty spawn failed: {e:#}")))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| CoreError::msg(format!("pty reader: {e:#}")))?;
        let writer = pair.master.take_writer().map_err(|e| CoreError::msg(format!("pty writer: {e:#}")))?;
        let killer = child.clone_killer();

        let id = uuid::Uuid::new_v4().to_string();
        self.lock()?.insert(id.clone(), PtyHandle { master: pair.master, writer, killer });

        let on_event = Arc::new(on_event);
        let (code_tx, code_rx) = std::sync::mpsc::channel::<Option<i32>>();

        // Waiter: when the child exits, drop the master so the reader hits EOF.
        {
            let handles = self.handles.clone();
            let id = id.clone();
            std::thread::Builder::new()
                .name(format!("pty-wait-{}", &id[..8]))
                .spawn(move || {
                    let code = child.wait().ok().map(|s| s.exit_code() as i32);
                    let _ = code_tx.send(code);
                    if let Ok(mut h) = handles.lock() {
                        h.remove(&id);
                    }
                })
                .map_err(|e| CoreError::msg(format!("spawn waiter thread: {e}")))?;
        }

        // Reader: pump output to the callback, then report the exit code.
        {
            let on_event = on_event.clone();
            let id_short = id[..8].to_string();
            std::thread::Builder::new()
                .name(format!("pty-read-{id_short}"))
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    let mut dec = Utf8Decoder::default();
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                let s = dec.push(&buf[..n]);
                                if !s.is_empty() {
                                    on_event(PtyEvent::Data { data: s });
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(_) => break,
                        }
                    }
                    let tail = dec.flush();
                    if !tail.is_empty() {
                        on_event(PtyEvent::Data { data: tail });
                    }
                    let code = code_rx.recv_timeout(Duration::from_secs(10)).ok().flatten();
                    on_event(PtyEvent::Exit { code });
                })
                .map_err(|e| CoreError::msg(format!("spawn reader thread: {e}")))?;
        }

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let mut h = self.lock()?;
        let handle = h.get_mut(id).ok_or_else(|| CoreError::NotFound(format!("pty {id}")))?;
        handle.writer.write_all(data.as_bytes())?;
        handle.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let h = self.lock()?;
        let handle = h.get(id).ok_or_else(|| CoreError::NotFound(format!("pty {id}")))?;
        handle
            .master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| CoreError::msg(format!("pty resize: {e:#}")))
    }

    /// Kill the child and release the pty. Idempotent.
    pub fn close(&self, id: &str) -> Result<()> {
        let handle = self.lock()?.remove(id);
        if let Some(mut handle) = handle {
            let _ = handle.killer.kill();
            // Dropping `handle` closes the master; the reader thread then sees EOF.
        }
        Ok(())
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.lock().map(|h| h.contains_key(id)).unwrap_or(false)
    }
}

/// Interactive shell.
fn default_shell() -> CommandBuilder {
    if cfg!(windows) {
        if which::which("powershell.exe").is_ok() {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        } else {
            CommandBuilder::new("cmd.exe")
        }
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
        let mut c = CommandBuilder::new(shell);
        c.arg("-l");
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_program_shape() {
        let spec = PtySpec { program: Some("cmd.exe".into()), args: vec!["/c".into(), "echo hi".into()], cwd: None, cols: 80, rows: 24 };
        let cmd = PtyManager::build_command(&spec);
        let argv: Vec<String> = cmd.get_argv().iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(argv, vec!["cmd.exe", "/c", "echo hi"]);
        assert_eq!(cmd.get_env("TERM").map(|v| v.to_string_lossy().into_owned()), Some("xterm-256color".into()));
    }

    #[cfg(windows)]
    #[test]
    fn conpty_echo_roundtrip() {
        use std::sync::mpsc;
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<PtyEvent>();
        let spec = PtySpec { program: Some("cmd.exe".into()), args: vec!["/c".into(), "echo hi".into()], cwd: None, cols: 80, rows: 24 };
        let id = mgr
            .open(spec, Box::new(move |ev| {
                let _ = tx.send(ev);
            }))
            .expect("open pty");
        assert!(mgr.is_open(&id));
        let mut out = String::new();
        let mut exit: Option<Option<i32>> = None;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(PtyEvent::Data { data }) => {
                    // ConPTY queries the cursor position (DSR) at startup and holds output
                    // until the terminal answers; xterm.js does this automatically.
                    if data.contains("\x1b[6n") {
                        let _ = mgr.write(&id, "\x1b[1;1R");
                    }
                    out.push_str(&data);
                }
                Ok(PtyEvent::Exit { code }) => {
                    exit = Some(code);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        assert!(out.contains("hi"), "output was: {out:?}");
        assert_eq!(exit, Some(Some(0)), "exit event: {exit:?}");
        assert!(!mgr.is_open(&id));
    }
}
