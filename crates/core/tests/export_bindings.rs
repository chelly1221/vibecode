//! `cargo test -p vibecode-core --test export_bindings` writes TypeScript bindings
//! for every `#[ts(export)]` type into src/lib/bindings (see .cargo/config.toml).
use ts_rs::{Config, TS};
use vibecode_core::types::*;

#[test]
fn export_bindings() {
    let cfg = Config::from_env().with_large_int("number");
    macro_rules! export {
        ($($t:ty),* $(,)?) => { $( <$t as TS>::export_all(&cfg).expect(stringify!($t)); )* };
    }
    export!(
        Provider, Effort, PermissionPreset, BackendKind, BackendConfig, AppSettings, ToolStatus, AuthStatus, ModelInfo,
        TargetOs, ProjectType, StackInfo, ProjectRecord, CreateProjectRequest, ScaffoldEvent, SessionConfig,
        SessionConfigPatch, SessionRecord, MessageKind, MessageRecord, PermissionKind, PermissionDecision,
        PermissionReply, PlanStep, Usage, SessionEvent, GitFileStatus, GitStatus, GitBranch, GitCommit, GitHubUser,
        GitHubRepo, PtySpec, PtyEvent,
    );
}
