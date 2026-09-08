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

pub(crate) type LoginGuard = Arc<Mutex<Option<tokio::sync::OwnedMutexGuard<()>>>>;

/// Running login flow (one at a time).
pub struct LoginFlow {
    pub pty_id: String,
}

fn strip_ansi(s: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static LINE_MOVE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    // ConPTY may move to the next screen row instead of emitting a newline.
    // Dropping that movement joins the OAuth URL to the next instruction.
    let line_move = LINE_MOVE.get_or_init(|| Regex::new(r"\x1b\[(?:[0-9]*;[0-9]*[Hf]|[0-9]*[BEF])").unwrap());
    let s = line_move.replace_all(s, "\n");
    // CSI sequences, OSC sequences (BEL- or ST-terminated; OSC 8 hyperlinks wrap the sign-in URL),
    // charset selections and stray control bytes.
    let re = RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]").unwrap());
    re.replace_all(&s, "").into_owned()
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
    /// An escape sequence may straddle reads from ConPTY.
    escape_tail: String,
    /// Text since the last newline (URLs can be split across PTY chunks).
    partial: String,
    seen_urls: Vec<String>,
    code_asked: bool,
}

impl Scan {
    /// Feed raw PTY data; returns events to emit.
    fn feed(&mut self, raw: &str) -> Vec<LoginEvent> {
        let mut out = Vec::new();
        let mut raw = std::mem::take(&mut self.escape_tail) + raw;
        if let Some(i) = raw.rfind('\x1b') {
            let tail = &raw.as_bytes()[i..];
            let incomplete = match tail.get(1) {
                None => true,
                Some(b'[') => !tail[2..].iter().any(|b| (0x40..=0x7e).contains(b)),
                Some(b']') => !tail[2..].contains(&b'\x07') && !tail.windows(2).any(|w| w == b"\x1b\\"),
                Some(b'(' | b')') => tail.len() < 3,
                _ => false,
            };
            if incomplete {
                self.escape_tail = raw.split_off(i);
            }
        }
        let clean = strip_ansi(&raw).replace('\r', "\n");
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
    start_for(ctx, provider, None, on_event).await
}

pub async fn start_for(ctx: Arc<AppContext>, provider: Provider, account_id: Option<String>, on_event: Box<dyn Fn(LoginEvent) + Send + Sync + 'static>) -> Result<LoginFlow> {
    let login_guard = ctx.login_gate.clone().try_lock_owned().map_err(|_| crate::error::CoreError::msg("다른 로그인이 진행 중입니다. 해당 로그인 창을 닫고 잠시 후 다시 시도하세요"))?;
    if let Some(id) = &account_id {
        crate::accounts::ensure_not_live(&ctx, id).await?;
        ctx.stop_account_hosts(id).await;
    }
    let login_guard: LoginGuard = Arc::new(Mutex::new(Some(login_guard)));
    let callback_guard = login_guard.clone();
    let backend = crate::accounts::agent_backend(&ctx, provider, account_id.as_deref())?;
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
    // PTY callbacks run on an OS reader thread, outside the Tokio runtime.
    let runtime = tokio::runtime::Handle::current();
    on_event(LoginEvent::Started);
    let exit_backend = backend.clone();
    let id = pty.open_with_backend(
        spec, &backend,
        Box::new(move |ev| {
            match ev {
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
                // Release on the event, independent of ConPTY reader/callback destruction.
                if let Ok(mut guard) = callback_guard.lock() { guard.take(); }
                if let Some(id) = id_for_cb.lock().ok().and_then(|g| g.clone()) {
                    if let Ok(mut guards) = ctx_for_exit.login_guards.lock() { guards.remove(&id); }
                }
                let ctx = ctx_for_exit.clone();
                let events = cb_events.clone();
                let backend: Arc<ExecBackend> = exit_backend.clone();
                runtime.spawn(async move {
                    let bin = ctx.bin_override(provider).await;
                    let status = crate::tools::auth_status(backend, provider, bin.as_deref()).await.ok();
                    events(LoginEvent::Finished { code, logged_in: status.as_ref().map(|s| s.logged_in).unwrap_or(false), account: status.and_then(|s| s.account) });
                });
            }
        }}),
    )?;
    if let Ok(mut g) = id_cell.lock() {
        *g = Some(id.clone());
        if let Ok(mut guards) = ctx.login_guards.lock() {
            if login_guard.lock().map(|g| g.is_some()).unwrap_or(false) { guards.insert(id.clone(), login_guard.clone()); }
        }
    }
    Ok(LoginFlow { pty_id: id })
}

/// Type the pasted authorization code into the login prompt.
pub fn submit_code(ctx: &AppContext, pty_id: &str, code: &str) -> Result<()> {
    ctx.pty.write(pty_id, &format!("{}\r", code.trim()))
}

/// Abort a running login.
pub fn cancel(ctx: &AppContext, pty_id: &str) -> Result<()> {
    ctx.pty.close(pty_id)?;
    // ConPTY EOF can be delayed after killing the child; cancellation must still unblock login.
    if let Ok(mut guards) = ctx.login_guards.lock() {
        if let Some(guard) = guards.remove(pty_id) {
            if let Ok(mut guard) = guard.lock() { guard.take(); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_releases_login_gate_even_when_reader_callback_is_retained() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = AppContext::init(tmp.path().join("data")).await.unwrap();
        let held = ctx.login_gate.clone().try_lock_owned().unwrap();
        let guard: LoginGuard = Arc::new(Mutex::new(Some(held)));
        // Simulate a ConPTY reader retaining its callback after the child is closed.
        let reader_guard = guard.clone();
        ctx.login_guards.lock().unwrap().insert("test-flow".into(), guard);
        assert!(ctx.login_gate.try_lock().is_err());
        cancel(&ctx, "test-flow").unwrap();
        assert!(ctx.login_gate.try_lock().is_ok());
        assert!(reader_guard.lock().unwrap().is_none());
        cancel(&ctx, "test-flow").unwrap();
    }

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

    #[test]
    fn conpty_cursor_movement_terminates_login_url_even_across_reads() {
        let mut s = Scan::default();
        assert!(s.feed("https://auth.openai.com/oauth/authorize?originator=codex_cli_rs\x1b[9;").is_empty());
        let events = s.feed("1HOn a remote or headless machine?\r\n");
        assert!(events.iter().any(|e| matches!(e, LoginEvent::Url { url } if url == "https://auth.openai.com/oauth/authorize?originator=codex_cli_rs")));
        assert!(events.iter().any(|e| matches!(e, LoginEvent::Output { line } if line == "On a remote or headless machine?")));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn login_exit_is_reported_from_pty_reader_thread() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("fake-login.cmd");
        std::fs::write(&cli, "@echo off\r\nexit /b 1\r\n").unwrap();
        let ctx = AppContext::init(dir.path().join("data")).await.unwrap();
        let mut settings = ctx.settings().await;
        settings.claude_bin = Some(cli.to_string_lossy().into_owned());
        ctx.update_settings(settings).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let flow = start(ctx.clone(), Provider::Claude, Box::new(move |e| { let _ = tx.send(e); })).await.unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            assert!(matches!(rx.recv().await, Some(LoginEvent::Started)));
            loop {
                if let Some(LoginEvent::Finished { code, logged_in, .. }) = rx.recv().await {
                    assert_eq!(code, Some(1));
                    assert!(!logged_in);
                    break;
                }
            }
        }).await;
        let _ = cancel(&ctx, &flow.pty_id);
        result.expect("login exit event must reach the GUI without a Tokio thread panic");
    }
}
