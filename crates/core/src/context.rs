//! Process-wide state shared by every command.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::agents::codex::CodexHost;
use crate::agents::SessionManager;
use crate::backend::ExecBackend;
use crate::db::Db;
use crate::error::Result;
use crate::permission::PermissionBroker;
use crate::preview::DevServerManager;
use crate::pty::PtyManager;
use crate::types::{AppSettings, Provider};

pub struct AppContext {
    pub data_dir: PathBuf,
    pub db: Db,
    settings: RwLock<AppSettings>,
    backend: Arc<ExecBackend>,
    pub sessions: SessionManager,
    pub permission: RwLock<Option<Arc<PermissionBroker>>>,
    account_hosts: tokio::sync::Mutex<std::collections::HashMap<String, Arc<CodexHost>>>,
    pub pty: Arc<PtyManager>,
    pub login_gate: Arc<tokio::sync::Mutex<()>>,
    pub(crate) login_guards: std::sync::Mutex<std::collections::HashMap<String, crate::tools::login::LoginGuard>>,
    pub account_changes: tokio::sync::Mutex<()>,
    pub preview: Arc<DevServerManager>,
    /// Keeps CLAUDE.md / AGENTS.md identical in every registered project.
    pub docs_sync: crate::projects::docs_sync::DocsWatcher,
}

impl AppContext {
    pub async fn init(data_dir: PathBuf) -> Result<Arc<AppContext>> {
        std::fs::create_dir_all(&data_dir)?;
        let db = Db::open(&data_dir.join("vibecode.db"))?;
        crate::accounts::migrate(&db)?;
        let mut settings = db.get_settings().unwrap_or_default();
        settings.theme = "dark".into();
        let backend = Arc::new(ExecBackend::new());
        let docs_sync = crate::projects::docs_sync::DocsWatcher::new();
        for p in db.list_projects().unwrap_or_default() {
            let dir = PathBuf::from(&p.path);
            if dir.is_dir() {
                crate::projects::docs_sync::reconcile_quietly(&dir);
                docs_sync.watch(&dir);
            }
        }
        Ok(Arc::new(AppContext {
            data_dir,
            db,
            settings: RwLock::new(settings),
            backend,
            sessions: SessionManager::new(),
            permission: RwLock::new(None),
            account_hosts: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            pty: Arc::new(PtyManager::new()),
            login_gate: Arc::new(tokio::sync::Mutex::new(())),
            login_guards: std::sync::Mutex::new(std::collections::HashMap::new()),
            account_changes: tokio::sync::Mutex::new(()),
            preview: Arc::new(DevServerManager::new()),
            docs_sync,
        }))
    }

    pub async fn settings(&self) -> AppSettings {
        self.settings.read().await.clone()
    }

    /// Persist settings. A changed codex binary takes effect on the next app-server start.
    pub async fn update_settings(&self, mut new: AppSettings) -> Result<AppSettings> {
        new.theme = "dark".into();
        let codex_changed = self.settings.read().await.codex_bin != new.codex_bin;
        self.db.set_settings(&new)?;
        if codex_changed {
            let hosts: Vec<_> = self.account_hosts.lock().await.drain().map(|(_,h)| h).collect();
            for host in hosts { host.shutdown().await; }
        }
        *self.settings.write().await = new.clone();
        Ok(new)
    }

    pub async fn account_host(&self, key: &str) -> Arc<CodexHost> {
        self.account_hosts.lock().await.entry(key.to_string()).or_insert_with(|| Arc::new(CodexHost::new())).clone()
    }

    pub async fn stop_account_hosts(&self, id: &str) {
        let mut hosts = self.account_hosts.lock().await;
        let keys: Vec<_> = hosts.keys().filter(|k| k.contains(id)).cloned().collect();
        let removed: Vec<_> = keys.iter().filter_map(|k| hosts.remove(k)).collect();
        drop(hosts);
        for host in removed { host.shutdown().await; }
    }

    pub async fn backend(&self) -> Arc<ExecBackend> {
        self.backend.clone()
    }

    /// Shared PTY manager (login flows keep a handle to write back into their PTY).
    pub fn pty_handle(&self) -> Arc<PtyManager> {
        self.pty.clone()
    }

    /// Lazily start the permission MCP server.
    pub async fn permission_broker(&self) -> Result<Arc<PermissionBroker>> {
        if let Some(b) = self.permission.read().await.as_ref() {
            return Ok(b.clone());
        }
        let b = PermissionBroker::start().await?;
        *self.permission.write().await = Some(b.clone());
        Ok(b)
    }

    /// Binary override for a provider from settings.
    pub async fn bin_override(&self, provider: Provider) -> Option<String> {
        let s = self.settings.read().await;
        match provider {
            Provider::Claude => s.claude_bin.clone(),
            Provider::Codex => s.codex_bin.clone(),
        }
        .filter(|v| !v.trim().is_empty())
    }

    pub async fn git_bin(&self) -> Option<String> {
        self.settings.read().await.git_bin.clone().filter(|v| !v.trim().is_empty())
    }

    pub async fn shutdown(&self) {
        self.preview.stop_all().await;
        self.sessions.close_all().await;
        let hosts: Vec<_> = self.account_hosts.lock().await.drain().map(|(_,h)| h).collect();
        for host in hosts { host.shutdown().await; }
    }
}
