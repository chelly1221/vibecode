//! SQLite persistence. Single connection behind a mutex; all methods are sync and
//! cheap. Call from async code directly (rusqlite ops here are sub-millisecond).

use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::types::{
    AppSettings, AutoGit, CheckpointRecord, Effort, MessageKind, MessageRecord, PermissionPreset, ProjectRecord, ProjectSettingsUpdate, ProjectType,
    Provider, RateLimitWindow, SessionRecord, TargetOs, UsageSample,
};

pub struct Db {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    target_os TEXT,
    project_type TEXT,
    stack_id TEXT,
    github_url TEXT,
    default_provider TEXT,
    default_model TEXT,
    default_effort TEXT,
    default_permission TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_ref TEXT,
    title TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    permission TEXT NOT NULL,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, last_used_at DESC);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    seq INTEGER NOT NULL,
    git_ref TEXT NOT NULL,
    tree TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_project ON checkpoints(project_id, seq DESC);
CREATE TABLE IF NOT EXISTS usage_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    account_id TEXT,
    window_id TEXT NOT NULL,
    label TEXT NOT NULL,
    used_percent REAL NOT NULL,
    resets_at INTEGER,
    window_minutes INTEGER,
    observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_samples_key ON usage_samples(provider, account_id, window_id, observed_at DESC);
"#;

/// Usage rows older than this are pruned on insert.
const USAGE_RETENTION_SECS: i64 = 14 * 24 * 3600;
/// A report identical to the newest stored row within this many seconds is not stored again.
const USAGE_DEDUPE_SECS: i64 = 120;

fn row_checkpoint(r: &Row) -> rusqlite::Result<CheckpointRecord> {
    Ok(CheckpointRecord {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        session_id: r.get("session_id")?,
        seq: r.get("seq")?,
        git_ref: r.get("git_ref")?,
        label: r.get("label")?,
        created_at: parse_ts(r.get("created_at")?),
    })
}

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default()
}

fn enum_parse<T: serde::de::DeserializeOwned>(s: Option<String>) -> Option<T> {
    s.and_then(|s| serde_json::from_value(Value::String(s)).ok())
}

fn parse_ts(s: String) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(&s).map(|d| d.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now())
}

fn row_project(r: &Row) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: r.get("id")?,
        name: r.get("name")?,
        path: r.get("path")?,
        target_os: enum_parse::<TargetOs>(r.get("target_os")?),
        project_type: enum_parse::<ProjectType>(r.get("project_type")?),
        stack_id: r.get("stack_id")?,
        github_url: r.get("github_url")?,
        default_provider: enum_parse::<Provider>(r.get("default_provider")?),
        default_model: r.get("default_model")?,
        default_effort: enum_parse::<Effort>(r.get("default_effort")?),
        default_permission: enum_parse::<PermissionPreset>(r.get("default_permission")?),
        auto_git: enum_parse::<AutoGit>(r.get("auto_git")?),
        created_at: parse_ts(r.get("created_at")?),
        last_opened_at: parse_ts(r.get("last_opened_at")?),
    })
}

fn row_usage(r: &Row) -> rusqlite::Result<UsageSample> {
    Ok(UsageSample {
        provider: enum_parse::<Provider>(r.get("provider")?).unwrap_or(Provider::Claude),
        account_id: r.get("account_id")?,
        window: RateLimitWindow {
            id: r.get("window_id")?,
            label: r.get("label")?,
            used_percent: r.get("used_percent")?,
            resets_at: r.get("resets_at")?,
            window_minutes: r.get("window_minutes")?,
        },
        observed_at: r.get("observed_at")?,
    })
}

fn row_session(r: &Row) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        provider: enum_parse::<Provider>(r.get("provider")?).unwrap_or(Provider::Claude),
        external_ref: r.get("external_ref")?,
        title: r.get("title")?,
        model: r.get("model")?,
        effort: enum_parse::<Effort>(r.get("effort")?),
        permission: enum_parse::<PermissionPreset>(r.get("permission")?).unwrap_or(PermissionPreset::AskEverything),
        total_cost_usd: r.get("total_cost_usd")?,
        archived: r.get::<_, Option<i64>>("archived").ok().flatten().unwrap_or(0) != 0,
        created_at: parse_ts(r.get("created_at")?),
        last_used_at: parse_ts(r.get("last_used_at")?),
    })
}

