//! Working-tree checkpoints: a snapshot commit is created before every agent turn so the user
//! can roll the project back from the chat.
//!
//! Storage:
//! - Git projects (the project dir is the repository top level): snapshots are written into the
//!   project's own repository without touching HEAD or the index (`GIT_INDEX_FILE` points at a
//!   private index) and are kept under `refs/vibecoder/checkpoints/<id>`.
//! - Everything else: a hidden repository `<app data>/checkpoints/<project_id>/.git` with
//!   `GIT_WORK_TREE=<project>` and an `info/exclude` covering build/dependency directories.
//!
//! Every git call goes through the active backend (paths are translated for WSL).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;

use crate::backend::{CommandSpec, ExecBackend};
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::CheckpointRecord;

pub const MAX_PER_PROJECT: usize = 50;
pub const SAFETY_LABEL: &str = "복원 전 자동 저장";
pub const REF_PREFIX: &str = "refs/vibecoder/checkpoints/";
/// Ignore rules for hidden repositories (projects that are not git repositories themselves).
pub const HIDDEN_EXCLUDES: &[&str] = &[
    ".git/", "node_modules/", "target/", "dist/", "build/", "out/", ".venv/", "venv/", "__pycache__/", ".next/", ".svelte-kit/",
    ".dart_tool/", "bin/", "obj/", ".gradle/", ".idea/", "*.log", ".DS_Store", "Thumbs.db",
];

/// First line of a user message, trimmed to 40 chars, used as the checkpoint label.
pub fn label_for(text: &str) -> String {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut s: String = first.chars().take(40).collect();
    if first.chars().count() > 40 {
        s.push('…');
    }
    if s.is_empty() { "체크포인트".into() } else { sanitize_label(&s) }
}

