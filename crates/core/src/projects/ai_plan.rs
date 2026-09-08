//! "Describe it in one line" project creation. One structured agent call decides the display name,
//! folder name, target, type and stack from the user's free-text description, the catalog and the
//! tools already installed. The result is validated against the catalog and the file system so the
//! wizard can create the project without asking anything else.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::ai_recommend::{claude_structured, extract_json_object};
use super::{catalog, scaffold};
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::{ProjectPlan, ProjectPlanRequest, ProjectType, Provider, StackInfo, TargetOs, ToolStatus};

pub const SCHEMA: &str = r#"{"type":"object","properties":{"name":{"type":"string"},"dir_name":{"type":"string"},"target_os":{"type":"string","enum":["windows","macos","linux","cross_desktop","web","android","ios","server"]},"project_type":{"type":"string","enum":["desktop_app","web_app","mobile_app","cli","api_server","library","game","script"]},"stack_id":{"type":"string"},"summary":{"type":"string"},"reason":{"type":"string"}},"required":["name","dir_name","target_os","project_type","stack_id","summary","reason"]}"#;

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn parse_enum<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(Value::String(s.trim().to_string())).ok()
}

/// Environment facts handed to the agent.
pub struct EnvFacts<'a> {
    pub tools: &'a [ToolStatus],
}

pub fn build_prompt(description: &str, stacks: &[StackInfo], env: &EnvFacts<'_>) -> String {
    let mut out = String::new();
    out.push_str("당신은 코딩 경험이 없는 사용자를 대신해 소프트웨어 프로젝트의 구성을 결정하는 전문가입니다.\n");
    out.push_str("사용자의 설명을 읽고 아래 카탈로그 중에서 가장 적합한 구성을 하나만 정해 JSON 객체 하나로만 답하세요.\n\n");
    out.push_str("규칙:\n");
    out.push_str("1. 사용자의 요구를 최우선으로 만족한다. 설명에 없는 기능을 추가로 가정하지 않는다.\n");
    out.push_str("2. 오프라인 실행, 파일 시스템·하드웨어 접근, 특정 OS 기능처럼 데스크톱/모바일/CLI가 꼭 필요한 이유가 없으면 브라우저에서 실행되는 웹앱(web / web_app)을 우선한다. 화면 없이 파일·데이터를 처리하는 자동화 요구는 스크립트(script)로 한다.\n");
    out.push_str("3. 같은 조건이면 '지금 설치된 도구'로 바로 빌드되는 스택을 우선한다. 설치가 필요한 스택은 요구를 만족하는 다른 방법이 없을 때만 고른다.\n");
    out.push_str("4. stack_id는 카탈로그의 id를 그대로 쓴다. 적합한 스택이 없으면 \"none\"을 쓴다.\n");
    out.push_str("5. name은 사용자가 쓴 언어로(한국어면 한국어) 짧고 자연스러운 프로젝트 이름, dir_name은 영문 소문자·숫자·하이픈만 쓴 폴더 이름(예: inventory-app).\n");
    out.push_str("6. summary는 프로젝트 목적을 한국어 한 문장으로, reason은 이 구성을 고른 이유를 한국어 두 문장 이내로 쓴다.\n\n");
    out.push_str("출력 형식: {\"name\":\"...\",\"dir_name\":\"...\",\"target_os\":\"windows|macos|linux|cross_desktop|web|android|ios|server\",\"project_type\":\"desktop_app|web_app|mobile_app|cli|api_server|library|game|script\",\"stack_id\":\"<카탈로그 id 또는 none>\",\"summary\":\"...\",\"reason\":\"...\"}\n\n");
    out.push_str("## 사용자 설명\n");
    out.push_str(description.trim());
    out.push_str("\n\n## 실행 환경\n");
    out.push_str("- 에이전트와 빌드는 Windows에서 직접 실행된다.\n");
    let found: Vec<&str> = env.tools.iter().filter(|t| t.found).map(|t| t.name.as_str()).collect();
    let missing: Vec<&str> = env.tools.iter().filter(|t| !t.found).map(|t| t.name.as_str()).collect();
    out.push_str(&format!("- 설치된 도구: {}\n", if found.is_empty() { "(확인 불가)".to_string() } else { found.join(", ") }));
    if !missing.is_empty() {
        out.push_str(&format!("- 설치되지 않은 도구: {}\n", missing.join(", ")));
    }
    out.push_str("\n## 카탈로그\n");
    for s in stacks {
        let targets: Vec<String> = s.targets.iter().map(enum_str::<TargetOs>).collect();
        let types: Vec<String> = s.types.iter().map(enum_str::<ProjectType>).collect();
        out.push_str(&format!(
            "- id: {} | 이름: {} | 언어: {} | 대상: {} | 유형: {} | 필요 도구: {} | 요약: {}\n",
            s.id,
            s.name,
            s.languages.join("/"),
            targets.join(","),
            types.join(","),
            if s.prerequisites.is_empty() { "-".to_string() } else { s.prerequisites.join(",") },
            s.summary.replace('\n', " ")
        ));
    }
    out
}

