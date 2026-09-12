use std::path::{Path, PathBuf};

use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use vibecode_core::types::{ExportEvent, SelfBuildInfo};

use crate::state::{err, AppState};

/// Source checkout, running exe and build mode for the "새 빌드 적용" dialog.
#[tauri::command]
pub async fn self_build_info(state: State<'_, AppState>) -> Result<SelfBuildInfo, String> {
    Ok(vibecode_core::selfbuild::info(&state.ctx).await)
}

/// Build the app in `repo` while it keeps running; streams the build log, resolves with the built exe.
#[tauri::command]
pub async fn self_build_run(state: State<'_, AppState>, repo: String, on_event: Channel<ExportEvent>) -> Result<String, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ExportEvent>();
    let forward = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = on_event.send(ev);
        }
    });
    let res = vibecode_core::selfbuild::build(state.ctx.clone(), Path::new(&repo), tx).await.map_err(err);
    let _ = forward.await;
    res
}

/// Hand over to the swap script (copy `built_exe` over the running exe and restart; or, with
/// `built_exe` = None, build after exit) and quit the app. Resolves with the script's log path.
#[tauri::command]
pub async fn self_build_apply(app: AppHandle, state: State<'_, AppState>, repo: String, built_exe: Option<String>) -> Result<String, String> {
    let info = vibecode_core::selfbuild::info(&state.ctx).await;
    let current = PathBuf::from(&info.current_exe);
    if info.current_exe.is_empty() || !current.is_file() {
        return Err("현재 실행 파일 위치를 알 수 없습니다".into());
    }
    let built = built_exe.map(PathBuf::from);
    if let Some(b) = &built {
        if !b.is_file() {
            return Err(format!("빌드된 실행 파일이 없습니다: {}", b.display()));
        }
    }
    let log = vibecode_core::selfbuild::spawn_swap(Path::new(&repo), &current, built.as_deref()).map_err(err)?;
    state.ctx.shutdown().await;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        app.exit(0);
    });
    Ok(log.to_string_lossy().into_owned())
}
