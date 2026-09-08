//! Ask an agent (one-shot, no session) to rank catalog stacks for a free-text project description.
//! Claude: `claude -p --output-format json --json-schema …` → `structured_output`.
//! Codex: `codex exec --json` with a JSON-only instruction → parsed from the final message.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::backend::{process::spawn_tracked, CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::projects::catalog;
use crate::types::{ProjectType, Provider, StackInfo, StackRecommendRequest, StackRecommendation, TargetOs};

/// JSON schema for the structured answer.
pub const SCHEMA: &str = r#"{"type":"object","properties":{"recommendations":{"type":"array","items":{"type":"object","properties":{"stack_id":{"type":"string"},"score":{"type":"integer"},"reason":{"type":"string"}},"required":["stack_id","score","reason"]}}},"required":["recommendations"]}"#;

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

/// Prompt listing the catalog (matching stacks first) and the user's project description.
pub fn build_prompt(req: &StackRecommendRequest, stacks: &[StackInfo]) -> String {
    let matches = |s: &StackInfo| s.targets.contains(&req.target_os) && s.types.contains(&req.project_type);
    let mut ordered: Vec<&StackInfo> = stacks.iter().filter(|s| matches(s)).collect();
    ordered.extend(stacks.iter().filter(|s| !matches(s)));
    let mut out = String::new();
    out.push_str("당신은 소프트웨어 프로젝트의 기술 스택을 추천하는 전문가입니다.\n");
    out.push_str("아래 카탈로그에 있는 스택 중에서만 골라, 사용자의 프로젝트 설명에 가장 잘 맞는 3~5개를 점수(0~100)와 함께 추천하세요.\n");
    out.push_str("반드시 JSON 객체 하나만 출력하세요: {\"recommendations\":[{\"stack_id\":\"<카탈로그 id>\",\"score\":<0-100 정수>,\"reason\":\"<한국어 한두 문장>\"}]}\n");
    out.push_str("stack_id는 카탈로그의 id를 그대로 써야 하며, reason은 한국어로 씁니다. 점수가 높은 순으로 정렬하세요.\n\n");
    out.push_str(&format!(
        "## 사용자 프로젝트\n- 대상 OS: {}\n- 프로젝트 유형: {}\n- 설명: {}\n\n## 카탈로그\n",
        enum_str(&req.target_os),
        enum_str(&req.project_type),
        req.description.trim()
    ));
    for s in ordered {
        let targets: Vec<String> = s.targets.iter().map(enum_str::<TargetOs>).collect();
        let types: Vec<String> = s.types.iter().map(enum_str::<ProjectType>).collect();
        out.push_str(&format!(
            "- id: {} | 이름: {} | 언어: {} | 대상: {} | 유형: {} | 요약: {}\n",
            s.id,
            s.name,
            s.languages.join("/"),
            targets.join(","),
            types.join(","),
            s.summary.replace('\n', " ")
        ));
    }
    out
}

/// Extract `recommendations` from a structured object or free text containing JSON; unknown ids dropped.
pub fn parse_recommendations(text_or_json: &Value, known_ids: &HashSet<String>) -> Vec<StackRecommendation> {
    let obj: Option<Value> = match text_or_json {
        Value::Object(_) => Some(text_or_json.clone()),
        Value::String(t) => extract_json_object(t),
        _ => None,
    };
    let Some(obj) = obj else { return vec![] };
    let mut out: Vec<StackRecommendation> = obj
        .get("recommendations")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    let id = r.get("stack_id").and_then(Value::as_str)?.trim().to_string();
                    if !known_ids.contains(&id) {
                        return None;
                    }
                    let score = r.get("score").and_then(Value::as_f64).unwrap_or(0.0).round().clamp(0.0, 100.0) as i64;
                    let reason = r.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string();
                    Some(StackRecommendation { stack_id: id, score, reason })
                })
                .collect()
        })
        .unwrap_or_default();
    // de-duplicate by id, keep the best score, sort desc
    let mut seen = HashSet::new();
    out.sort_by(|a, b| b.score.cmp(&a.score));
    out.retain(|r| seen.insert(r.stack_id.clone()));
    out.truncate(5);
    out
}

/// First balanced `{...}` in `text` (fences and prose tolerated).
pub fn extract_json_object(text: &str) -> Option<Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        if v.is_object() {
            return Some(v);
        }
    }
    let start = t.find('{')?;
    let bytes = t.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str::<Value>(&t[start..=i]).ok().filter(Value::is_object);
                }
            }
            _ => {}
        }
    }
    None
}

