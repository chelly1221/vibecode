//! IPC surface. Command names are the contract with `src/lib/ipc.ts`; keep both in sync.

pub mod git;
pub mod github;
pub mod projects;
pub mod pty;
pub mod sessions;
pub mod settings;
pub mod tools;

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        settings::settings_get,
        settings::settings_set,
        tools::tools_detect,
        tools::tools_auth_status,
        tools::tools_list_wsl_distros,
        tools::models_list,
        projects::projects_list,
        projects::projects_get,
        projects::projects_create,
        projects::projects_open,
        projects::projects_remove,
        projects::stacks_list,
        projects::stacks_recommend,
        sessions::session_start,
        sessions::session_send,
        sessions::session_interrupt,
        sessions::session_permission_reply,
        sessions::session_update_config,
        sessions::session_close,
        sessions::sessions_list,
        sessions::session_messages,
        sessions::session_delete,
        git::git_status,
        git::git_diff,
        git::git_stage,
        git::git_unstage,
        git::git_commit,
        git::git_push,
        git::git_pull,
        git::git_fetch,
        git::git_branches,
        git::git_checkout,
        git::git_log,
        git::git_generate_commit_message,
        github::github_set_token,
        github::github_clear_token,
        github::github_whoami,
        github::github_create_repo,
        pty::pty_open,
        pty::pty_write,
        pty::pty_resize,
        pty::pty_close,
    ]
}