fn row_message(r: &Row) -> rusqlite::Result<MessageRecord> {
    let payload: String = r.get("payload_json")?;
    Ok(MessageRecord {
        id: r.get("id")?,
        session_id: r.get("session_id")?,
        seq: r.get("seq")?,
        kind: enum_parse::<MessageKind>(r.get("kind")?).unwrap_or(MessageKind::System),
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        created_at: parse_ts(r.get("created_at")?),
    })
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Db { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Db> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        let db = Db { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().map_err(|_| CoreError::msg("db mutex poisoned"))?;
        f(&conn)
    }

    fn migrate(&self) -> Result<()> {
        self.with_conn(|c| {
            c.execute_batch(SCHEMA)?;
            // sessions.archived was added after the first release.
            let has_archived = {
                let mut st = c.prepare("PRAGMA table_info(sessions)")?;
                let cols = st.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
                cols.iter().any(|n| n == "archived")
            };
            if !has_archived {
                c.execute_batch("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;")?;
            }
            // projects.auto_git (per-project auto commit/push) was added later as well.
            let has_auto_git = {
                let mut st = c.prepare("PRAGMA table_info(projects)")?;
                let cols = st.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
                cols.iter().any(|n| n == "auto_git")
            };
            if !has_auto_git {
                c.execute_batch("ALTER TABLE projects ADD COLUMN auto_git TEXT;")?;
            }
            Ok(())
        })
    }

    // ---- settings ----
    pub fn get_settings(&self) -> Result<AppSettings> {
        self.with_conn(|c| {
            let json: Option<String> =
                c.query_row("SELECT value_json FROM settings WHERE key='app'", [], |r| r.get(0)).optional()?;
            match json {
                Some(j) => Ok(serde_json::from_str(&j).unwrap_or_default()),
                None => Ok(AppSettings::default()),
            }
        })
    }

    pub fn set_settings(&self, s: &AppSettings) -> Result<()> {
        let json = serde_json::to_string(s)?;
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO settings(key, value_json) VALUES('app', ?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                params![json],
            )?;
            Ok(())
        })
    }

    // ---- projects ----
    pub fn list_projects(&self) -> Result<Vec<ProjectRecord>> {
        self.with_conn(|c| {
            let mut st = c.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC")?;
            let rows = st.query_map([], row_project)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    pub fn get_project(&self, id: &str) -> Result<ProjectRecord> {
        self.with_conn(|c| {
            c.query_row("SELECT * FROM projects WHERE id=?1", params![id], row_project)
                .optional()?
                .ok_or_else(|| CoreError::NotFound(format!("project {id}")))
        })
    }

    pub fn find_project_by_path(&self, path: &str) -> Result<Option<ProjectRecord>> {
        self.with_conn(|c| Ok(c.query_row("SELECT * FROM projects WHERE path=?1", params![path], row_project).optional()?))
    }

    pub fn upsert_project(&self, p: &ProjectRecord) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO projects(id,name,path,target_os,project_type,stack_id,github_url,default_provider,default_model,default_effort,default_permission,created_at,last_opened_at,auto_git)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, target_os=excluded.target_os, project_type=excluded.project_type,
                   stack_id=excluded.stack_id, github_url=excluded.github_url, default_provider=excluded.default_provider, default_model=excluded.default_model,
                   default_effort=excluded.default_effort, default_permission=excluded.default_permission, last_opened_at=excluded.last_opened_at,
                   auto_git=excluded.auto_git",
                params![
                    p.id,
                    p.name,
                    p.path,
                    p.target_os.as_ref().map(enum_str),
                    p.project_type.as_ref().map(enum_str),
                    p.stack_id,
                    p.github_url,
                    p.default_provider.as_ref().map(enum_str),
                    p.default_model,
                    p.default_effort.as_ref().map(enum_str),
                    p.default_permission.as_ref().map(enum_str),
                    p.created_at.to_rfc3339(),
                    p.last_opened_at.to_rfc3339(),
                    p.auto_git.as_ref().map(enum_str),
                ],
            )?;
            Ok(())
        })
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Result<ProjectRecord> {
        self.with_conn(|c| {
            if c.execute("UPDATE projects SET name=?2 WHERE id=?1", params![id, name])? == 0 {
                return Err(CoreError::NotFound(format!("project {id}")));
            }
            Ok(c.query_row("SELECT * FROM projects WHERE id=?1", params![id], row_project)?)
        })
    }

    pub fn update_project_settings(&self, id: &str, req: &ProjectSettingsUpdate, github_url: Option<&str>) -> Result<ProjectRecord> {
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            if tx.execute(
                "UPDATE projects SET name=?2,default_provider=?3,default_model=?4,default_effort=?5,default_permission=?6,
                 github_url=CASE WHEN ?7 THEN ?8 ELSE github_url END, auto_git=?9 WHERE id=?1",
                params![id, req.name, enum_str(&req.default_provider), req.default_model,
                    req.default_effort.as_ref().map(enum_str), enum_str(&req.default_permission), req.update_remote, github_url,
                    req.auto_git.as_ref().map(enum_str)],
            )? == 0 {
                return Err(CoreError::NotFound(format!("project {id}")));
            }
            tx.execute(
                "INSERT INTO project_accounts(project_id,value_json) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET value_json=excluded.value_json",
                params![id, serde_json::to_string(&req.accounts)?],
            )?;
            let updated = tx.query_row("SELECT * FROM projects WHERE id=?1", [id], row_project)?;
            tx.commit()?;
            Ok(updated)
        })
    }

    pub fn delete_project(&self, id: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute("DELETE FROM projects WHERE id=?1", params![id])?;
            Ok(())
        })
    }

    pub fn touch_project(&self, id: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute("UPDATE projects SET last_opened_at=?2 WHERE id=?1", params![id, Utc::now().to_rfc3339()])?;
            Ok(())
        })
    }

    // ---- sessions ----
    pub fn list_sessions(&self, project_id: &str) -> Result<Vec<SessionRecord>> {
        self.with_conn(|c| {
            let mut st = c.prepare("SELECT * FROM sessions WHERE project_id=?1 ORDER BY last_used_at DESC")?;
            let rows = st.query_map(params![project_id], row_session)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    pub fn get_session(&self, id: &str) -> Result<SessionRecord> {
        self.with_conn(|c| {
            c.query_row("SELECT * FROM sessions WHERE id=?1", params![id], row_session)
                .optional()?
                .ok_or_else(|| CoreError::NotFound(format!("session {id}")))
        })
    }

    pub fn upsert_session(&self, s: &SessionRecord) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO sessions(id,project_id,provider,external_ref,title,model,effort,permission,total_cost_usd,created_at,last_used_at,archived)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(id) DO UPDATE SET external_ref=excluded.external_ref,
                   title=CASE WHEN sessions.title='새 세션' THEN excluded.title ELSE sessions.title END,
                   model=excluded.model, effort=excluded.effort,
                   permission=excluded.permission, total_cost_usd=excluded.total_cost_usd, last_used_at=excluded.last_used_at",
                params![
                    s.id,
                    s.project_id,
                    enum_str(&s.provider),
                    s.external_ref,
                    s.title,
                    s.model,
                    s.effort.as_ref().map(enum_str),
                    enum_str(&s.permission),
                    s.total_cost_usd,
                    s.created_at.to_rfc3339(),
                    s.last_used_at.to_rfc3339(),
                    s.archived as i64,
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute("DELETE FROM sessions WHERE id=?1", params![id])?;
            Ok(())
        })
    }

    // ---- session management ----
    pub fn rename_session(&self, id: &str, title: &str) -> Result<()> {
        let title = title.trim();
        if title.is_empty() {
            return Err(CoreError::msg("제목을 입력하세요"));
        }
        self.with_conn(|c| {
            let n = c.execute("UPDATE sessions SET title=?2 WHERE id=?1", params![id, title])?;
            if n == 0 {
                return Err(CoreError::NotFound(format!("session {id}")));
            }
            Ok(())
        })
    }

    pub fn set_session_archived(&self, id: &str, archived: bool) -> Result<()> {
        self.with_conn(|c| {
            let n = c.execute("UPDATE sessions SET archived=?2 WHERE id=?1", params![id, archived as i64])?;
            if n == 0 {
                return Err(CoreError::NotFound(format!("session {id}")));
            }
            Ok(())
        })
    }

    // ---- checkpoints ----
    pub fn insert_checkpoint(&self, c: &CheckpointRecord, tree: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO checkpoints(id,project_id,session_id,seq,git_ref,tree,label,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![c.id, c.project_id, c.session_id, c.seq, c.git_ref, tree, c.label, c.created_at.to_rfc3339()],
            )?;
            Ok(())
        })
    }

    /// Newest first. `session_id` filters to one session when given.
    pub fn list_checkpoints(&self, project_id: &str, session_id: Option<&str>) -> Result<Vec<CheckpointRecord>> {
        self.with_conn(|c| {
            let rows = match session_id {
                Some(sid) => {
                    let mut st = c.prepare("SELECT * FROM checkpoints WHERE project_id=?1 AND session_id=?2 ORDER BY seq DESC")?;
                    let it = st.query_map(params![project_id, sid], row_checkpoint)?;
                    it.collect::<rusqlite::Result<Vec<_>>>()?
                }
                None => {
                    let mut st = c.prepare("SELECT * FROM checkpoints WHERE project_id=?1 ORDER BY seq DESC")?;
                    let it = st.query_map(params![project_id], row_checkpoint)?;
                    it.collect::<rusqlite::Result<Vec<_>>>()?
                }
            };
            Ok(rows)
        })
    }

    pub fn get_checkpoint(&self, id: &str) -> Result<CheckpointRecord> {
        self.with_conn(|c| {
            c.query_row("SELECT * FROM checkpoints WHERE id=?1", params![id], row_checkpoint)
                .optional()?
                .ok_or_else(|| CoreError::NotFound(format!("checkpoint {id}")))
        })
    }

    /// Tree hash stored with a checkpoint (used to skip no-op snapshots and for diffs).
    pub fn checkpoint_tree(&self, id: &str) -> Result<Option<String>> {
        self.with_conn(|c| Ok(c.query_row("SELECT tree FROM checkpoints WHERE id=?1", params![id], |r| r.get(0)).optional()?))
    }

    /// Tree hash of the newest checkpoint of a project.
    pub fn latest_checkpoint_tree(&self, project_id: &str) -> Result<Option<(String, String)>> {
        self.with_conn(|c| {
            Ok(c.query_row(
                "SELECT id, tree FROM checkpoints WHERE project_id=?1 ORDER BY seq DESC LIMIT 1",
                params![project_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?)
        })
    }

    pub fn next_checkpoint_seq(&self, project_id: &str) -> Result<i64> {
        self.with_conn(|c| {
            Ok(c.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM checkpoints WHERE project_id=?1", params![project_id], |r| r.get(0))?)
        })
    }

    pub fn delete_checkpoint(&self, id: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute("DELETE FROM checkpoints WHERE id=?1", params![id])?;
            Ok(())
        })
    }

    // ---- usage samples (subscription rate-limit windows, for the usage graph) ----
    /// Store one report. Rows identical to the newest stored row of the same window (within
    /// `USAGE_DEDUPE_SECS`) are skipped so a busy turn does not flood the table. Returns how many rows were written.
    pub fn insert_usage_samples(&self, provider: Provider, account_id: Option<&str>, windows: &[RateLimitWindow], observed_at: i64) -> Result<usize> {
        self.with_conn(|c| {
            let mut written = 0;
            for w in windows {
                let last: Option<(f64, Option<i64>, i64)> = c
                    .query_row(
                        "SELECT used_percent, resets_at, observed_at FROM usage_samples WHERE provider=?1 AND account_id IS ?2 AND window_id=?3 ORDER BY observed_at DESC, id DESC LIMIT 1",
                        params![enum_str(&provider), account_id, w.id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                if let Some((pct, resets, at)) = last {
                    if (pct - w.used_percent).abs() < 0.01 && resets == w.resets_at && observed_at - at < USAGE_DEDUPE_SECS {
                        continue;
                    }
                }
                c.execute(
                    "INSERT INTO usage_samples(provider,account_id,window_id,label,used_percent,resets_at,window_minutes,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![enum_str(&provider), account_id, w.id, w.label, w.used_percent, w.resets_at, w.window_minutes, observed_at],
                )?;
                written += 1;
            }
            if written > 0 {
                c.execute("DELETE FROM usage_samples WHERE observed_at < ?1", params![observed_at - USAGE_RETENTION_SECS])?;
            }
            Ok(written)
        })
    }

    /// Samples of one account newer than `since` (epoch seconds), oldest first.
    pub fn list_usage_samples(&self, provider: Provider, account_id: Option<&str>, since: i64) -> Result<Vec<UsageSample>> {
        self.with_conn(|c| {
            let mut st = c.prepare("SELECT * FROM usage_samples WHERE provider=?1 AND account_id IS ?2 AND observed_at >= ?3 ORDER BY observed_at, id")?;
            let rows = st.query_map(params![enum_str(&provider), account_id, since], row_usage)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Newest sample of every (provider, account, window).
    pub fn latest_usage_samples(&self) -> Result<Vec<UsageSample>> {
        self.with_conn(|c| {
            let mut st = c.prepare(
                "SELECT u.* FROM usage_samples u JOIN (SELECT provider, account_id, window_id, MAX(id) AS id FROM usage_samples GROUP BY provider, account_id, window_id) m ON m.id = u.id ORDER BY u.provider, u.account_id, u.window_id",
            )?;
            let rows = st.query_map([], row_usage)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    // ---- messages ----
    pub fn append_message(&self, session_id: &str, kind: MessageKind, payload: Value) -> Result<MessageRecord> {
        self.with_conn(|c| {
            let seq: i64 = c.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id=?1",
                params![session_id],
                |r| r.get(0),
            )?;
            let rec = MessageRecord {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                seq,
                kind,
                payload,
                created_at: Utc::now(),
            };
            c.execute(
                "INSERT INTO messages(id,session_id,seq,kind,payload_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![rec.id, rec.session_id, rec.seq, enum_str(&rec.kind), serde_json::to_string(&rec.payload)?, rec.created_at.to_rfc3339()],
            )?;
            c.execute("UPDATE sessions SET last_used_at=?2 WHERE id=?1", params![session_id, rec.created_at.to_rfc3339()])?;
            Ok(rec)
        })
    }

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<MessageRecord>> {
        self.with_conn(|c| {
            let mut st = c.prepare("SELECT * FROM messages WHERE session_id=?1 ORDER BY seq")?;
            let rows = st.query_map(params![session_id], row_message)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str) -> ProjectRecord {
        ProjectRecord {
            id: id.into(),
            name: "p".into(),
            path: format!("C:\\p\\{id}"),
            target_os: Some(TargetOs::Windows),
            project_type: Some(ProjectType::DesktopApp),
            stack_id: Some("tauri".into()),
            github_url: None,
            default_provider: Some(Provider::Claude),
            default_model: None,
            default_effort: Some(Effort::High),
            default_permission: Some(PermissionPreset::AutoEdit),
            auto_git: Some(AutoGit::Commit),
            created_at: Utc::now(),
            last_opened_at: Utc::now(),
        }
    }

    #[test]
    fn roundtrip() {
        let db = Db::open_in_memory().unwrap();
        assert!(!db.get_settings().unwrap().onboarding_done);
        let mut s = AppSettings::default();
        s.onboarding_done = true;
        db.set_settings(&s).unwrap();
        assert!(db.get_settings().unwrap().onboarding_done);

        db.upsert_project(&project("a")).unwrap();
        let got = db.get_project("a").unwrap();
        assert_eq!(got.target_os, Some(TargetOs::Windows));
        assert_eq!(got.default_effort, Some(Effort::High));
        assert_eq!(got.auto_git, Some(AutoGit::Commit));
        assert_eq!(db.list_projects().unwrap().len(), 1);
        assert!(db.find_project_by_path("C:\\p\\a").unwrap().is_some());

        let sess = SessionRecord {
            id: "s1".into(),
            project_id: "a".into(),
            provider: Provider::Codex,
            external_ref: None,
            title: "t".into(),
            model: Some("gpt".into()),
            effort: Some(Effort::XHigh),
            permission: PermissionPreset::FullAuto,
            total_cost_usd: 0.0,
            archived: false,
            created_at: Utc::now(),
            last_used_at: Utc::now(),
        };
        db.upsert_session(&sess).unwrap();
        assert_eq!(db.list_sessions("a").unwrap()[0].provider, Provider::Codex);
        let m = db.append_message("s1", MessageKind::User, serde_json::json!({"text": "hi"})).unwrap();
        assert_eq!(m.seq, 1);
        let m2 = db.append_message("s1", MessageKind::Assistant, serde_json::json!({"text": "yo"})).unwrap();
        assert_eq!(m2.seq, 2);
        assert_eq!(db.list_messages("s1").unwrap().len(), 2);

        // rename / archive; the manager's upsert must not clobber a user rename
        db.rename_session("s1", "내 세션").unwrap();
        db.set_session_archived("s1", true).unwrap();
        let mut again = sess.clone();
        again.title = "t2".into();
        db.upsert_session(&again).unwrap();
        let got = db.get_session("s1").unwrap();
        assert_eq!(got.title, "내 세션");
        assert!(got.archived);
        assert!(db.rename_session("missing", "x").is_err());

        // checkpoints
        assert_eq!(db.next_checkpoint_seq("a").unwrap(), 1);
        let cp = CheckpointRecord {
            id: "c1".into(),
            project_id: "a".into(),
            session_id: Some("s1".into()),
            seq: 1,
            git_ref: "abc".into(),
            label: "first".into(),
            created_at: Utc::now(),
        };
        db.insert_checkpoint(&cp, "tree1").unwrap();
        assert_eq!(db.next_checkpoint_seq("a").unwrap(), 2);
        assert_eq!(db.latest_checkpoint_tree("a").unwrap(), Some(("c1".into(), "tree1".into())));
        assert_eq!(db.checkpoint_tree("c1").unwrap().as_deref(), Some("tree1"));
        assert_eq!(db.list_checkpoints("a", Some("s1")).unwrap().len(), 1);
        assert_eq!(db.list_checkpoints("a", Some("other")).unwrap().len(), 0);
        assert_eq!(db.get_checkpoint("c1").unwrap().label, "first");
        db.delete_checkpoint("c1").unwrap();
        assert!(db.get_checkpoint("c1").is_err());

        db.delete_project("a").unwrap();
        assert!(db.list_sessions("a").unwrap().is_empty());
        assert!(db.list_messages("s1").unwrap().is_empty());
    }

    #[test]
    fn migrates_archived_column_on_old_schema() {
        let conn = Connection::open_in_memory().unwrap();
        // Old sessions table without `archived`.
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, target_os TEXT, project_type TEXT, stack_id TEXT, github_url TEXT, default_provider TEXT, default_model TEXT, default_effort TEXT, default_permission TEXT, created_at TEXT NOT NULL, last_opened_at TEXT NOT NULL);
             CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider TEXT NOT NULL, external_ref TEXT, title TEXT NOT NULL, model TEXT, effort TEXT, permission TEXT NOT NULL, total_cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL);",
        )
        .unwrap();
        let db = Db { conn: Mutex::new(conn) };
        db.migrate().unwrap();
        db.migrate().unwrap(); // idempotent
        db.upsert_project(&project("p")).unwrap();
        assert!(db.list_sessions("p").unwrap().is_empty());
        assert_eq!(db.get_project("p").unwrap().auto_git, Some(AutoGit::Commit));
    }

    #[test]
    fn usage_samples_dedupe_and_latest() {
        let db = Db::open_in_memory().unwrap();
        let w = |pct: f64| RateLimitWindow { id: "five_hour".into(), label: "5시간".into(), used_percent: pct, resets_at: Some(1_000), window_minutes: Some(300) };
        assert_eq!(db.insert_usage_samples(Provider::Claude, Some("acc"), &[w(10.0)], 100).unwrap(), 1);
        // identical report shortly after: skipped
        assert_eq!(db.insert_usage_samples(Provider::Claude, Some("acc"), &[w(10.0)], 130).unwrap(), 0);
        // changed value: stored
        assert_eq!(db.insert_usage_samples(Provider::Claude, Some("acc"), &[w(12.5)], 140).unwrap(), 1);
        // another account is independent
        assert_eq!(db.insert_usage_samples(Provider::Codex, None, &[w(50.0)], 150).unwrap(), 1);
        let hist = db.list_usage_samples(Provider::Claude, Some("acc"), 0).unwrap();
        assert_eq!(hist.iter().map(|s| s.window.used_percent).collect::<Vec<_>>(), vec![10.0, 12.5]);
        let latest = db.latest_usage_samples().unwrap();
        assert_eq!(latest.len(), 2);
        assert!(latest.iter().any(|s| s.provider == Provider::Claude && s.window.used_percent == 12.5));
    }
}
