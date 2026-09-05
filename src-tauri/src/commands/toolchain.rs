//! Windows toolchain used from WSL (cargo.exe, node.exe, dotnet.exe ... through interop).
use tauri::State;
use vibecode_core::toolchain;
use vibecode_core::types::WindowsToolStatus;

use crate::state::{err, AppState};

/// Detect the Windows toolchains a stack needs (all known ones when `stack_id` is None / unknown).
#[tauri::command]
pub async fn toolchain_status(stack_id: Option<String>) -> Result<Vec<WindowsToolStatus>, String> {
    let names = match stack_id.as_deref().and_then(|id| vibecode_core::projects::catalog::get(id).ok().flatten()) {
        Some(stack) => stack.windows_toolchain,
        None => vec![],
    };
    Ok(toolchain::detect(&names).await)
}

/// PowerShell script that installs the named toolchains with winget (run in the host terminal).
#[tauri::command]
pub async fn toolchain_install_script(names: Vec<String>) -> Result<String, String> {
    Ok(toolchain::install_script(&names))
}

/// Detect every toolchain and (re)write the `~/.local/bin` shims in the active WSL distro. Returns the shim names.
#[tauri::command]
pub async fn toolchain_write_shims(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let backend = state.ctx.backend().await;
    let statuses = toolchain::detect(&[]).await;
    toolchain::write_shims(backend, &statuses).await.map_err(err)
}