/// Raw agent answer before catalog/file-system validation.
#[derive(Debug, Clone, PartialEq)]
pub struct RawPlan {
    pub name: String,
    pub dir_name: String,
    pub target_os: TargetOs,
    pub project_type: ProjectType,
    pub stack_id: Option<String>,
    pub summary: String,
    pub reason: String,
}

pub fn parse_plan(text_or_json: &Value) -> Option<RawPlan> {
    let obj = match text_or_json {
        Value::Object(_) => Some(text_or_json.clone()),
        Value::String(t) => extract_json_object(t),
        _ => None,
    }?;
    let str_field = |k: &str| obj.get(k).and_then(Value::as_str).map(str::trim).map(String::from).unwrap_or_default();
    let name = str_field("name");
    if name.is_empty() {
        return None;
    }
    let target_os = parse_enum::<TargetOs>(&str_field("target_os"))?;
    let project_type = parse_enum::<ProjectType>(&str_field("project_type"))?;
    let stack = str_field("stack_id");
    let stack_id = if stack.is_empty() || stack.eq_ignore_ascii_case("none") || stack == "null" { None } else { Some(stack) };
    Some(RawPlan { name, dir_name: str_field("dir_name").to_ascii_lowercase(), target_os, project_type, stack_id, summary: str_field("summary"), reason: str_field("reason") })
}

/// Make the plan consistent: unknown stack → best catalog match; stack that does not cover the
/// (target, type) → adopt the stack's own target/type when they are compatible with the request,
/// otherwise the catalog recommendation for the request.
pub fn reconcile(mut plan: RawPlan, stacks: &[StackInfo]) -> RawPlan {
    let known: HashSet<&str> = stacks.iter().map(|s| s.id.as_str()).collect();
    if let Some(id) = &plan.stack_id {
        if !known.contains(id.as_str()) {
            plan.stack_id = None;
        }
    }
    if plan.stack_id.is_none() {
        // The agent named nothing usable: fall back to the catalog's own recommendation (may be None → empty project).
        plan.stack_id = catalog::recommend(plan.target_os, plan.project_type).ok().and_then(|v| v.first().map(|s| s.id.clone()));
        return plan;
    }
    let stack = stacks.iter().find(|s| Some(&s.id) == plan.stack_id.as_ref()).cloned();
    if let Some(s) = stack {
        if !s.types.contains(&plan.project_type) {
            plan.project_type = s.types[0];
        }
        if !s.targets.contains(&plan.target_os) {
            plan.target_os = s.targets[0];
        }
    }
    plan
}

/// Folder name that scaffolding tools accept and that does not exist yet under `parent_dir`.
pub fn choose_dir_name(dir_name: &str, display_name: &str, stack_id: Option<&str>, parent_dir: &str) -> String {
    let base = scaffold::derive_dir_name(dir_name)
        .or_else(|| scaffold::derive_dir_name(display_name))
        .or_else(|| stack_id.map(|s| format!("{s}-app")))
        .unwrap_or_else(|| "my-project".to_string());
    let parent = parent_dir.trim();
    if parent.is_empty() || !Path::new(parent).is_dir() {
        return base;
    }
    let exists = |n: &str| Path::new(parent).join(n).exists();
    if !exists(&base) {
        return base;
    }
    (2..100).map(|i| format!("{base}-{i}")).find(|n| !exists(n)).unwrap_or(base)
}

