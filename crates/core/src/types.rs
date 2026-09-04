//! Shared serializable types. Every type here is exported to TypeScript via ts-rs
//! (`cargo test -p vibecode-core export_bindings`) into `src/lib/bindings/`.
//! Keep serde and ts attributes in sync; the frontend depends on the wire shape.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Enums shared by every layer
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
}

/// Unified effort scale. Adapters map it to provider-specific values:
/// Claude: low/medium/high/xhigh/max (minimal -> low)
/// Codex:  minimal/low/medium/high/xhigh/max
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl Effort {
    pub fn to_claude(&self) -> &'static str {
        match self {
            Effort::Minimal | Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::XHigh => "xhigh",
            Effort::Max => "max",
        }
    }
    pub fn to_codex(&self) -> &'static str {
        match self {
            Effort::Minimal => "minimal",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::XHigh => "xhigh",
            Effort::Max => "max",
        }
    }
}

/// Unified permission presets (see docs/PLAN.md 3.3).
/// Claude: plan / manual / acceptEdits / bypassPermissions
/// Codex:  read-only+untrusted / workspace-write+on-request / workspace-write+on-request / danger-full-access+never
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPreset {
    ReadOnly,
    AskEverything,
    AutoEdit,
    FullAuto,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Native,
    Wsl,
}

/// Where commands run. `wsl_distro = None` with `Wsl` means the default distro.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[ts(export)]
pub struct BackendConfig {
    pub kind: BackendKind,
    #[ts(optional = nullable)]
    pub wsl_distro: Option<String>,
}

