// Typed wrappers for every Tauri command. This file and
// src-tauri/src/commands/mod.rs are the IPC contract: keep them in sync.
// Argument keys are camelCase (Tauri converts to the Rust snake_case params).

import { Channel, invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./bindings/AppSettings";
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
import type { ProjectRecord } from "./bindings/ProjectRecord";
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

  projects: {
    list: () => invoke<ProjectRecord[]>("projects_list"),
    get: (id: string) => invoke<ProjectRecord>("projects_get", { id }),
    /** Streams ScaffoldEvents to `onEvent`; resolves with the created project. */
    create: (req: CreateProjectRequest, onEvent: (e: ScaffoldEvent) => void) =>
      invoke<ProjectRecord>("projects_create", { req, onEvent: channel(onEvent) }),
    open: (path: string) => invoke<ProjectRecord>("projects_open", { path }),
    remove: (id: string) => invoke<void>("projects_remove", { id }),
    stacksList: () => invoke<StackInfo[]>("stacks_list"),
    stacksRecommend: (targetOs: TargetOs, projectType: ProjectType) =>
      invoke<StackInfo[]>("stacks_recommend", { targetOs, projectType }),
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
  AppSettings,
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
  ProjectRecord,
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
