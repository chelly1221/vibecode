//! Transcript export (Markdown) built from persisted messages.

use serde_json::Value;

use crate::context::AppContext;
use crate::error::Result;
use crate::types::{MessageKind, MessageRecord, ProjectRecord, SessionRecord};

const MAX_OUTPUT_CHARS: usize = 2000;

pub async fn session_markdown(ctx: &AppContext, session_id: &str) -> Result<String> {
    let session = ctx.db.get_session(session_id)?;
    let project = ctx.db.get_project(&session.project_id).ok();
    let messages = ctx.db.list_messages(session_id)?;
    Ok(render(&session, project.as_ref(), &messages))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}\n… ({}자 생략)", s.chars().count() - max)
}

fn fence(s: &str) -> String {
    // Pick a fence longer than any backtick run inside the content.
    let longest = s.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat(longest.max(3) + 1)
}

fn code_block(s: &str) -> String {
    let f = fence(s);
    format!("{f}\n{}\n{f}", s.trim_end())
}

fn pretty(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

pub fn render(session: &SessionRecord, project: Option<&ProjectRecord>, messages: &[MessageRecord]) -> String {
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", session.title));
    md.push_str("| 항목 | 값 |\n|---|---|\n");
    if let Some(p) = project {
        md.push_str(&format!("| 프로젝트 | {} (`{}`) |\n", p.name, p.path));
    }
    md.push_str(&format!("| 에이전트 | {} |\n", session.provider.as_str()));
    md.push_str(&format!("| 모델 | {} |\n", session.model.clone().unwrap_or_else(|| "기본값".into())));
    md.push_str(&format!("| 시작 | {} |\n", session.created_at.format("%Y-%m-%d %H:%M UTC")));
    md.push_str(&format!("| 마지막 사용 | {} |\n\n", session.last_used_at.format("%Y-%m-%d %H:%M UTC")));

    for m in messages {
        let p = &m.payload;
        match m.kind {
            MessageKind::User => {
                let text = p.get("text").and_then(Value::as_str).unwrap_or("");
                md.push_str("## 사용자\n\n");
                for line in text.lines() {
                    md.push_str(&format!("> {line}\n"));
                }
                md.push('\n');
            }
            MessageKind::Assistant => {
                let text = p.get("text").and_then(Value::as_str).unwrap_or("");
                md.push_str(&format!("{}\n\n", text.trim_end()));
            }
            MessageKind::Tool => {
                let name = p.get("name").and_then(Value::as_str).unwrap_or("tool");
                let is_error = p.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                let input = p.get("input").map(pretty).unwrap_or_default();
                let output = p.get("output").and_then(Value::as_str).unwrap_or("");
                md.push_str(&format!("<details>\n<summary>🔧 {name}{}</summary>\n\n", if is_error { " (오류)" } else { "" }));
                if !input.trim().is_empty() {
                    md.push_str(&format!("입력:\n\n{}\n\n", code_block(&truncate(&input, MAX_OUTPUT_CHARS))));
                }
                if !output.trim().is_empty() {
                    md.push_str(&format!("출력:\n\n{}\n\n", code_block(&truncate(output, MAX_OUTPUT_CHARS))));
                }
                md.push_str("</details>\n\n");
            }
            MessageKind::Permission => {
                let title = p.get("title").and_then(Value::as_str).unwrap_or("");
                let decision = p.get("decision").and_then(Value::as_str).unwrap_or("");
                let label = match decision {
                    "allow" => "허용",
                    "allow_session" => "세션 동안 허용",
                    "deny" => "거부",
                    other => other,
                };
                md.push_str(&format!("- 🔐 권한 요청 `{}` → **{label}**\n\n", title.replace('`', "'")));
            }
            MessageKind::System => match p.get("subtype").and_then(Value::as_str).unwrap_or("") {
                "turn_end" => {
                    let ms = p.get("duration_ms").and_then(Value::as_i64).unwrap_or(0);
                    let usage = p.get("usage");
                    let inp = usage.and_then(|u| u.get("input_tokens")).and_then(Value::as_i64).unwrap_or(0);
                    let out = usage.and_then(|u| u.get("output_tokens")).and_then(Value::as_i64).unwrap_or(0);
                    md.push_str(&format!("*턴 완료 · {:.1}s · 입력 {inp} · 출력 {out} 토큰*\n\n---\n\n", ms as f64 / 1000.0));
                }
                "error" => {
                    md.push_str(&format!("> ⚠️ 오류: {}\n\n", p.get("message").and_then(Value::as_str).unwrap_or("")));
                }
                "checkpoint" => {
                    md.push_str(&format!("*📌 체크포인트: {}*\n\n", p.get("label").and_then(Value::as_str).unwrap_or("")));
                }
                _ => {}
            },
        }
    }
    md
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::types::{PermissionPreset, Provider};
    use chrono::Utc;

    #[test]
    fn renders_transcript() {
        let db = Db::open_in_memory().unwrap();
        let now = Utc::now();
        let project = ProjectRecord {
            id: "p".into(),
            name: "demo".into(),
            path: "C:\\demo".into(),
            target_os: None,
            project_type: None,
            stack_id: None,
            github_url: None,
            default_provider: None,
            default_model: None,
            default_effort: None,
            default_permission: None,
            created_at: now,
            last_opened_at: now,
        };
        db.upsert_project(&project).unwrap();
        let session = SessionRecord {
            id: "s".into(),
            project_id: "p".into(),
            provider: Provider::Claude,
            external_ref: None,
            title: "제목".into(),
            model: Some("claude-opus-5".into()),
            effort: None,
            permission: PermissionPreset::FullAuto,
            total_cost_usd: 0.0,
            archived: false,
            created_at: now,
            last_used_at: now,
        };
        db.upsert_session(&session).unwrap();
        db.append_message("s", MessageKind::User, serde_json::json!({"text": "안녕\n둘째 줄"})).unwrap();
        db.append_message("s", MessageKind::Assistant, serde_json::json!({"text": "답변입니다"})).unwrap();
        db.append_message("s", MessageKind::Tool, serde_json::json!({"id":"t","name":"Bash","input":{"command":"ls"},"output":"a\nb","is_error":false})).unwrap();
        db.append_message("s", MessageKind::Permission, serde_json::json!({"request_id":"r","kind":"command","title":"ls -la","detail":{},"decision":"allow"})).unwrap();
        db.append_message("s", MessageKind::System, serde_json::json!({"subtype":"checkpoint","checkpoint_id":"c","label":"안녕"})).unwrap();
        db.append_message("s", MessageKind::System, serde_json::json!({"subtype":"turn_end","cost_usd":null,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_tokens":0,"cache_write_tokens":0},"duration_ms":1500,"stop_reason":null})).unwrap();
        let md = render(&session, Some(&project), &db.list_messages("s").unwrap());
        assert!(md.starts_with("# 제목\n"));
        assert!(md.contains("| 프로젝트 | demo (`C:\\demo`) |"));
        assert!(md.contains("> 안녕\n> 둘째 줄"));
        assert!(md.contains("답변입니다"));
        assert!(md.contains("<summary>🔧 Bash</summary>"));
        assert!(md.contains("\"command\": \"ls\""));
        assert!(md.contains("권한 요청 `ls -la` → **허용**"));
        assert!(md.contains("체크포인트: 안녕"));
        assert!(md.contains("턴 완료 · 1.5s · 입력 10 · 출력 5"));
    }

    #[test]
    fn truncates_and_fences() {
        let long = "x".repeat(2500);
        let t = truncate(&long, MAX_OUTPUT_CHARS);
        assert!(t.contains("500자 생략"));
        assert!(code_block("a ``` b").starts_with("````\n"));
    }
}