impl Default for BackendConfig {
    fn default() -> Self {
        BackendConfig { kind: BackendKind::Native, wsl_distro: None }
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct AppSettings {
    pub backend: BackendConfig,
    pub default_provider: Provider,
    #[ts(optional = nullable)]
    pub default_model_claude: Option<String>,
    #[ts(optional = nullable)]
    pub default_model_codex: Option<String>,
    pub default_effort: Effort,
    pub default_permission: PermissionPreset,
    /// Windows path where new projects are created by default.
    #[ts(optional = nullable)]
    pub projects_root: Option<String>,
    /// Explicit binary overrides (host or backend path). Empty = auto-detect.
    #[ts(optional = nullable)]
    pub claude_bin: Option<String>,
    #[ts(optional = nullable)]
    pub codex_bin: Option<String>,
    #[ts(optional = nullable)]
    pub git_bin: Option<String>,
    pub theme: String,
    pub onboarding_done: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            backend: BackendConfig::default(),
            default_provider: Provider::Claude,
            default_model_claude: None,
            default_model_codex: None,
            default_effort: Effort::High,
            default_permission: PermissionPreset::AutoEdit,
            projects_root: None,
            claude_bin: None,
            codex_bin: None,
            git_bin: None,
            theme: "system".into(),
            onboarding_done: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Tool detection / auth
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct ToolStatus {
    /// e.g. "claude", "codex", "git", "node", "npm", "cargo", "rustup", "python", "flutter", "dotnet", "gh"
    pub name: String,
    pub found: bool,
    #[ts(optional = nullable)]
    pub path: Option<String>,
    #[ts(optional = nullable)]
    pub version: Option<String>,
    /// Human-readable install hint for the active backend.
    #[ts(optional = nullable)]
    pub install_hint: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct AuthStatus {
    pub provider: Provider,
    pub logged_in: bool,
    #[ts(optional = nullable)]
    pub method: Option<String>,
    #[ts(optional = nullable)]
    pub account: Option<String>,
    #[ts(optional = nullable)]
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct ModelInfo {
    pub provider: Provider,
    pub id: String,
    pub label: String,
    /// Efforts the provider reports as supported for this model (unified scale).
    pub efforts: Vec<Effort>,
    pub is_default: bool,
}

// ---------------------------------------------------------------------------
// Projects & stacks
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum TargetOs {
    Windows,
    Macos,
    Linux,
    CrossDesktop,
    Web,
    Android,
    Ios,
    Server,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ProjectType {
    DesktopApp,
    WebApp,
    MobileApp,
    Cli,
    ApiServer,
    Library,
    Game,
    Script,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct StackInfo {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub targets: Vec<TargetOs>,
    pub types: Vec<ProjectType>,
    pub languages: Vec<String>,
    /// Shell command executed inside the new project directory's parent. `{name}` is replaced.
    #[ts(optional = nullable)]
    pub scaffold_cmd: Option<String>,
    /// Tool names (see ToolStatus.name) that must be present.
    pub prerequisites: Vec<String>,
    pub pros: Vec<String>,
    pub cons: Vec<String>,
    pub recommended: bool,
    /// Extra notes for CLAUDE.md / AGENTS.md (build/test commands, conventions).
    #[ts(optional = nullable)]
    pub agent_notes: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    /// Windows (host) path.
    pub path: String,
    #[ts(optional = nullable)]
    pub target_os: Option<TargetOs>,
    #[ts(optional = nullable)]
    pub project_type: Option<ProjectType>,
    #[ts(optional = nullable)]
    pub stack_id: Option<String>,
    #[ts(optional = nullable)]
    pub github_url: Option<String>,
    #[ts(optional = nullable)]
    pub default_provider: Option<Provider>,
    #[ts(optional = nullable)]
    pub default_model: Option<String>,
    #[ts(optional = nullable)]
    pub default_effort: Option<Effort>,
    #[ts(optional = nullable)]
    pub default_permission: Option<PermissionPreset>,
    pub created_at: DateTime<Utc>,
    pub last_opened_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct CreateProjectRequest {
    pub name: String,
    /// Parent directory (Windows path). Project dir = parent/name.
    pub parent_dir: String,
    pub target_os: TargetOs,
    pub project_type: ProjectType,
    #[ts(optional = nullable)]
    pub stack_id: Option<String>,
    pub description: String,
    pub git_init: bool,
    pub create_github_repo: bool,
    pub github_private: bool,
    pub generate_agent_docs: bool,
    #[ts(optional = nullable)]
    pub default_provider: Option<Provider>,
    #[ts(optional = nullable)]
    pub default_model: Option<String>,
    #[ts(optional = nullable)]
    pub default_effort: Option<Effort>,
    #[ts(optional = nullable)]
    pub default_permission: Option<PermissionPreset>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScaffoldEvent {
    Step { name: String },
    Log { line: String, is_err: bool },
    Done { project: ProjectRecord },
    Failed { message: String },
}

// ---------------------------------------------------------------------------
// Sessions & streaming events
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct SessionConfig {
    pub project_id: String,
    pub provider: Provider,
    #[ts(optional = nullable)]
    pub model: Option<String>,
    #[ts(optional = nullable)]
    pub effort: Option<Effort>,
    pub permission: PermissionPreset,
    #[ts(optional = nullable)]
    pub max_budget_usd: Option<f64>,
    #[ts(optional = nullable)]
    pub append_system_prompt: Option<String>,
    /// Resume an existing provider session/thread (Claude session_id or Codex thread id).
    #[ts(optional = nullable)]
    pub resume_ref: Option<String>,
    pub fork: bool,
}

/// Fields that may change between turns without restarting the session.
#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct SessionConfigPatch {
    #[ts(optional = nullable)]
    pub model: Option<String>,
    #[ts(optional = nullable)]
    pub effort: Option<Effort>,
    #[ts(optional = nullable)]
    pub permission: Option<PermissionPreset>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct SessionRecord {
    pub id: String,
    pub project_id: String,
    pub provider: Provider,
    /// Provider-side id used for resume (Claude session_id / Codex thread id).
    #[ts(optional = nullable)]
    pub external_ref: Option<String>,
    pub title: String,
    #[ts(optional = nullable)]
    pub model: Option<String>,
    #[ts(optional = nullable)]
    pub effort: Option<Effort>,
    pub permission: PermissionPreset,
    pub total_cost_usd: f64,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    User,
    Assistant,
    Tool,
    Permission,
    System,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct MessageRecord {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub kind: MessageKind,
    #[ts(type = "unknown")]
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    Command,
    FileEdit,
    Tool,
    Other,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    AllowSession,
    Deny,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct PermissionReply {
    pub request_id: String,
    pub decision: PermissionDecision,
    #[ts(optional = nullable)]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct PlanStep {
    pub text: String,
    /// "pending" | "in_progress" | "completed"
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

/// Provider-agnostic event stream consumed by the chat UI.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// Emitted once the provider process/thread is ready.
    Init {
        provider: Provider,
        model: String,
        external_ref: String,
        tools: Vec<String>,
    },
    /// A user turn was accepted (echo for the UI / persistence).
    UserMessage { text: String },
    /// Streaming assistant text delta.
    TextDelta { text: String },
    /// A finished assistant text block (sent at block end, after deltas).
    Text { text: String },
    Thinking { text: String },
    ToolStart {
        id: String,
        name: String,
        #[ts(type = "unknown")]
        input: Value,
    },
    ToolEnd { id: String, output: String, is_error: bool },
    PermissionRequest {
        request_id: String,
        kind: PermissionKind,
        title: String,
        #[ts(type = "unknown")]
        detail: Value,
    },
    PermissionResolved { request_id: String, decision: PermissionDecision },
    Plan { steps: Vec<PlanStep> },
    Status { message: String },
    TurnEnd {
        #[ts(optional = nullable)]
        cost_usd: Option<f64>,
        usage: Usage,
        duration_ms: i64,
        #[ts(optional = nullable)]
        stop_reason: Option<String>,
    },
    Error { message: String, fatal: bool },
    Exited {
        #[ts(optional = nullable)]
        code: Option<i32>,
    },
}

// ---------------------------------------------------------------------------
// Git & GitHub
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct GitFileStatus {
    pub path: String,
    /// Two-letter porcelain code, e.g. " M", "M ", "??", "A ", "D ".
    pub code: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct GitStatus {
    pub is_repo: bool,
    #[ts(optional = nullable)]
    pub branch: Option<String>,
    #[ts(optional = nullable)]
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<GitFileStatus>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct GitHubUser {
    pub login: String,
    #[ts(optional = nullable)]
    pub name: Option<String>,
    #[ts(optional = nullable)]
    pub avatar_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct GitHubRepo {
    pub full_name: String,
    pub html_url: String,
    pub ssh_url: String,
    pub clone_url: String,
    pub private: bool,
}

// ---------------------------------------------------------------------------
// Managed environment (app-owned WSL distribution)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum WslState {
    /// wsl.exe is missing entirely (very old Windows).
    NotFound,
    /// wsl.exe exists but the WSL feature / kernel is not installed.
    NotInstalled,
    Installed,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct WslStatus {
    pub state: WslState,
    #[ts(optional = nullable)]
    pub version: Option<String>,
    pub distros: Vec<String>,
    /// Name of the app-owned distribution.
    pub managed_distro: String,
    pub managed_present: bool,
    /// Present and the provisioning marker + tools check passed.
    pub managed_ready: bool,
    #[ts(optional = nullable)]
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProvisionEvent {
    Step { name: String },
    Log { line: String, is_err: bool },
    Progress {
        bytes: i64,
        #[ts(optional = nullable)]
        total: Option<i64>,
    },
    Done,
    Failed { message: String },
}

// ---------------------------------------------------------------------------
// PTY (embedded terminal)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct PtySpec {
    /// Program to run; None = interactive shell (PowerShell natively, bash in WSL).
    #[ts(optional = nullable)]
    pub program: Option<String>,
    pub args: Vec<String>,
    /// Windows path.
    #[ts(optional = nullable)]
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PtyEvent {
    Data { data: String },
    Exit {
        #[ts(optional = nullable)]
        code: Option<i32>,
    },
}