pub async fn recommend(backend: Arc<ExecBackend>, bin: Option<String>, req: StackRecommendRequest) -> Result<Vec<StackRecommendation>> {
    if req.description.trim().is_empty() {
        return Err(CoreError::msg("프로젝트 설명을 입력하세요"));
    }
    let stacks = catalog::load()?;
    let known: HashSet<String> = stacks.iter().map(|s| s.id.clone()).collect();
    let prompt = build_prompt(&req, &stacks);
    let cwd = std::env::temp_dir();
    let raw = match req.provider {
        Provider::Claude => claude_structured(backend, bin, &cwd, &prompt, SCHEMA).await?,
        Provider::Codex => {
            let text = crate::agents::codex::exec::run_exec(backend, bin, &cwd, &prompt, None).await?;
            Value::String(text)
        }
    };
    let recs = parse_recommendations(&raw, &known);
    if recs.is_empty() {
        return Err(CoreError::Agent("에이전트가 유효한 추천을 돌려주지 않았습니다".into()));
    }
    Ok(recs)
}

/// `claude -p --output-format json --json-schema …`; returns `structured_output` (or the result text).
/// Shared by the stack recommendation and the one-line project plan.
pub(crate) async fn claude_structured(backend: Arc<ExecBackend>, bin: Option<String>, cwd: &std::path::Path, prompt: &str, schema: &str) -> Result<Value> {
    let bin = bin.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "claude".into());
    let spec = CommandSpec::new(bin)
        // JSON schema responses use Claude's StructuredOutput tool. A wildcard deny also
        // blocks that tool, causing a successful CLI exit with no structured answer.
        .args(["-p", "--output-format", "json", "--json-schema", schema, "--permission-mode", "dontAsk", "--permission-prompts", "none", "--tools", "", "--allowedTools", "StructuredOutput"])
        .cwd(cwd);
    let mut cmd = backend.command(&spec);
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = spawn_tracked(&mut cmd)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }
    let out = tokio::time::timeout(Duration::from_secs(240), child.wait_with_output()).await.map_err(|_| CoreError::Agent("stack recommendation timed out".into()))??;
    if !out.status.success() {
        return Err(CoreError::Process { code: out.status.code(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let result = stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("result"))
        .ok_or_else(|| CoreError::Agent(format!("unexpected claude output: {}", stdout.chars().take(300).collect::<String>())))?;
    if result.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(CoreError::Agent(result.get("result").and_then(Value::as_str).unwrap_or("AI 응답 생성에 실패했습니다").to_string()));
    }
    if let Some(so) = result.get("structured_output").filter(|v| v.is_object()) {
        return Ok(so.clone());
    }
    Ok(Value::String(result.get("result").and_then(Value::as_str).unwrap_or("").to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn known() -> HashSet<String> {
        ["tauri-react", "wpf", "electron-vite"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_structured_and_text_outputs() {
        let structured = json!({"recommendations": [
            {"stack_id": "tauri-react", "score": 95, "reason": "가볍다"},
            {"stack_id": "nope", "score": 90, "reason": "unknown"},
            {"stack_id": "wpf", "score": 140, "reason": "네이티브"},
            {"stack_id": "wpf", "score": 10, "reason": "dup"}
        ]});
        let r = parse_recommendations(&structured, &known());
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].stack_id, "wpf");
        assert_eq!(r[0].score, 100);
        assert_eq!(r[1].stack_id, "tauri-react");
        let text = Value::String("설명입니다.\n```json\n{\"recommendations\":[{\"stack_id\":\"electron-vite\",\"score\":70,\"reason\":\"웹 친화적\"}]}\n```".into());
        let r = parse_recommendations(&text, &known());
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].stack_id, "electron-vite");
        assert!(parse_recommendations(&Value::String("no json here".into()), &known()).is_empty());
    }

    #[test]
    fn prompt_lists_matching_stacks_first() {
        let stacks = catalog::load().unwrap();
        let req = StackRecommendRequest {  account_id: None, description: "사내용 Windows 도구".into(), target_os: TargetOs::Windows, project_type: ProjectType::DesktopApp, provider: Provider::Claude };
        let p = build_prompt(&req, &stacks);
        assert!(p.contains("recommendations"));
        let first_line = p.lines().find(|l| l.starts_with("- id:")).unwrap();
        assert!(first_line.contains("windows"), "{first_line}");
        assert!(p.contains("사내용 Windows 도구"));
        assert!(serde_json::from_str::<Value>(SCHEMA).is_ok());
    }
}