/// Commit messages travel through nested shell quoting (wsl.exe → bash); keep them boring.
pub fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|c| match c {
            '"' | '`' => '\'',
            '\\' => '/',
            '$' => '＄',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

enum Mode {
    InRepo,
    Hidden { git_dir: PathBuf },
}

/// A project's snapshot store bound to a backend.
struct Store {
    backend: Arc<dyn ExecBackend>,
    bin: String,
    project: PathBuf,
    mode: Mode,
    /// Private index reused by `create` (host path).
    index: PathBuf,
    base: PathBuf,
}

impl Store {
    async fn open(ctx: &AppContext, project_id: &str, project_path: &Path) -> Result<Store> {
        let backend = ctx.backend().await;
        let bin = ctx.git_bin().await.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "git".into());
        let base = ctx.data_dir.join("checkpoints").join(project_id);
        std::fs::create_dir_all(&base)?;
        let mut store = Store { backend, bin, project: project_path.to_path_buf(), mode: Mode::InRepo, index: base.join("index"), base: base.clone() };

        // Git repository whose top level is the project dir → snapshot in place.
        let top = store.raw(&["rev-parse", "--show-toplevel"], false, None).await;
        let in_repo = match top {
            Ok(out) if out.success() => {
                let top = out.stdout.trim().to_string();
                let expected = store.backend.to_backend_path(project_path).replace('\\', "/").trim_end_matches('/').to_string();
                same_path(&top, &expected)
            }
            _ => false,
        };
        if !in_repo {
            let git_dir = base.join(".git");
            store.mode = Mode::Hidden { git_dir: git_dir.clone() };
            if !git_dir.join("HEAD").exists() {
                store.run(&["init", "-q"], None).await?;
            }
            let info = git_dir.join("info");
            std::fs::create_dir_all(&info)?;
            std::fs::write(info.join("exclude"), HIDDEN_EXCLUDES.join("\n") + "\n")?;
        }
        Ok(store)
    }

    fn spec(&self, args: &[&str], with_env: bool, index: Option<&Path>) -> CommandSpec {
        let mut spec = CommandSpec::new(&self.bin)
            .args(args.iter().map(|s| s.to_string()))
            .cwd(&self.project)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .env("GIT_AUTHOR_NAME", "Vibecoder")
            .env("GIT_AUTHOR_EMAIL", "vibecoder@localhost")
            .env("GIT_COMMITTER_NAME", "Vibecoder")
            .env("GIT_COMMITTER_EMAIL", "vibecoder@localhost");
        if with_env {
            if let Mode::Hidden { git_dir } = &self.mode {
                spec = spec
                    .env("GIT_DIR", self.backend.to_backend_path(git_dir))
                    .env("GIT_WORK_TREE", self.backend.to_backend_path(&self.project));
            }
        }
        if let Some(i) = index {
            spec = spec.env("GIT_INDEX_FILE", self.backend.to_backend_path(i));
        }
        spec
    }

    async fn raw(&self, args: &[&str], with_env: bool, index: Option<&Path>) -> Result<crate::backend::CommandOutput> {
        self.backend.run(&self.spec(args, with_env, index)).await
    }

    /// Run git (with repo env) and fail on non-zero exit; returns trimmed stdout.
    async fn run(&self, args: &[&str], index: Option<&Path>) -> Result<String> {
        let out = self.raw(args, true, index).await?;
        if !out.success() {
            return Err(CoreError::msg(format!("git {} 실패: {}", args.first().unwrap_or(&""), out.stderr.trim())));
        }
        Ok(out.stdout.trim().to_string())
    }

    /// Stage the whole work tree into `index` and return its tree hash.
    async fn write_tree(&self, index: &Path) -> Result<String> {
        self.run(&["add", "-A", "--", "."], Some(index)).await?;
        self.run(&["write-tree"], Some(index)).await
    }

    fn temp_index(&self, tag: &str) -> PathBuf {
        self.base.join(format!("{tag}-{}.index", uuid::Uuid::new_v4()))
    }
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

/// Snapshot the project's working tree. Returns None when nothing changed since the last checkpoint.
pub async fn create(ctx: Arc<AppContext>, project_id: &str, session_id: Option<&str>, label: &str) -> Result<Option<CheckpointRecord>> {
    let project = ctx.db.get_project(project_id)?;
    let project_path = PathBuf::from(&project.path);
    if !project_path.is_dir() {
        return Err(CoreError::msg(format!("프로젝트 폴더가 없습니다: {}", project.path)));
    }
    let store = Store::open(&ctx, project_id, &project_path).await?;
    let tree = store.write_tree(&store.index).await?;

    let prev = ctx.db.latest_checkpoint_tree(project_id)?;
    if let Some((_, prev_tree)) = &prev {
        if *prev_tree == tree {
            return Ok(None);
        }
    }
    let parent_ref = prev.as_ref().map(|(id, _)| ctx.db.get_checkpoint(id).ok()).flatten().map(|c| c.git_ref);

    let id = uuid::Uuid::new_v4().to_string();
    let label = sanitize_label(label);
    let label = if label.is_empty() { "체크포인트".to_string() } else { label };
    let mut args: Vec<String> = vec!["commit-tree".into(), tree.clone()];
    if let Some(p) = &parent_ref {
        args.extend(["-p".into(), p.clone()]);
    }
    args.extend(["-m".into(), label.clone()]);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let hash = store.run(&refs, Some(&store.index)).await?;
    store.run(&["update-ref", &format!("{REF_PREFIX}{id}"), &hash], None).await?;

    let rec = CheckpointRecord {
        id: id.clone(),
        project_id: project_id.to_string(),
        session_id: session_id.map(str::to_string),
        seq: ctx.db.next_checkpoint_seq(project_id)?,
        git_ref: hash,
        label,
        created_at: Utc::now(),
    };
    ctx.db.insert_checkpoint(&rec, &tree)?;
    prune(&ctx, &store, project_id).await;
    Ok(Some(rec))
}

async fn prune(ctx: &AppContext, store: &Store, project_id: &str) {
    let Ok(all) = ctx.db.list_checkpoints(project_id, None) else { return };
    for old in all.iter().skip(MAX_PER_PROJECT) {
        let _ = store.run(&["update-ref", "-d", &format!("{REF_PREFIX}{}", old.id)], None).await;
        let _ = ctx.db.delete_checkpoint(&old.id);
    }
}

/// Restore the working tree to a checkpoint (overwrites snapshotted files, removes files that
/// did not exist in the snapshot, leaves ignored files alone). A safety checkpoint of the current
/// state is created first and returned (or the newest existing one when nothing had changed).
pub async fn restore(ctx: Arc<AppContext>, checkpoint_id: &str) -> Result<CheckpointRecord> {
    let cp = ctx.db.get_checkpoint(checkpoint_id)?;
    let project = ctx.db.get_project(&cp.project_id)?;
    let project_path = PathBuf::from(&project.path);
    let tree = ctx.db.checkpoint_tree(checkpoint_id)?.ok_or_else(|| CoreError::NotFound(format!("checkpoint {checkpoint_id}")))?;

    let safety = match create(ctx.clone(), &cp.project_id, cp.session_id.as_deref(), SAFETY_LABEL).await? {
        Some(rec) => rec,
        None => ctx
            .db
            .list_checkpoints(&cp.project_id, None)?
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::msg("체크포인트가 없습니다"))?,
    };

    let store = Store::open(&ctx, &cp.project_id, &project_path).await?;
    let tmp = store.temp_index("restore");
    let result = restore_inner(&store, &tmp, &tree, &project_path).await;
    let _ = std::fs::remove_file(&tmp);
    result?;
    Ok(safety)
}

