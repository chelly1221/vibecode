//! Process-wide state shared by every command.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::agents::codex::CodexHost;
use crate::agents::SessionManager;
use crate::backend::{create_backend, ExecBackend};
use crate::db::Db;
use crate::error::Result;
use crate::permission::PermissionBroker;
use crate::pty::PtyManager;
use crate::types::{AppSettings, Provider};

pub struct AppContext {
    pub data_dir: PathBuf,
    pub db: Db,
    settings: RwLock<AppSettings>,
    backend: RwLock<Arc<dyn ExecBackend>>,
    pub sessions: SessionManager,
    pub permission: RwLock<Option<Arc<PermissionBroker>>>,
    pub codex: CodexHost,
    pub pty: PtyManager,
}

impl AppContext {
    pub async fn init(data_dir: PathBuf) -> Result<Arc<AppContext>> {
        std::fs::create_dir_all(&data_dir)?;
        let db = Db::open(&data_dir.join("vibecode.db"))?;
        let settings = db.get_settings().unwrap_or_default();
        let backend = match create_backend(&settings.backend).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("backend init failed ({e}); falling back to native");
                Arc::new(crate::backend::native::NativeBackend::new())
            }
        };
        Ok(Arc::new(AppContext {
            data_dir,
            db,
            settings: RwLock::new(settings),
            backend: RwLock::new(backend),
            sessions: SessionManager::new(),
            permission: RwLock::new(None),
            codex: CodexHost::new(),
            pty: PtyManager::new(),
        }))
    }

    pub async fn settings(&self) -> AppSettings {
        self.settings.read().await.clone()
    }

    /// Persist settings and rebuild the backend if it changed.
    pub async fn update_settings(&self, new: AppSettings) -> Result<AppSettings> {
        let backend_changed = self.settings.read().await.backend != new.backend;
        self.db.set_settings(&new)?;
        if backend_changed {
            let b = create_backend(&new.backend).await?;
            *self.backend.write().await = b;
            self.codex.shutdown().await;
        }
        *self.settings.write().await = new.clone();
        Ok(new)
    }

    pub async fn backend(&self) -> Arc<dyn ExecBackend> {
        self.backend.read().await.clone()
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
        self.sessions.close_all().await;
        self.codex.shutdown().await;
    }
}
