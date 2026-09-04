//! Tauri shell around `vibecode_core`. Commands live in `commands/`; each is a thin
//! wrapper that converts core results into `Result<T, String>` for the frontend.

mod commands;
mod state;

use tauri::Manager;

pub use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("vibecode_core", log::LevelFilter::Debug)
                .level_for("vibecode_app", log::LevelFilter::Debug)
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("app data dir");
            let ctx = tauri::async_runtime::block_on(vibecode_core::AppContext::init(data_dir))
                .map_err(|e| anyhow::anyhow!("core init failed: {e}"))?;
            app.manage(AppState::new(ctx));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    let ctx = state.ctx.clone();
                    tauri::async_runtime::block_on(ctx.shutdown());
                }
            }
        })
        .invoke_handler(commands::handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
