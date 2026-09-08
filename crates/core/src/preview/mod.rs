//! Dev-server runner for the UI preview: starts the project's dev command through the backend,
//! streams its output, detects the local URL it prints, and can stop the whole process tree.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

use crate::backend::{process::spawn_tracked, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::{PreviewEvent, PreviewStatus};

struct Running {
    command: String,
    url: Option<String>,
    host_pid: Option<u32>,
}

#[derive(Default)]
pub struct DevServerManager {
    procs: Mutex<HashMap<String, Arc<Mutex<Running>>>>,
}

fn strip_ansi(s: &str) -> String {
    let re = regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap();
    re.replace_all(s, "").into_owned()
}

/// First local URL in a dev-server log line, host normalised to `localhost`.
pub fn detect_url(line: &str) -> Option<String> {
    let clean = strip_ansi(line);
    let re = regex::Regex::new(r#"(https?)://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)(/[^\s"'\)\]>]*)?"#).ok()?;
    let c = re.captures(&clean)?;
    let path = c.get(4).map(|m| m.as_str()).unwrap_or("/");
    Some(format!("{}://localhost{}{}", &c[1], &c[3], path))
}

impl DevServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn status(&self, project_id: &str) -> PreviewStatus {
        match self.procs.lock().await.get(project_id) {
            Some(r) => {
                let r = r.lock().await;
                PreviewStatus { running: true, command: Some(r.command.clone()), url: r.url.clone() }
            }
            None => PreviewStatus { running: false, command: None, url: None },
        }
    }

    /// Start `command` in `project_dir` (host path) through `backend`; stops any previous server of the project.
    pub async fn start(
        self: &Arc<Self>,
        backend: Arc<ExecBackend>,
        project_id: &str,
        project_dir: PathBuf,
        command: &str,
        events: UnboundedSender<PreviewEvent>,
    ) -> Result<()> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err(CoreError::msg("실행할 명령이 비어 있습니다"));
        }
        self.stop(project_id).await.ok();

        let mut spec = backend.shell(&command, Some(&project_dir));
        spec = spec.env("BROWSER", "none").env("CI", "1").env("FORCE_COLOR", "0");
        let mut cmd = backend.command(&spec);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = spawn_tracked(&mut cmd)?;
        let host_pid = child.id();
        let stdout = child.stdout.take().ok_or_else(|| CoreError::msg("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| CoreError::msg("no stderr"))?;

        let running = Arc::new(Mutex::new(Running { command: command.clone(), url: None, host_pid }));
        self.procs.lock().await.insert(project_id.to_string(), running.clone());
        let _ = events.send(PreviewEvent::Started { command: command.clone() });

        let ev_out = events.clone();
        let run_out = running.clone();
        let t_out = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = detect_url(&line) {
                    let mut r = run_out.lock().await;
                    if r.url.is_none() {
                        r.url = Some(url.clone());
                        let _ = ev_out.send(PreviewEvent::Url { url });
                    }
                }
                let _ = ev_out.send(PreviewEvent::Log { line: strip_ansi(&line), is_err: false });
            }
        });
        let ev_err = events.clone();
        let run_err = running.clone();
        let t_err = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = detect_url(&line) {
                    let mut r = run_err.lock().await;
                    if r.url.is_none() {
                        r.url = Some(url.clone());
                        let _ = ev_err.send(PreviewEvent::Url { url });
                    }
                }
                let _ = ev_err.send(PreviewEvent::Log { line: strip_ansi(&line), is_err: true });
            }
        });

        let me = self.clone();
        let pid_key = project_id.to_string();
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            let _ = tokio::join!(t_out, t_err);
            // Only forget the entry if it is still ours (a restart may have replaced it).
            let mut map = me.procs.lock().await;
            if let Some(cur) = map.get(&pid_key) {
                if Arc::ptr_eq(cur, &running) {
                    map.remove(&pid_key);
                }
            }
            let _ = events.send(PreviewEvent::Exited { code: status.and_then(|s| s.code()) });
        });
        Ok(())
    }

    /// Stop the dev server and its whole process tree (npm → node).
    pub async fn stop(&self, project_id: &str) -> Result<()> {
        let entry = self.procs.lock().await.remove(project_id);
        let Some(entry) = entry else { return Ok(()) };
        let r = entry.lock().await;
        if let Some(host) = r.host_pid {
            #[cfg(windows)]
            {
                let mut c = tokio::process::Command::new("taskkill.exe");
                c.args(["/PID", &host.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                if let Ok(child) = spawn_tracked(&mut c) {
                    let _ = child.wait_with_output().await;
                }
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("kill").args(["-TERM", &host.to_string()]).status();
            }
        }
        Ok(())
    }

    pub async fn stop_all(&self) {
        let keys: Vec<String> = self.procs.lock().await.keys().cloned().collect();
        for k in keys {
            let _ = self.stop(&k).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_local_urls() {
        assert_eq!(detect_url("  ➜  Local:   http://localhost:5173/"), Some("http://localhost:5173/".into()));
        assert_eq!(detect_url("Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ..."), Some("http://localhost:8123/".into()));
        assert_eq!(detect_url("\x1b[32m- Local:\x1b[0m http://127.0.0.1:3000"), Some("http://localhost:3000/".into()));
        assert_eq!(detect_url("Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)"), Some("http://localhost:8000/".into()));
        assert_eq!(detect_url("no url here"), None);
        assert_eq!(detect_url("https://example.com:443/x"), None);
    }
}
