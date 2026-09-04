//! SQLite persistence. Single connection behind a mutex; all methods are sync and
//! cheap. Call from async code directly (rusqlite ops here are sub-millisecond).

use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::types::{
    AppSettings, CheckpointRecord, Effort, MessageKind, MessageRecord, PermissionPreset, ProjectRecord, ProjectType, Provider,
    SessionRecord, TargetOs,
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
"#;

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
        created_at: parse_ts(r.get("created_at")?),
        last_opened_at: parse_ts(r.get("last_opened_at")?),
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
        self.with_conn(|c| Ok(c.execute_batch(SCHEMA)?))
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
                "INSERT INTO projects(id,name,path,target_os,project_type,stack_id,github_url,default_provider,default_model,default_effort,default_permission,created_at,last_opened_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, target_os=excluded.target_os, project_type=excluded.project_type,
                   stack_id=excluded.stack_id, github_url=excluded.github_url, default_provider=excluded.default_provider, default_model=excluded.default_model,
                   default_effort=excluded.default_effort, default_permission=excluded.default_permission, last_opened_at=excluded.last_opened_at",
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
                ],
            )?;
            Ok(())
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
                "INSERT INTO sessions(id,project_id,provider,external_ref,title,model,effort,permission,total_cost_usd,created_at,last_used_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                 ON CONFLICT(id) DO UPDATE SET external_ref=excluded.external_ref, title=excluded.title, model=excluded.model, effort=excluded.effort,
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

    // ---- session management (implemented by the checkpoints/fs fork) ----
    pub fn rename_session(&self, _id: &str, _title: &str) -> Result<()> {
        Err(CoreError::NotImplemented("db::rename_session"))
    }
    pub fn set_session_archived(&self, _id: &str, _archived: bool) -> Result<()> {
        Err(CoreError::NotImplemented("db::set_session_archived"))
    }

    // ---- checkpoints ----
    pub fn insert_checkpoint(&self, _c: &CheckpointRecord) -> Result<()> {
        Err(CoreError::NotImplemented("db::insert_checkpoint"))
    }
    pub fn list_checkpoints(&self, _project_id: &str, _session_id: Option<&str>) -> Result<Vec<CheckpointRecord>> {
        Err(CoreError::NotImplemented("db::list_checkpoints"))
    }
    pub fn get_checkpoint(&self, _id: &str) -> Result<CheckpointRecord> {
        Err(CoreError::NotImplemented("db::get_checkpoint"))
    }
    pub fn next_checkpoint_seq(&self, _project_id: &str) -> Result<i64> {
        Err(CoreError::NotImplemented("db::next_checkpoint_seq"))
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

        db.delete_project("a").unwrap();
        assert!(db.list_sessions("a").unwrap().is_empty());
        assert!(db.list_messages("s1").unwrap().is_empty());
    }
}
