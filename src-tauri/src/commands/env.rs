//! Managed environment (app-owned WSL distro) commands.
use tauri::ipc::Channel;
use vibecode_core::managed;
use vibecode_core::types::{ProvisionEvent, WslStatus};

use crate::state::err;

#[tauri::command]
pub async fn env_wsl_status() -> Result<WslStatus, String> {
    Ok(managed::wsl_status().await)
}

/// Runs `wsl --install --no-distribution` elevated; resolves with the exit code once the UAC'd process ends.
#[tauri::command]
pub async fn env_install_wsl() -> Result<i32, String> {
    managed::install_wsl().await.map_err(err)
}

#[tauri::command]
pub async fn env_reboot() -> Result<(), String> {
    managed::reboot().await.map_err(err)
}

/// Streams ProvisionEvents; resolves when provisioning finished (Ok) or failed (Err).
#[tauri::command]
pub async fn env_provision(on_event: Channel<ProvisionEvent>) -> Result<(), String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ProvisionEvent>();
    let forward = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = on_event.send(ev);
        }
    });
    let res = managed::provision(tx).await.map_err(err);
    let _ = forward.await;
    res
}

#[tauri::command]
pub async fn env_remove_managed() -> Result<(), String> {
    managed::remove().await.map_err(err)
}
