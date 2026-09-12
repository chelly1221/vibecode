// Typed wrappers for every Tauri command. This file and
// src-tauri/src/commands/mod.rs are the IPC contract: keep them in sync.
// Argument keys are camelCase (Tauri converts to the Rust snake_case params).

import type { AccountProfile } from "./bindings/AccountProfile";
import type { AccountKind } from "./bindings/AccountKind";
import type { ProjectAccounts } from "./bindings/ProjectAccounts";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentDocsStatus } from "./bindings/AgentDocsStatus";
import type { AgentQuestion } from "./bindings/AgentQuestion";
import type { AppSettings } from "./bindings/AppSettings";
import type { CheckpointRecord } from "./bindings/CheckpointRecord";
import type { FsEntry } from "./bindings/FsEntry";
import type { FsFile } from "./bindings/FsFile";
import type { McpServerConfig } from "./bindings/McpServerConfig";
import type { QuestionAnswer } from "./bindings/QuestionAnswer";
import type { SshKeyInfo } from "./bindings/SshKeyInfo";
import type { StackRecommendRequest } from "./bindings/StackRecommendRequest";
import type { StackRecommendation } from "./bindings/StackRecommendation";
import type { AuthStatus } from "./bindings/AuthStatus";
import type { AutoGit } from "./bindings/AutoGit";
import type { ExportEvent } from "./bindings/ExportEvent";
import type { RateLimitWindow } from "./bindings/RateLimitWindow";
import type { SelfBuildInfo } from "./bindings/SelfBuildInfo";
import type { StackExport } from "./bindings/StackExport";
import type { UsageSample } from "./bindings/UsageSample";
import type { CreateProjectRequest } from "./bindings/CreateProjectRequest";
import type { GitBranch } from "./bindings/GitBranch";
import type { GitCommit } from "./bindings/GitCommit";
import type { GitHubRepo } from "./bindings/GitHubRepo";
import type { GitHubUser } from "./bindings/GitHubUser";
import type { GitStatus } from "./bindings/GitStatus";
import type { MessageRecord } from "./bindings/MessageRecord";
import type { LoginEvent } from "./bindings/LoginEvent";
import type { ModelInfo } from "./bindings/ModelInfo";
import type { ToolInstallEvent } from "./bindings/ToolInstallEvent";
import type { PermissionReply } from "./bindings/PermissionReply";
import type { PreviewEvent } from "./bindings/PreviewEvent";
import type { PreviewStatus } from "./bindings/PreviewStatus";
import type { ProjectPlan } from "./bindings/ProjectPlan";
import type { ProjectPlanRequest } from "./bindings/ProjectPlanRequest";
import type { ProjectRecord } from "./bindings/ProjectRecord";
import type { ProjectRemoteStatus } from "./bindings/ProjectRemoteStatus";
import type { ProjectSettingsUpdate } from "./bindings/ProjectSettingsUpdate";
import type { ProjectType } from "./bindings/ProjectType";
import type { Provider } from "./bindings/Provider";
import type { PtyEvent } from "./bindings/PtyEvent";
import type { PtySpec } from "./bindings/PtySpec";
import type { ScaffoldEvent } from "./bindings/ScaffoldEvent";
import type { SessionConfig } from "./bindings/SessionConfig";
import type { SessionConfigPatch } from "./bindings/SessionConfigPatch";
import type { SessionEvent } from "./bindings/SessionEvent";
import type { SessionRecord } from "./bindings/SessionRecord";
import type { StackInfo } from "./bindings/StackInfo";
import type { TargetOs } from "./bindings/TargetOs";
import type { ToolStatus } from "./bindings/ToolStatus";

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function channel<T>(handler: (msg: T) => void): Channel<T> {
  const ch = new Channel<T>();
  ch.onmessage = handler;
  return ch;
}

