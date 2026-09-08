//! Keeps CLAUDE.md and AGENTS.md identical in every registered project. Claude Code reads the first,
//! Codex the second, and either agent (or the user) may edit one of them, so the project root is
//! watched and a change to one file is mirrored to the other. `reconcile` is also run at the moments
//! that matter: registration, project selection, session start and every turn end.
//!
//! Rules: a missing file is recreated from the other; when both exist and differ, the more recently
//! modified one wins, except that an empty file never overwrites a non-empty one (editors truncate
//! before they write).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::Result;

pub const FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

/// Quiet period after the last change before the pair is reconciled (coalesces editor write bursts).
const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncOutcome {
    /// Neither file exists.
    Absent,
    /// Both exist with identical content.
    InSync,
    /// `to` was (re)written with the content of `from`.
    Copied { from: &'static str, to: &'static str },
}

impl SyncOutcome {
    /// File name that was written, if any (for UI messages).
    pub fn written(&self) -> Option<&'static str> {
        match self {
            SyncOutcome::Copied { to, .. } => Some(to),
            _ => None,
        }
    }
}

fn read(path: &Path) -> Result<Option<(Vec<u8>, SystemTime)>> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            Ok(Some((std::fs::read(path)?, modified)))
        }
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Make `dir`'s AGENTS.md and CLAUDE.md identical (see the module docs for the rules).
pub fn reconcile(dir: &Path) -> Result<SyncOutcome> {
    let agents_path = dir.join("AGENTS.md");
    let claude_path = dir.join("CLAUDE.md");
    let agents = read(&agents_path)?;
    let claude = read(&claude_path)?;
    let copy = |bytes: &[u8], to: &Path| std::fs::write(to, bytes);
    match (agents, claude) {
        (None, None) => Ok(SyncOutcome::Absent),
        (Some((a, _)), None) => {
            copy(&a, &claude_path)?;
            Ok(SyncOutcome::Copied { from: "AGENTS.md", to: "CLAUDE.md" })
        }
        (None, Some((c, _))) => {
            copy(&c, &agents_path)?;
            Ok(SyncOutcome::Copied { from: "CLAUDE.md", to: "AGENTS.md" })
        }
        (Some((a, a_time)), Some((c, c_time))) => {
            if a == c {
                return Ok(SyncOutcome::InSync);
            }
            // Newest wins; an empty file is a write in progress (or a mistake), never a source.
            let agents_wins = match (a.is_empty(), c.is_empty()) {
                (true, false) => false,
                (false, true) => true,
                _ => a_time >= c_time,
            };
            if agents_wins {
                copy(&a, &claude_path)?;
                Ok(SyncOutcome::Copied { from: "AGENTS.md", to: "CLAUDE.md" })
            } else {
                copy(&c, &agents_path)?;
                Ok(SyncOutcome::Copied { from: "CLAUDE.md", to: "AGENTS.md" })
            }
        }
    }
}

/// Reconcile and log; never fails (used from hooks where a sync problem must not break the flow).
pub fn reconcile_quietly(dir: &Path) -> SyncOutcome {
    match reconcile(dir) {
        Ok(out) => {
            if let SyncOutcome::Copied { from, to } = &out {
                tracing::info!("agent docs sync: {} → {} in {}", from, to, dir.display());
            }
            out
        }
        Err(e) => {
            tracing::warn!("agent docs sync failed in {}: {e}", dir.display());
            SyncOutcome::Absent
        }
    }
}

fn is_doc(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| FILES.iter().any(|f| f.eq_ignore_ascii_case(n)))
}

struct Inner {
    watcher: RecommendedWatcher,
    dirs: Vec<PathBuf>,
}

/// Watches project roots (non-recursively) and mirrors changes between the two files after a short
/// quiet period. One instance lives in `AppContext`.
pub struct DocsWatcher {
    inner: Mutex<Option<Inner>>,
    wake: Sender<PathBuf>,
}

impl Default for DocsWatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl DocsWatcher {
    pub fn new() -> Self {
        let (wake, rx) = mpsc::channel::<PathBuf>();
        std::thread::Builder::new()
            .name("agent-docs-sync".into())
            .spawn(move || debounce_loop(rx))
            .expect("spawn agent-docs-sync thread");
        Self { inner: Mutex::new(None), wake }
    }

