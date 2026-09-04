//! Generates CLAUDE.md and AGENTS.md from the project's choices.
//! AGENTS.md holds the content; CLAUDE.md is a short header that imports it
//! (`@AGENTS.md`) so both agents read one source of truth.

use crate::types::{ProjectRecord, ProjectType, StackInfo, TargetOs};

pub struct AgentDocs {
    pub claude_md: String,
    pub agents_md: String,
}

pub fn target_label(t: TargetOs) -> &'static str {
    match t {
        TargetOs::Windows => "Windows",
        TargetOs::Macos => "macOS",
        TargetOs::Linux => "Linux",
        TargetOs::CrossDesktop => "크로스플랫폼 데스크톱(Windows/macOS/Linux)",
        TargetOs::Web => "웹 브라우저",
        TargetOs::Android => "Android",
        TargetOs::Ios => "iOS",
        TargetOs::Server => "서버/클라우드",
    }
}

pub fn type_label(t: ProjectType) -> &'static str {
    match t {
        ProjectType::DesktopApp => "데스크톱 앱",
        ProjectType::WebApp => "웹 앱",
        ProjectType::MobileApp => "모바일 앱",
        ProjectType::Cli => "CLI 도구",
        ProjectType::ApiServer => "API 서버",
        ProjectType::Library => "라이브러리",
        ProjectType::Game => "게임",
        ProjectType::Script => "스크립트/자동화",
    }
}

pub fn generate(project: &ProjectRecord, stack: Option<&StackInfo>, description: &str) -> AgentDocs {
    let mut a = String::new();
    a.push_str(&format!("# {}\n\n", project.name));
    let desc = description.trim();
    a.push_str("## 프로젝트 개요\n");
    if desc.is_empty() {
        a.push_str("(설명 없음 — 첫 세션에서 목적을 정리해 여기에 적어 두세요.)\n\n");
    } else {
        a.push_str(desc);
        a.push_str("\n\n");
    }

    a.push_str("## 대상과 스택\n");
    if let Some(t) = project.target_os {
        a.push_str(&format!("- 대상 플랫폼: {}\n", target_label(t)));
    }
    if let Some(t) = project.project_type {
        a.push_str(&format!("- 프로젝트 유형: {}\n", type_label(t)));
    }
    match stack {
        Some(s) => {
            a.push_str(&format!("- 스택: {} — {}\n", s.name, s.summary));
            if !s.languages.is_empty() {
                a.push_str(&format!("- 언어: {}\n", s.languages.join(", ")));
            }
        }
        None => a.push_str("- 스택: (지정되지 않음 — 저장소 내용을 보고 파악)\n"),
    }
    a.push('\n');

    a.push_str("## 빌드 · 실행 · 테스트\n");
    match stack.and_then(|s| s.agent_notes.as_deref()).map(str::trim).filter(|n| !n.is_empty()) {
        Some(notes) => {
            a.push_str(notes);
            a.push('\n');
        }
        None => a.push_str("- (스택별 명령을 여기에 정리하세요.)\n"),
    }
    a.push('\n');

    a.push_str("## 작업 규칙\n");
    a.push_str("- 변경은 작게 나누어 커밋하고, 커밋 메시지는 Conventional Commits(`feat:`, `fix:`, `refactor:` ...)를 따른다.\n");
    a.push_str("- 작업을 마치기 전에 반드시 빌드와 테스트를 실행하고, 실패하면 고친 뒤 끝낸다.\n");
    a.push_str("- 새 의존성은 꼭 필요할 때만 추가하고 이유를 커밋 메시지에 남긴다.\n");
    a.push_str("- 기존 코드 스타일과 디렉터리 구조를 따른다. 대규모 구조 변경은 먼저 계획을 설명한다.\n");
    a.push_str("- 비밀값(.env, 토큰, 키)은 저장소에 커밋하지 않는다.\n");
    a.push_str("- 사용자에게 보이는 문구는 한국어, 코드 식별자와 주석은 영어로 쓴다.\n");

    let claude = format!(
        "# {name}\n\n프로젝트 지침은 AGENTS.md 한 곳에서 관리한다 (Claude Code와 Codex가 같은 파일을 읽는다).\n\n@AGENTS.md\n",
        name = project.name
    );

    AgentDocs { claude_md: claude, agents_md: a }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn project() -> ProjectRecord {
        ProjectRecord {
            id: "x".into(),
            name: "demo".into(),
            path: "C:\\p\\demo".into(),
            target_os: Some(TargetOs::Windows),
            project_type: Some(ProjectType::DesktopApp),
            stack_id: Some("tauri-react".into()),
            github_url: None,
            default_provider: None,
            default_model: None,
            default_effort: None,
            default_permission: None,
            created_at: Utc::now(),
            last_opened_at: Utc::now(),
        }
    }

    #[test]
    fn generates_both_docs() {
        let stack = crate::projects::catalog::get("tauri-react").unwrap().unwrap();
        let docs = generate(&project(), Some(&stack), "메모 앱");
        assert!(docs.claude_md.starts_with("# demo"));
        assert!(docs.claude_md.contains("@AGENTS.md"));
        assert!(docs.agents_md.contains("메모 앱"));
        assert!(docs.agents_md.contains("Tauri 2 + Rust + React/TS"));
        assert!(docs.agents_md.contains("npm run tauri dev"));
        assert!(docs.agents_md.contains("Windows"));
        assert!(docs.agents_md.contains("테스트"));
    }

    #[test]
    fn works_without_stack_or_description() {
        let docs = generate(&project(), None, "   ");
        assert!(docs.agents_md.contains("설명 없음"));
        assert!(docs.agents_md.contains("지정되지 않음"));
    }
}
