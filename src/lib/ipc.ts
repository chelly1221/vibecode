// Typed wrappers for every Tauri command. This file and
// src-tauri/src/commands/mod.rs are the IPC contract: keep them in sync.
// Argument keys are camelCase (Tauri converts to the Rust snake_case params).

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
import type { BackendConfig } from "./bindings/BackendConfig";
import type { CreateProjectRequest } from "./bindings/CreateProjectRequest";
import type { GitBranch } from "./bindings/GitBranch";
import type { GitCommit } from "./bindings/GitCommit";
import type { GitHubRepo } from "./bindings/GitHubRepo";
import type { GitHubUser } from "./bindings/GitHubUser";
import type { GitStatus } from "./bindings/GitStatus";
import type { MessageRecord } from "./bindings/MessageRecord";
import type { ModelInfo } from "./bindings/ModelInfo";
import type { PermissionReply } from "./bindings/PermissionReply";
import type { PreviewEvent } from "./bindings/PreviewEvent";
import type { PreviewStatus } from "./bindings/PreviewStatus";
import type { ProjectRecord } from "./bindings/ProjectRecord";
import type { ProjectType } from "./bindings/ProjectType";
import type { ProvisionEvent } from "./bindings/ProvisionEvent";
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
import type { WslStatus } from "./bindings/WslStatus";

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
  settings: {
    get: () => invoke<AppSettings>("settings_get"),
    set: (settings: AppSettings) => invoke<AppSettings>("settings_set", { settings }),
  },

  tools: {
    /** Detect tools on the active backend, or on `backend` for onboarding previews. */
    detect: (backend?: BackendConfig) => invoke<ToolStatus[]>("tools_detect", { backend: backend ?? null }),
    /** Auth status on the active backend, or on `backend` for onboarding previews. */
    authStatus: (provider: Provider, backend?: BackendConfig) =>
      invoke<AuthStatus>("tools_auth_status", { provider, backend: backend ?? null }),
    listWslDistros: () => invoke<string[]>("tools_list_wsl_distros"),
    listModels: (provider: Provider) => invoke<ModelInfo[]>("models_list", { provider }),
  },

  env: {
    /** WSL installation state plus whether the app-owned "Vibecoder" distro exists / is ready. */
    wslStatus: () => invoke<WslStatus>("env_wsl_status"),
    /** Elevated `wsl --install --no-distribution`; resolves with the exit code (reboot needed afterwards). */
    installWsl: () => invoke<number>("env_install_wsl"),
    reboot: () => invoke<void>("env_reboot"),
    /** Reboot into advanced startup (문제 해결 → 고급 옵션 → UEFI 펌웨어 설정). */
    rebootToFirmware: () => invoke<void>("env_reboot_to_firmware"),
    /** Download rootfs, import the distro, install tools. Streams progress to `onEvent`. */
    provision: (onEvent: (e: ProvisionEvent) => void) => invoke<void>("env_provision", { onEvent: channel(onEvent) }),
    removeManaged: () => invoke<void>("env_remove_managed"),
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
    open: (path: string) => invoke<ProjectRecord>("projects_open", { path }),
    agentDocsStatus: (id: string) => invoke<AgentDocsStatus>("projects_agent_docs_status", { id }),
    /** Write CLAUDE.md / AGENTS.md when missing; resolves with the file names written. */
    generateAgentDocs: (id: string, description?: string) =>
      invoke<string[]>("projects_generate_agent_docs", { id, description: description ?? null }),
    remove: (id: string) => invoke<void>("projects_remove", { id }),
    stacksList: () => invoke<StackInfo[]>("stacks_list"),
    stacksRecommend: (targetOs: TargetOs, projectType: ProjectType) =>
      invoke<StackInfo[]>("stacks_recommend", { targetOs, projectType }),
    /** One-shot agent call ranking catalog stacks for a free-text description. */
    stacksAiRecommend: (req: StackRecommendRequest) => invoke<StackRecommendation[]>("stacks_ai_recommend", { req }),
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
    setToken: (token: string) => invoke<GitHubUser>("github_set_token", { token }),
    clearToken: () => invoke<void>("github_clear_token"),
    whoami: () => invoke<GitHubUser | null>("github_whoami"),
    createRepo: (name: string, isPrivate: boolean, description?: string) =>
      invoke<GitHubRepo>("github_create_repo", { name, private: isPrivate, description: description ?? null }),
  },

  pty: {
    open: (spec: PtySpec, onEvent: (e: PtyEvent) => void) =>
      invoke<string>("pty_open", { spec, onEvent: channel(onEvent) }),
    write: (ptyId: string, data: string) => invoke<void>("pty_write", { ptyId, data }),
    resize: (ptyId: string, cols: number, rows: number) => invoke<void>("pty_resize", { ptyId, cols, rows }),
    close: (ptyId: string) => invoke<void>("pty_close", { ptyId }),
  },
};

export type {
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
  AuthStatus,
  BackendConfig,
  CreateProjectRequest,
  GitBranch,
  GitCommit,
  GitHubRepo,
  GitHubUser,
  GitStatus,
  MessageRecord,
  ModelInfo,
  PermissionReply,
  PreviewEvent,
  PreviewStatus,
  ProjectRecord,
  ProjectType,
  Provider,
  ProvisionEvent,
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
  WslStatus,
};