/// Run the whole thing: detect tools, ask the agent, validate, and attach install status.
pub async fn plan(ctx: Arc<AppContext>, req: ProjectPlanRequest) -> Result<ProjectPlan> {
    let description = req.description.trim();
    if description.chars().count() < 4 {
        return Err(CoreError::msg("무엇을 만들지 조금 더 자세히 적어 주세요 (예: 부서 비품을 등록하고 대여 기록을 남기는 웹앱)"));
    }
    let stacks = catalog::load()?;
    let backend = ctx.backend().await;

    // Environment facts (best effort, bounded).
    let tools = tokio::time::timeout(Duration::from_secs(25), crate::tools::detect_all(backend.clone())).await.unwrap_or_default();

    let prompt = build_prompt(description, &stacks, &EnvFacts { tools: &tools });
    let bin = ctx.bin_override(req.provider).await;
    let cwd = std::env::temp_dir();
    let raw_value = match req.provider {
        Provider::Claude => claude_structured(backend.clone(), bin, &cwd, &prompt, SCHEMA).await?,
        Provider::Codex => Value::String(crate::agents::codex::exec::run_exec(backend.clone(), bin, &cwd, &prompt, None).await?),
    };
    let raw = parse_plan(&raw_value).ok_or_else(|| CoreError::Agent("에이전트가 해석할 수 있는 구성을 돌려주지 않았습니다".into()))?;
    let raw = reconcile(raw, &stacks);
    let dir_name = choose_dir_name(&raw.dir_name, &raw.name, raw.stack_id.as_deref(), &req.parent_dir);
    let name = if scaffold::valid_display_name(&raw.name) { raw.name.trim().to_string() } else { dir_name.clone() };

    let stack = raw.stack_id.as_deref().and_then(|id| stacks.iter().find(|s| s.id == id));
    let required: Vec<&str> = stack.map(|s| s.prerequisites.iter().map(String::as_str).collect()).unwrap_or_default();
    let missing_tools: Vec<ToolStatus> = tools.iter().filter(|t| !t.found && required.contains(&t.name.as_str())).cloned().collect();

    Ok(ProjectPlan {
        name,
        dir_name,
        target_os: raw.target_os,
        project_type: raw.project_type,
        stack_id: raw.stack_id,
        summary: if raw.summary.is_empty() { description.to_string() } else { raw.summary },
        reason: raw.reason,
        missing_tools,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tools(found: &[&str], missing: &[&str]) -> Vec<ToolStatus> {
        let mk = |n: &&str, f: bool| ToolStatus { name: n.to_string(), found: f, path: None, version: None, install_hint: None };
        found.iter().map(|n| mk(n, true)).chain(missing.iter().map(|n| mk(n, false))).collect()
    }

    #[test]
    fn prompt_lists_catalog_and_env() {
        let stacks = catalog::load().unwrap();
        let t = tools(&["node", "npm", "git"], &["cargo", "dotnet"]);
        let p = build_prompt("부서 비품 대여 기록", &stacks, &EnvFacts { tools: &t });
        assert!(p.contains("부서 비품 대여 기록"));
        assert!(p.contains("설치된 도구: node, npm, git"));
        assert!(p.contains("설치되지 않은 도구: cargo, dotnet"));
        assert!(p.contains("id: nextjs"));
        assert!(p.contains("필요 도구: node/npm/cargo/rustup/msvc") || p.contains("필요 도구: node, npm, cargo, rustup, msvc") || p.contains("msvc"));
        assert!(p.contains("Windows에서 직접 실행"));
    }

    #[test]
    fn parses_structured_and_text() {
        let v = json!({"name":"재고 관리","dir_name":"Inventory-App","target_os":"web","project_type":"web_app","stack_id":"nextjs","summary":"s","reason":"r"});
        let p = parse_plan(&v).unwrap();
        assert_eq!(p.dir_name, "inventory-app");
        assert_eq!(p.target_os, TargetOs::Web);
        assert_eq!(p.stack_id.as_deref(), Some("nextjs"));
        let t = Value::String("여기 있습니다:\n```json\n{\"name\":\"x\",\"dir_name\":\"x\",\"target_os\":\"windows\",\"project_type\":\"script\",\"stack_id\":\"none\",\"summary\":\"\",\"reason\":\"\"}\n```".into());
        let p = parse_plan(&t).unwrap();
        assert_eq!(p.stack_id, None);
        assert!(parse_plan(&json!({"name":"x","target_os":"mars","project_type":"script"})).is_none());
        assert!(parse_plan(&json!({"dir_name":"x","target_os":"web","project_type":"web_app"})).is_none());
    }

    #[test]
    fn reconcile_fixes_inconsistent_answers() {
        let stacks = catalog::load().unwrap();
        let base = RawPlan { name: "x".into(), dir_name: "x".into(), target_os: TargetOs::Web, project_type: ProjectType::WebApp, stack_id: Some("nextjs".into()), summary: "".into(), reason: "".into() };
        // consistent → unchanged
        assert_eq!(reconcile(base.clone(), &stacks), base);
        // unknown stack → catalog recommendation for web/web_app
        let r = reconcile(RawPlan { stack_id: Some("django".into()), ..base.clone() }, &stacks);
        assert_eq!(r.stack_id.as_deref(), Some(catalog::recommend(TargetOs::Web, ProjectType::WebApp).unwrap()[0].id.as_str()));
        // stack that does not match the type → adopt the stack's type
        let r = reconcile(RawPlan { stack_id: Some("tauri-react".into()), project_type: ProjectType::WebApp, target_os: TargetOs::Windows, ..base.clone() }, &stacks);
        assert_eq!(r.project_type, ProjectType::DesktopApp);
        assert_eq!(r.target_os, TargetOs::Windows);
        // none → recommendation
        let r = reconcile(RawPlan { stack_id: None, project_type: ProjectType::Script, target_os: TargetOs::Windows, ..base }, &stacks);
        assert!(r.stack_id.is_some());
    }

    #[test]
    fn dir_name_is_valid_and_unique() {
        let d = tempfile::tempdir().unwrap();
        let parent = d.path().to_string_lossy().to_string();
        assert_eq!(choose_dir_name("Inventory App", "재고", None, &parent), "inventory-app");
        assert_eq!(choose_dir_name("재고관리", "재고관리", Some("nextjs"), &parent), "nextjs-app");
        assert_eq!(choose_dir_name("", "", None, &parent), "my-project");
        std::fs::create_dir(d.path().join("inventory-app")).unwrap();
        assert_eq!(choose_dir_name("inventory-app", "x", None, &parent), "inventory-app-2");
        // unknown parent: no uniqueness check, still a valid name
        assert_eq!(choose_dir_name("My App", "x", None, "Z:\\definitely\\missing"), "my-app");
    }
}
