//! Interactive terminal sessions (portable-pty / ConPTY) for login flows and a
//! general-purpose terminal. Runs through the backend: natively PowerShell,
//! in WSL `wsl.exe -d <distro> -- bash -l`.

use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::{PtyEvent, PtySpec};

pub type PtyCallback = Box<dyn Fn(PtyEvent) + Send + Sync + 'static>;

#[derive(Default)]
pub struct PtyManager {}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {}
    }

    /// Open a pty; returns its id. `on_event` is called from a reader thread.
    pub fn open(&self, backend: Arc<dyn ExecBackend>, spec: PtySpec, on_event: PtyCallback) -> Result<String> {
        let _ = (backend, spec, on_event);
        Err(CoreError::NotImplemented("pty::open"))
    }
    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let _ = (id, data);
        Err(CoreError::NotImplemented("pty::write"))
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let _ = (id, cols, rows);
        Err(CoreError::NotImplemented("pty::resize"))
    }
    pub fn close(&self, id: &str) -> Result<()> {
        let _ = id;
        Err(CoreError::NotImplemented("pty::close"))
    }
}