    fn ensure_watcher(&self, inner: &mut Option<Inner>) -> notify::Result<()> {
        if inner.is_none() {
            let wake = self.wake.clone();
            let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    for dir in ev.paths.iter().filter(|p| is_doc(p)).filter_map(|p| p.parent().map(Path::to_path_buf)) {
                        let _ = wake.send(dir);
                    }
                }
            })?;
            *inner = Some(Inner { watcher, dirs: Vec::new() });
        }
        Ok(())
    }

    /// Start mirroring `dir` (idempotent; a missing directory is ignored).
    pub fn watch(&self, dir: &Path) {
        if !dir.is_dir() {
            return;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(e) = self.ensure_watcher(&mut guard) {
            tracing::warn!("agent docs watcher unavailable: {e}");
            return;
        }
        let inner = guard.as_mut().expect("watcher");
        if inner.dirs.iter().any(|d| d == dir) {
            return;
        }
        match inner.watcher.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => inner.dirs.push(dir.to_path_buf()),
            Err(e) => tracing::warn!("cannot watch {} for agent docs: {e}", dir.display()),
        }
    }

    pub fn unwatch(&self, dir: &Path) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(inner) = guard.as_mut() {
            if let Some(i) = inner.dirs.iter().position(|d| d == dir) {
                inner.dirs.remove(i);
                let _ = inner.watcher.unwatch(dir);
            }
        }
    }

    /// Directories currently watched (tests / diagnostics).
    pub fn watched(&self) -> Vec<PathBuf> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|i| i.dirs.clone()).unwrap_or_default()
    }
}

/// Collects wake-ups per directory and reconciles once the directory has been quiet for `DEBOUNCE`.
fn debounce_loop(rx: mpsc::Receiver<PathBuf>) {
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    loop {
        let wait = pending.values().min().map(|due| due.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(3600));
        match rx.recv_timeout(wait) {
            Ok(dir) => {
                pending.insert(dir, Instant::now() + DEBOUNCE);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        let due: Vec<PathBuf> = pending.iter().filter(|(_, t)| **t <= now).map(|(d, _)| d.clone()).collect();
        for dir in due {
            pending.remove(&dir);
            reconcile_quietly(&dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(pred: impl Fn() -> bool, timeout: Duration) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < timeout {
            if pred() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        pred()
    }

    #[test]
    fn missing_file_is_cloned_from_the_other() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(reconcile(dir.path()).unwrap(), SyncOutcome::Absent);
        std::fs::write(dir.path().join("CLAUDE.md"), "# rules\n").unwrap();
        assert_eq!(reconcile(dir.path()).unwrap(), SyncOutcome::Copied { from: "CLAUDE.md", to: "AGENTS.md" });
        assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "# rules\n");
        assert_eq!(reconcile(dir.path()).unwrap(), SyncOutcome::InSync);

        std::fs::remove_file(dir.path().join("CLAUDE.md")).unwrap();
        assert_eq!(reconcile(dir.path()).unwrap(), SyncOutcome::Copied { from: "AGENTS.md", to: "CLAUDE.md" });
    }

    #[test]
    fn newer_file_wins_but_never_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "old").unwrap();
        std::thread::sleep(Duration::from_millis(60));
        std::fs::write(dir.path().join("CLAUDE.md"), "new").unwrap();
        assert_eq!(reconcile(dir.path()).unwrap(), SyncOutcome::Copied { from: "CLAUDE.md", to: "AGENTS.md" });
        assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "new");

        std::thread::sleep(Duration::from_millis(60));
        std::fs::write(dir.path().join("AGENTS.md"), "newer").unwrap();
        assert_eq!(reconcile(dir.path()).unwrap(), SyncOutcome::Copied { from: "AGENTS.md", to: "CLAUDE.md" });
        assert_eq!(std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(), "newer");

        // A truncated (empty) newer file must not wipe the other one.
        std::thread::sleep(Duration::from_millis(60));
        std::fs::write(dir.path().join("CLAUDE.md"), "").unwrap();
        assert_eq!(reconcile(dir.path()).unwrap(), SyncOutcome::Copied { from: "AGENTS.md", to: "CLAUDE.md" });
        assert_eq!(std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(), "newer");
    }

    #[test]
    fn watcher_mirrors_changes_both_ways() {
        let dir = tempfile::tempdir().unwrap();
        let w = DocsWatcher::new();
        w.watch(dir.path());
        w.watch(dir.path());
        assert_eq!(w.watched().len(), 1);

        std::fs::write(dir.path().join("AGENTS.md"), "one").unwrap();
        assert!(wait_until(|| std::fs::read_to_string(dir.path().join("CLAUDE.md")).ok().as_deref() == Some("one"), Duration::from_secs(8)), "CLAUDE.md not created");

        std::thread::sleep(Duration::from_millis(60));
        std::fs::write(dir.path().join("CLAUDE.md"), "two").unwrap();
        assert!(wait_until(|| std::fs::read_to_string(dir.path().join("AGENTS.md")).ok().as_deref() == Some("two"), Duration::from_secs(8)), "AGENTS.md not mirrored");

        std::fs::remove_file(dir.path().join("CLAUDE.md")).unwrap();
        assert!(wait_until(|| std::fs::read_to_string(dir.path().join("CLAUDE.md")).ok().as_deref() == Some("two"), Duration::from_secs(8)), "CLAUDE.md not recreated");

        w.unwatch(dir.path());
        assert!(w.watched().is_empty());
    }
}
