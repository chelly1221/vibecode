//! GUI login for the agent CLIs. `claude auth login` / `codex login` only talk to a terminal, so the
//! command runs in a hidden PTY and its output is parsed into `LoginEvent`s: the sign-in URL the
//! CLI prints (it also opens the browser itself), a request to paste a code, plain progress lines,
//! and the final auth status once the process exits.

use std::sync::{Arc, Mutex};

use regex::Regex;

use crate::backend::ExecBackend;
use crate::context::AppContext;
use crate::error::Result;
use crate::types::{LoginEvent, Provider, PtyEvent, PtySpec};

/// Running login flow (one per provider at a time).
pub struct LoginFlow {
    pub pty_id: String,
}

fn strip_ansi(s: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    // CSI sequences, OSC sequences (BEL- or ST-terminated; OSC 8 hyperlinks wrap the sign-in URL),
    // charset selections and stray control bytes.
    let re = RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]").unwrap());
    re.replace_all(s, "").into_owned()
}

fn find_urls(text: &str) -> Vec<String> {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"https://[^\s'"<>)]+"#).unwrap());
    re.find_iter(text).map(|m| m.as_str().trim_end_matches(['.', ',']).to_string()).collect()
}

fn asks_for_code(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("paste code") || t.contains("paste the code") || t.contains("enter the code") || t.contains("authorization code")
}

fn login_args(provider: Provider) -> (&'static str, Vec<String>) {
    match provider {
        Provider::Claude => ("claude", vec!["auth".into(), "login".into(), "--claudeai".into()]),
        Provider::Codex => ("codex", vec!["login".into()]),
    }
}

/// Parser state shared with the PTY reader thread.
#[derive(Default)]
struct Scan {
    /// Text since the last newline (URLs can be split across PTY chunks).
    partial: String,
    seen_urls: Vec<String>,
    code_asked: bool,
}

impl Scan {
    /// Feed raw PTY data; returns events to emit.
    fn feed(&mut self, raw: &str) -> Vec<LoginEvent> {
        let mut out = Vec::new();
        let clean = strip_ansi(raw).replace('\r', "\n");
        self.partial.push_str(&clean);
        // Only examine complete lines, plus the trailing partial for prompts.
        let mut lines: Vec<String> = self.partial.split('\n').map(String::from).collect();
        let tail = lines.pop().unwrap_or_default();
        for line in lines {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            for url in find_urls(&line) {
                if !self.seen_urls.contains(&url) {
                    self.seen_urls.push(url.clone());
                    out.push(LoginEvent::Url { url });
                }
            }
            out.push(LoginEvent::Output { line });
        }
        if !self.code_asked && (asks_for_code(&tail) || out.iter().any(|e| matches!(e, LoginEvent::Output { line } if asks_for_code(line)))) {
            self.code_asked = true;
            out.push(LoginEvent::CodeRequested);
        }
        self.partial = tail;
        out
    }
}

/// Start the login command in a hidden PTY; `on_event` is called from the reader thread.
pub async fn start(ctx: Arc<AppContext>, provider: Provider, on_event: Box<dyn Fn(LoginEvent) + Send + Sync + 'static>) -> Result<LoginFlow> {
    let (default_bin, args) = login_args(provider);
    let program = ctx.bin_override(provider).await.unwrap_or_else(|| default_bin.to_string());
    let spec = PtySpec { program: Some(program), args, cwd: None, cols: 120, rows: 30 };
    let scan = Arc::new(Mutex::new(Scan::default()));
    let on_event = Arc::new(on_event);
    let pty = ctx.pty_handle();
    let id_cell: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let id_for_cb = id_cell.clone();
    let ctx_for_exit = ctx.clone();
    let cb_events = on_event.clone();
    let id = pty.open(
        spec,
        Box::new(move |ev| match ev {
            PtyEvent::Data { data } => {
                // ConPTY holds output until the cursor-position query is answered.
                if data.contains("\x1b[6n") {
                    if let Some(id) = id_for_cb.lock().ok().and_then(|g| g.clone()) {
                        let _ = ctx_for_exit.pty.write(&id, "\x1b[1;1R");
                    }
                }
                let events = scan.lock().map(|mut s| s.feed(&data)).unwrap_or_default();
                for e in events {
                    cb_events(e);
                }
            }
            PtyEvent::Exit { code } => {
                let ctx = ctx_for_exit.clone();
                let events = cb_events.clone();
                tokio::spawn(async move {
                    let backend: Arc<ExecBackend> = ctx.backend().await;
                    let bin = ctx.bin_override(provider).await;
                    let status = crate::tools::auth_status(backend, provider, bin.as_deref()).await.ok();
                    events(LoginEvent::Finished { code, logged_in: status.as_ref().map(|s| s.logged_in).unwrap_or(false), account: status.and_then(|s| s.account) });
                });
            }
        }),
    )?;
    if let Ok(mut g) = id_cell.lock() {
        *g = Some(id.clone());
    }
    on_event(LoginEvent::Started);
    Ok(LoginFlow { pty_id: id })
}

/// Type the pasted authorization code into the login prompt.
pub fn submit_code(ctx: &AppContext, pty_id: &str, code: &str) -> Result<()> {
    ctx.pty.write(pty_id, &format!("{}\r", code.trim()))
}

/// Abort a running login.
pub fn cancel(ctx: &AppContext, pty_id: &str) -> Result<()> {
    ctx.pty.close(pty_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_and_finds_urls_across_chunks() {
        let mut s = Scan::default();
        let ev = s.feed("\x1b[1mOpening browser…\x1b[0m\r\nIf it did not open, visit: \x1b]8;id=1;https://claude.ai/oauth/authorize?code=1&state=abc\x1b\\https://claude.ai/oauth/auth");
        assert!(matches!(ev.as_slice(), [LoginEvent::Output { line }] if line == "Opening browser…"));
        let ev = s.feed("orize?code=1&state=abc\r\n");
        assert!(ev.iter().any(|e| matches!(e, LoginEvent::Url { url } if url == "https://claude.ai/oauth/authorize?code=1&state=abc")), "{ev:?}");
        // Same URL again is not repeated.
        assert!(!s.feed("visit https://claude.ai/oauth/authorize?code=1&state=abc\n").iter().any(|e| matches!(e, LoginEvent::Url { .. })));
        let ev = s.feed("Paste code here if prompted > ");
        assert!(ev.iter().any(|e| matches!(e, LoginEvent::CodeRequested)));
        assert!(!s.feed("Paste code here if prompted > ").iter().any(|e| matches!(e, LoginEvent::CodeRequested)));
    }

    #[test]
    fn login_commands_per_provider() {
        assert_eq!(login_args(Provider::Claude).1, vec!["auth", "login", "--claudeai"]);
        assert_eq!(login_args(Provider::Codex), ("codex", vec!["login".to_string()]));
    }
}