async fn restore_inner(store: &Store, tmp: &Path, tree: &str, project_path: &Path) -> Result<()> {
    // 1. Load the snapshot into a private index and write every file into the work tree.
    store.run(&["read-tree", tree], Some(tmp)).await?;
    store.run(&["checkout-index", "-a", "-f"], Some(tmp)).await?;
    // 2. Files that exist now but were not part of the snapshot (and are not ignored) are removed.
    let extra = store.run(&["ls-files", "-z", "--others", "--exclude-standard"], Some(tmp)).await?;
    for rel in extra.split('\0').map(str::trim).filter(|s| !s.is_empty()) {
        let host = project_path.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if host.is_file() {
            let _ = std::fs::remove_file(&host);
            // drop directories that became empty
            let mut dir = host.parent().map(Path::to_path_buf);
            while let Some(d) = dir {
                if d == project_path || std::fs::remove_dir(&d).is_err() {
                    break;
                }
                dir = d.parent().map(Path::to_path_buf);
            }
        }
    }
    // 3. Keep the create() index in sync so the next snapshot starts from the restored state.
    let _ = store.run(&["read-tree", tree], Some(&store.index)).await;
    Ok(())
}

pub async fn list(ctx: Arc<AppContext>, project_id: &str, session_id: Option<&str>) -> Result<Vec<CheckpointRecord>> {
    ctx.db.list_checkpoints(project_id, session_id)
}

/// Unified diff between the checkpoint and the current working tree (untracked files included).
pub async fn diff(ctx: Arc<AppContext>, checkpoint_id: &str) -> Result<String> {
    let cp = ctx.db.get_checkpoint(checkpoint_id)?;
    let project = ctx.db.get_project(&cp.project_id)?;
    let project_path = PathBuf::from(&project.path);
    let tree = ctx.db.checkpoint_tree(checkpoint_id)?.ok_or_else(|| CoreError::NotFound(format!("checkpoint {checkpoint_id}")))?;
    let store = Store::open(&ctx, &cp.project_id, &project_path).await?;
    let tmp = store.temp_index("diff");
    let now = store.write_tree(&tmp).await;
    let _ = std::fs::remove_file(&tmp);
    let now = now?;
    if now == tree {
        return Ok(String::new());
    }
    store.run(&["diff-tree", "-p", "-M", "--no-color", &tree, &now], None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_trimmed_to_first_line() {
        assert_eq!(label_for("  hello\nworld"), "hello");
        assert_eq!(label_for(""), "체크포인트");
        let long = "a".repeat(60);
        let l = label_for(&long);
        assert_eq!(l.chars().count(), 41);
        assert!(l.ends_with('…'));
    }

    #[test]
    fn labels_are_sanitized() {
        assert_eq!(sanitize_label("say \"hi\" $HOME `x` a\\b"), "say 'hi' ＄HOME 'x' a/b");
        assert_eq!(label_for("tab\there"), "tab here");
    }

    #[test]
    fn excludes_cover_dependency_dirs() {
        for d in ["node_modules/", "target/", ".git/", "__pycache__/"] {
            assert!(HIDDEN_EXCLUDES.contains(&d), "{d}");
        }
        assert!(same_path("/mnt/c/Code/X/", "/mnt/c/code/x"));
        assert!(!same_path("/mnt/c/code/x/sub", "/mnt/c/code/x"));
    }
}