export const ipc = {
  accounts: {
    list: () => invoke<AccountProfile[]>("accounts_list"),
    create: (name: string, kind: AccountKind) => invoke<AccountProfile>("accounts_create", { name, kind }),
    remove: (id: string) => invoke<void>("accounts_remove", { id }),
    project: (projectId: string) => invoke<ProjectAccounts>("accounts_project_get", { projectId }),
    setProject: (projectId: string, selected: ProjectAccounts) => invoke<ProjectAccounts>("accounts_project_set", { projectId, selected }),
    session: (sessionId: string) => invoke<ProjectAccounts>("accounts_session_get", { sessionId }),
  },
  settings: {
    get: () => invoke<AppSettings>("settings_get"),
    set: (settings: AppSettings) => invoke<AppSettings>("settings_set", { settings }),
  },

  tools: {
    /** Detect tools on the Windows host (honours the binaries set in settings). */
    detect: () => invoke<ToolStatus[]>("tools_detect"),
    /** Login state of a provider's CLI. */
    authStatus: (provider: Provider, accountId?: string | null) => invoke<AuthStatus>("tools_auth_status", { provider, accountId: accountId ?? null }),
    /** Install a known tool in the background (winget / install script); streams log lines, resolves with the re-detected status. */
    install: (name: string, onEvent: (e: ToolInstallEvent) => void) => invoke<ToolStatus>("tools_install", { name, onEvent: channel(onEvent) }),
    /** GUI login: runs the CLI login in a hidden PTY and streams URL / code prompt / result. Resolves with the login id. */
    loginStart: (provider: Provider, onEvent: (e: LoginEvent) => void, accountId?: string) => invoke<string>("tools_login_start", { provider, accountId, onEvent: channel(onEvent) }),
    loginCode: (loginId: string, code: string) => invoke<void>("tools_login_code", { loginId, code }),
    loginCancel: (loginId: string) => invoke<void>("tools_login_cancel", { loginId }),
    listModels: (provider: Provider, accountId?: string | null, projectId?: string | null) => invoke<ModelInfo[]>("models_list", { provider, accountId, projectId }),
  },

  env: {
    /** SSH key on the active backend (for GitHub pushes). */
    sshKeyInfo: () => invoke<SshKeyInfo>("env_ssh_key_info"),
    sshGenerateKey: () => invoke<SshKeyInfo>("env_ssh_generate_key"),
    /** Resolves with the GitHub username when the key is registered. */
    sshTestGithub: () => invoke<string>("env_ssh_test_github"),
  },

  projects: {
    list: () => invoke<ProjectRecord[]>("projects_list"),
    get: (id: string) => invoke<ProjectRecord>("projects_get", { id }),
    /** Streams ScaffoldEvents to `onEvent`; resolves with the created project. */
    create: (req: CreateProjectRequest, onEvent: (e: ScaffoldEvent) => void) =>
      invoke<ProjectRecord>("projects_create", { req, onEvent: channel(onEvent) }),
    /** Register an existing directory (created outside the app); stack is detected heuristically. */
    open: (path: string, name?: string) => invoke<ProjectRecord>("projects_open", { path, name: name ?? null }),
    rename: (id: string, name: string) => invoke<ProjectRecord>("projects_rename", { id, name }),
    update: (id: string, req: ProjectSettingsUpdate) => invoke<ProjectRecord>("projects_update", { id, req }),
    remoteStatus: (id: string) => invoke<ProjectRemoteStatus>("projects_remote_status", { id }),
    agentDocsStatus: (id: string) => invoke<AgentDocsStatus>("projects_agent_docs_status", { id }),
    /** Make CLAUDE.md / AGENTS.md identical (missing one cloned, newest wins); resolves with the file written, if any. */
    syncAgentDocs: (id: string) => invoke<string[]>("projects_sync_agent_docs", { id }),
    /** Write CLAUDE.md / AGENTS.md when missing; resolves with the file names written. */
    generateAgentDocs: (id: string, description?: string) =>
      invoke<string[]>("projects_generate_agent_docs", { id, description: description ?? null }),
    remove: (id: string) => invoke<void>("projects_remove", { id }),
    stacksList: () => invoke<StackInfo[]>("stacks_list"),
    stacksRecommend: (targetOs: TargetOs, projectType: ProjectType) =>
      invoke<StackInfo[]>("stacks_recommend", { targetOs, projectType }),
    /** One-shot agent call ranking catalog stacks for a free-text description. */
    stacksAiRecommend: (req: StackRecommendRequest) => invoke<StackRecommendation[]>("stacks_ai_recommend", { req }),
    /** "Describe it in one line": the agent picks name, folder, target, type and stack. */
    aiPlan: (req: ProjectPlanRequest) => invoke<ProjectPlan>("projects_ai_plan", { req }),
    /** Suggested file name for the export save dialog; null when the stack has no export recipe. */
    exportName: (id: string) => invoke<string | null>("projects_export_name", { id }),
    /** Build with the stack's export recipe and package the result at `dest`; streams ExportEvents, resolves with the written path. */
    export: (id: string, dest: string, onEvent: (e: ExportEvent) => void) =>
      invoke<string>("projects_export", { id, dest, onEvent: channel(onEvent) }),
  },

  selfBuild: {
    /** Source checkout, running exe and build mode for "새 빌드 적용". */
    info: () => invoke<SelfBuildInfo>("self_build_info"),
    /** Build the app in `repo` while it keeps running; streams the log, resolves with the built exe path. */
    run: (repo: string, onEvent: (e: ExportEvent) => void) => invoke<string>("self_build_run", { repo, onEvent: channel(onEvent) }),
    /** Swap in `builtExe` (or build after exit when null) and quit; the script restarts the app. */
    apply: (repo: string, builtExe: string | null) => invoke<string>("self_build_apply", { repo, builtExe }),
  },

  usage: {
    /** Stored rate-limit samples of one account from the last `hours` hours (oldest first). */
    history: (provider: Provider, accountId: string | null, hours?: number) =>
      invoke<UsageSample[]>("usage_history", { provider, accountId, hours: hours ?? null }),
    /** Newest sample of every known (provider, account, window). */
    latest: () => invoke<UsageSample[]>("usage_latest"),
    /** Ask the CLI for fresh values (Codex only; Claude reports while a session works). */
    refresh: (provider: Provider, accountId: string | null) => invoke<RateLimitWindow[]>("usage_refresh", { provider, accountId }),
  },

  sessions: {
    /** Start or resume a session. `onEvent` receives SessionEvents until `exited`. */
    start: (config: SessionConfig, onEvent: (e: SessionEvent) => void) =>
      invoke<SessionRecord>("session_start", { config, onEvent: channel(onEvent) }),
    send: (sessionId: string, text: string) => invoke<void>("session_send", { sessionId, text }),
    interrupt: (sessionId: string) => invoke<void>("session_interrupt", { sessionId }),
    permissionReply: (sessionId: string, reply: PermissionReply) =>
      invoke<void>("session_permission_reply", { sessionId, reply }),
    updateConfig: (sessionId: string, patch: SessionConfigPatch) =>
      invoke<void>("session_update_config", { sessionId, patch }),
    close: (sessionId: string) => invoke<void>("session_close", { sessionId }),
    list: (projectId: string) => invoke<SessionRecord[]>("sessions_list", { projectId }),
    messages: (sessionId: string) => invoke<MessageRecord[]>("session_messages", { sessionId }),
    delete: (sessionId: string) => invoke<void>("session_delete", { sessionId }),
    answerQuestion: (sessionId: string, requestId: string, answers: QuestionAnswer[]) =>
      invoke<void>("session_answer_question", { sessionId, requestId, answers }),
    rename: (sessionId: string, title: string) => invoke<void>("session_rename", { sessionId, title }),
    setArchived: (sessionId: string, archived: boolean) => invoke<void>("session_set_archived", { sessionId, archived }),
    exportMarkdown: (sessionId: string) => invoke<string>("session_export_markdown", { sessionId }),
    exportToFile: (sessionId: string, path: string) => invoke<void>("session_export_to_file", { sessionId, path }),
  },

  checkpoints: {
    list: (projectId: string, sessionId?: string | null) =>
      invoke<CheckpointRecord[]>("checkpoints_list", { projectId, sessionId: sessionId ?? null }),
    /** Manual snapshot; null when nothing changed. */
    create: (projectId: string, sessionId?: string | null, label?: string) =>
      invoke<CheckpointRecord | null>("checkpoint_create", { projectId, sessionId: sessionId ?? null, label: label ?? null }),
    /** Restores the tree; resolves with the safety checkpoint taken first. */
    restore: (checkpointId: string) => invoke<CheckpointRecord>("checkpoint_restore", { checkpointId }),
    diff: (checkpointId: string) => invoke<string>("checkpoint_diff", { checkpointId }),
  },

  fs: {
    list: (projectId: string, relPath?: string) => invoke<FsEntry[]>("fs_list", { projectId, relPath: relPath ?? null }),
    read: (projectId: string, relPath: string) => invoke<FsFile>("fs_read", { projectId, relPath }),
  },

  preview: {
    /** Create or navigate the child webview at `bounds` (CSS px relative to the window's client area). */
    open: (url: string, bounds: PreviewBounds) => invoke<void>("preview_open", { url, bounds }),
    setBounds: (bounds: PreviewBounds) => invoke<void>("preview_set_bounds", { bounds }),
    setVisible: (visible: boolean) => invoke<void>("preview_set_visible", { visible }),
    close: () => invoke<void>("preview_close"),
    reload: () => invoke<void>("preview_reload"),
    eval: (js: string) => invoke<void>("preview_eval", { js }),
    serverStart: (projectId: string, command: string, onEvent: (e: PreviewEvent) => void) =>
      invoke<void>("preview_server_start", { projectId, command, onEvent: channel(onEvent) }),
    serverStop: (projectId: string) => invoke<void>("preview_server_stop", { projectId }),
    serverStatus: (projectId: string) => invoke<PreviewStatus>("preview_server_status", { projectId }),
  },

  git: {
    status: (projectId: string) => invoke<GitStatus>("git_status", { projectId }),
    /** `git init -b main` in the project folder. */
    init: (projectId: string) => invoke<void>("git_init", { projectId }),
    diff: (projectId: string, path: string | null, staged: boolean) =>
      invoke<string>("git_diff", { projectId, path, staged }),
    stage: (projectId: string, paths: string[]) => invoke<void>("git_stage", { projectId, paths }),
    unstage: (projectId: string, paths: string[]) => invoke<void>("git_unstage", { projectId, paths }),
    commit: (projectId: string, message: string) => invoke<string>("git_commit", { projectId, message }),
    push: (projectId: string) => invoke<string>("git_push", { projectId }),
    pull: (projectId: string) => invoke<string>("git_pull", { projectId }),
    fetch: (projectId: string) => invoke<string>("git_fetch", { projectId }),
    branches: (projectId: string) => invoke<GitBranch[]>("git_branches", { projectId }),
    checkout: (projectId: string, branch: string, create: boolean) =>
      invoke<void>("git_checkout", { projectId, branch, create }),
    log: (projectId: string, limit?: number) => invoke<GitCommit[]>("git_log", { projectId, limit: limit ?? null }),
    generateCommitMessage: (projectId: string, provider: Provider) =>
      invoke<string>("git_generate_commit_message", { projectId, provider }),
  },

  github: {
    setToken: (token: string, accountId?: string) => invoke<GitHubUser>("github_set_token", { token, accountId }),
    clearToken: (accountId?: string) => invoke<void>("github_clear_token", { accountId }),
    whoami: (accountId?: string | null) => invoke<GitHubUser | null>("github_whoami", { accountId }),
    createRepo: (name: string, isPrivate: boolean, description?: string) =>
      invoke<GitHubRepo>("github_create_repo", { name, private: isPrivate, description: description ?? null }),
  },

  pty: {
    open: (spec: PtySpec, onEvent: (e: PtyEvent) => void, projectId?: string | null) =>
      invoke<string>("pty_open", { spec, projectId, onEvent: channel(onEvent) }),
    write: (ptyId: string, data: string) => invoke<void>("pty_write", { ptyId, data }),
    resize: (ptyId: string, cols: number, rows: number) => invoke<void>("pty_resize", { ptyId, cols, rows }),
    close: (ptyId: string) => invoke<void>("pty_close", { ptyId }),
  },
};

export type {
  AccountProfile, AccountKind, ProjectAccounts,
  AgentDocsStatus,
  AgentQuestion,
  AppSettings,
  CheckpointRecord,
  FsEntry,
  FsFile,
  McpServerConfig,
  QuestionAnswer,
  SshKeyInfo,
  StackRecommendRequest,
  StackRecommendation,
  ProjectPlanRequest,
  ProjectPlan,
  AuthStatus,
  AutoGit,
  ExportEvent,
  RateLimitWindow,
  SelfBuildInfo,
  StackExport,
  UsageSample,
  CreateProjectRequest,
  GitBranch,
  GitCommit,
  GitHubRepo,
  GitHubUser,
  GitStatus,
  MessageRecord,
  LoginEvent,
  ModelInfo,
  ToolInstallEvent,
  PermissionReply,
  PreviewEvent,
  PreviewStatus,
  ProjectRecord,
  ProjectRemoteStatus,
  ProjectSettingsUpdate,
  ProjectType,
  Provider,
  PtyEvent,
  PtySpec,
  ScaffoldEvent,
  SessionConfig,
  SessionConfigPatch,
  SessionEvent,
  SessionRecord,
  StackInfo,
  TargetOs,
  ToolStatus,
};
