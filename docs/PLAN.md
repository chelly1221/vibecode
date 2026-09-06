# Vibecoder(vibecode) 개발 계획서

Windows 데스크톱(exe)용 GUI 바이브코딩 도구. Claude Code와 OpenAI Codex, git을 한 화면에서 다루고,
프로젝트 생성부터 모델·effort·권한 설정까지 전부 GUI로 제어한다.

작성일: 2026-09-04

---

## 1. 제품 정의

### 1.1 한 줄 정의
"터미널 없이 쓰는 에이전트 코딩 IDE": 프로젝트 만들기 → 에이전트에게 지시 → 변경 확인/승인 → 커밋/푸시.

### 1.2 MVP 범위
- 프로젝트 생성 마법사(대상 OS·프로젝트 유형 선택 → 추천 스택 카드 → 스캐폴딩 → git init → GitHub 저장소 생성 옵션)
- 기존 프로젝트 열기(디렉터리 지정), 최근 프로젝트 목록
- 에이전트 세션: Claude / Codex 선택, 스트리밍 채팅 UI, 툴 호출 카드(파일 diff, 명령 실행 결과), 권한 승인 팝업
- 세션 설정 GUI: 모델, effort, 권한 모드, 예산, MCP 서버, 추가 시스템 프롬프트
- git 패널: status / diff / stage / commit(AI 메시지 생성) / push / pull / branch / log
- 설정 마법사: CLI 설치 감지·안내, 로그인 상태 확인, 내장 터미널에서 로그인 실행

### 1.3 이후 범위(v1.1+)
- 에이전트 턴마다 자동 체크포인트(shadow 브랜치)와 롤백
- 두 에이전트 협업(Claude가 구현, Codex가 리뷰 등 파이프라인)
- 자동 업데이트, 코드 서명, 원격 저장소 외 GitLab 지원

---

## 2. 아키텍처

> 구현 메모(2026-09-04): 코어는 `crates/core`(Tauri 비의존)와 `src-tauri`(얇은 셸)로 분리했다. 실행 백엔드(Native/WSL)는 `crates/core/src/backend/`에 있다. 빌드는 WSL에서 Windows 툴체인(cargo.exe, node.exe)을 직접 호출해 진행한다.

```
┌───────────────────────────── Tauri v2 (WebView2) ─────────────────────────────┐
│  Frontend: React + TypeScript + Vite + Tailwind + shadcn/ui + zustand          │
│   ├ 프로젝트 마법사   ├ 채팅/세션 뷰   ├ git 패널   ├ 설정   ├ xterm.js 터미널  │
└──────────────────────────────▲ IPC(commands / Channel<T> 이벤트) ─────────────┘
                               │
┌──────────────────────────────┴───────────── Rust core (src-tauri) ─────────────┐
│ agents/     AgentAdapter trait ─┬─ claude.rs  (claude -p, stream-json 양방향)   │
│                                 └─ codex.rs   (codex app-server, JSON-RPC)      │
│ permission/ 인앱 MCP 서버(HTTP, rmcp) → Claude의 --permission-prompt-tool 대상  │
│ git/        system git 서브프로세스 래퍼, GitHub REST(디바이스 플로우 OAuth)    │
│ projects/   스택 카탈로그(TOML), 스캐폴딩 러너, CLAUDE.md/AGENTS.md 생성        │
│ pty/        portable-pty (로그인 등 대화형 CLI용 내장 터미널)                   │
│ db/         SQLite(rusqlite): projects / sessions / messages / settings         │
│ secrets/    keyring → Windows Credential Manager                               │
│ process/    Job Object로 자식 프로세스 트리 수명 관리                           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 설계 원칙
- **에이전트 CLI는 번들하지 않고 감지·설치 안내**한다. Claude Code는 Anthropic 상용 약관 대상이라 재배포·브랜딩 제약이 있고, 두 CLI 모두 자체 자동 업데이트를 가진다. 앱은 PATH와 기본 설치 경로에서 바이너리를 찾고, 없으면 공식 설치 명령을 내장 터미널에서 실행해 준다.
- **에이전트별 차이는 `AgentAdapter` trait 뒤에 숨긴다.** UI는 공통 이벤트 모델(텍스트 델타, 툴 시작/종료, 승인 요청, 턴 종료, 비용)만 본다.
- **자식 프로세스는 Rust가 직접 관리**한다(tokio::process). shell 플러그인 대신 직접 spawn해야 stdin/stdout 양방향 스트리밍과 종료 제어가 정확하다.
- **git은 시스템 git을 호출**한다. 에이전트들도 같은 git을 쓰므로 자격증명·SSH·hooks 동작이 일치한다. libgit2는 성능이 필요한 read-only 조회에만 나중에 검토.

### 2.2 공통 이벤트 모델 (Rust → 프론트)
```
SessionEvent =
  | Init { provider, model, tools, mcp_servers, session_ref }
  | TextDelta { text }                      // 스트리밍 본문
  | Thinking { text }                       // 있으면 접힌 블록으로
  | ToolStart { id, name, input }           // Read/Edit/Bash, commandExecution/fileChange...
  | ToolEnd { id, output, is_error }
  | PermissionRequest { id, kind, detail }  // UI 승인 팝업 → 응답을 adapter로 회신
  | Plan { steps }                          // Codex turn/plan/updated, Claude plan 모드
  | TurnEnd { cost_usd?, usage, duration }
  | Error { message, retryable }
```

---

## 3. 에이전트 연동 상세

### 3.1 Claude Code 어댑터 (검증 버전 2.1.260)
프로세스 1개 = 세션 1개. 실행 형태:
```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --replay-user-messages \
  --model <id|alias> --effort <low|medium|high|xhigh|max> \
  --permission-mode <manual|acceptEdits|auto|plan|dontAsk|bypassPermissions> \
  --permission-prompts host --permission-prompt-tool mcp__vibecode__approve \
  --mcp-config <앱이 생성한 json> \
  [--resume <session-id> | --session-id <uuid>] [--fork-session] \
  [--max-budget-usd N] [--append-system-prompt ...] [--add-dir ...]
```
- stdout에서 NDJSON을 읽어 `system/init`, `assistant`, `user`, `stream_event`, `result`, `system/api_retry`, `permission_denied`를 `SessionEvent`로 변환한다.
- stdin으로 후속 사용자 메시지를 stream-json으로 보내 멀티턴을 유지한다.
- **권한 승인**: 앱 내부에 작은 MCP 서버(HTTP, localhost 임의 포트)를 띄우고 `approve` 툴을 노출한다. Claude가 승인이 필요할 때 이 툴을 호출하면 Rust가 프론트에 `PermissionRequest`를 보내고, 사용자의 선택이 툴 응답으로 돌아간다. 이 방식은 `--permission-prompt-tool`로 공식 문서화된 경로라 SDK 내부 프로토콜에 의존하지 않는다.
- **중단**: 턴 종료는 SIGINT, 프로세스 종료는 SIGTERM이 공식 동작인데 Windows에서는 SIGINT 전달이 까다롭다. `system/init`의 `capabilities`에 `interrupt_receipt_v1`가 있으면 stream-json 제어 메시지로 인터럽트하고, 없으면 stdin 종료 방식을 쓴다. 이 부분은 M2에서 실제 동작을 먼저 검증한다.
- **세션 복구**: `result`의 `session_id`를 DB에 저장하고 `--resume`으로 이어간다. 분기는 `--fork-session`.
- **모델 목록**: 별칭 `fable` / `opus` / `sonnet` 또는 정식 ID(`claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`). 정식 ID 목록은 앱 설정 파일에서 관리하고, 사용자가 직접 입력할 수도 있게 한다.
- **인증**: 사용자가 내장 터미널에서 `claude`로 로그인하거나 `claude setup-token`으로 장기 토큰을 만든다. 상태 확인은 `claude auth` 하위 명령을 사용한다. API 키 방식이면 세션 환경변수로 `ANTHROPIC_API_KEY`를 주입한다.
- **주의**: Windows 네이티브에서 Bash 툴을 쓰려면 Git for Windows가 필요하다(없으면 PowerShell 툴로 대체됨). 설정 마법사에서 감지해 안내한다.

### 3.2 Codex 어댑터
앱 전체에 `codex app-server` 프로세스 1개(stdio, JSON-RPC 2.0 NDJSON). 세션 = thread.
- 시작/복구/분기: `thread/start`, `thread/resume`, `thread/fork`
- 턴: `turn/start`(여기서 `model`, `effort`를 턴 단위로 넘길 수 있음), `turn/steer`, `turn/interrupt`
- 모델 목록: `model/list` → `supportedReasoningEfforts`까지 내려오므로 UI 드롭다운을 동적으로 구성
- 승인: 서버가 클라이언트에 `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`를 요청 → 앱이 `accept` / `acceptForSession` / `decline` / `cancel`로 응답
- 이벤트: `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/plan/updated`
- 정책: `approval_policy`(untrusted / on-request / never), `sandbox_mode`(read-only / workspace-write / danger-full-access), `model_reasoning_effort`(minimal / low / medium / high / xhigh)는 `~/.codex/config.toml` 또는 요청 파라미터로 설정
- 인증: 내장 터미널에서 `codex login`(ChatGPT 계정) 또는 `OPENAI_API_KEY`

### 3.3 설정 항목 ↔ 각 에이전트 매핑

| UI 설정 | Claude Code | Codex |
|---|---|---|
| 모델 | `--model` (fable / opus / sonnet / 정식 ID) | `model` (`model/list`로 조회) |
| Effort | `--effort` low / medium / high / xhigh / max | `model_reasoning_effort` minimal / low / medium / high / xhigh |
| 권한 프리셋 | `--permission-mode` manual / acceptEdits / auto / plan / dontAsk / bypassPermissions | `approval_policy` + `sandbox_mode` 조합 |
| 예산 | `--max-budget-usd` | 없음 → 앱이 usage로 집계 후 경고 |
| 세션 복구/분기 | `--resume`, `--fork-session` | `thread/resume`, `thread/fork` |
| 중단 | 제어 메시지 / SIGINT | `turn/interrupt` |
| MCP 서버 | `--mcp-config` + `.mcp.json` | `mcp_servers.<id>` (config.toml) |
| 프로젝트 지침 | `CLAUDE.md`, `--append-system-prompt` | `AGENTS.md` |
| 구조화 출력 | `--json-schema` (스택 추천 등 내부 용도) | 없음 → 프롬프트로 JSON 유도 |

UI에서는 "Effort" 슬라이더 하나를 두고 프로바이더별 값으로 변환한다(예: 최소 → Claude low / Codex minimal, 최대 → Claude max / Codex xhigh).

권한 프리셋 UI(공통 4단계):
1. 읽기 전용(계획만) → Claude `plan` / Codex `read-only` + `untrusted`
2. 매번 물어보기 → Claude `manual` / Codex `workspace-write` + `on-request`
3. 파일 수정 자동 승인 → Claude `acceptEdits` / Codex `workspace-write` + `on-request`(명령만 승인)
4. 전부 자동(위험 표시) → Claude `bypassPermissions` / Codex `danger-full-access` + `never`

---

## 4. 기능 명세

### 4.1 프로젝트 생성 마법사
1. 이름·경로: 부모 디렉터리 선택(dialog 플러그인) + 새 폴더 이름. 경로에 공백·비ASCII가 있으면 경고.
2. 대상 OS: Windows / macOS / Linux / 크로스플랫폼 데스크톱 / Web / Android / iOS / 서버·클라우드
3. 프로젝트 유형: 데스크톱 앱 / 웹앱 / 모바일 앱 / CLI / API 서버 / 라이브러리 / 게임 / 스크립트·자동화
4. 추천 스택: 카탈로그에서 (OS, 유형) 조건에 맞는 카드 표시. 카드에는 언어·프레임워크·근거·장단점·필요 도구(node, rustup, flutter, dotnet 등)와 설치 여부 아이콘. "AI에게 물어보기" 버튼은 사용자가 쓴 한 줄 설명을 선택된 에이전트에 보내 추천 JSON을 받아 카드로 추가(Claude는 `--json-schema`로 구조화 응답).
5. 옵션: git init(기본 on), .gitignore 템플릿, 라이선스, GitHub 저장소 생성(공개/비공개, 이름), CLAUDE.md + AGENTS.md 자동 생성, 기본 에이전트·모델·effort·권한 프리셋
6. 실행: 스캐폴딩 명령 로그를 실시간 표시 → 첫 커밋 → (옵션) 원격 push → 첫 세션 자동 시작 여부 선택

스택 카탈로그 초안(`resources/stacks.toml`):
- Windows 데스크톱: Tauri 2 + Rust + React/TS(추천), WinUI 3 + .NET, Electron + TS, Flutter
- 크로스플랫폼 데스크톱: Tauri 2, Electron, Flutter
- Web: Next.js, SvelteKit, Vite + React SPA, Astro(콘텐츠 사이트)
- API 서버: FastAPI, Hono/NestJS, Axum(Rust), Spring Boot, ASP.NET Core
- 모바일: Flutter, Expo(React Native), Kotlin(Android), Swift(iOS, macOS 필요 경고)
- CLI: Rust(clap), Go(cobra), Python(typer)
- 스크립트·자동화: Python(uv), PowerShell
- 게임: Godot, Unity(C#), Bevy(Rust)

각 항목: `id, name, targets[], types[], languages[], scaffold_cmd, prerequisites[], pros[], cons[], claude_md_snippet, agents_md_snippet`.

### 4.2 CLAUDE.md / AGENTS.md 생성
- 하나의 원본에서 두 파일을 생성한다. 내용: 프로젝트 목적, 스택, 빌드·테스트 명령, 코딩 규칙, 대상 OS 제약.
- 이후 사용자가 설정 화면에서 편집하면 두 파일을 동기화한다(Claude 쪽은 `@AGENTS.md` import 활용 검토).

### 4.3 세션·채팅 화면
- 좌측: 프로젝트 목록 → 세션 목록(프로바이더 아이콘, 모델, 마지막 사용)
- 중앙: 메시지 스트림. 텍스트는 마크다운 렌더, 코드블록 하이라이트. 툴 카드: 파일 편집은 diff 뷰(CodeMirror 6 merge), 명령 실행은 stdout/stderr 접기.
- 상단 바: 프로바이더·모델·effort·권한 프리셋 즉시 변경(다음 턴부터 적용), 비용·토큰 누계, 중단 버튼
- 승인 팝업: 명령/파일 변경 내용 표시, 승인 / 세션 동안 승인 / 거부 / 이유 입력
- 입력창: 멀티라인, 파일 드래그로 경로 삽입, `/` 명령 통과(Claude의 `/model`, `/effort` 등은 -p 모드에서도 동작)

### 4.4 git 패널
- status 트리(staged / unstaged / untracked), 파일 클릭 시 diff
- 커밋: 메시지 입력 + "AI로 작성"(선택된 에이전트에 staged diff 전달)
- push / pull / fetch, 브랜치 생성·전환, 로그(그래프는 후순위)
- 자격증명: SSH는 사용자 키 그대로, HTTPS는 keyring에 저장한 토큰을 `GIT_ASKPASS` 헬퍼로 공급

### 4.5 GitHub 연동
- 1단계(MVP): 사용자가 PAT를 붙여넣거나 SSH 사용. 저장소 생성은 REST `POST /user/repos`.
- 2단계: GitHub OAuth App 디바이스 플로우(앱에 client_id 내장, `repo` 스코프) → 토큰을 Windows Credential Manager에 저장.
- `gh` CLI가 설치돼 있으면 그것을 우선 사용하는 옵션 제공.

### 4.6 설정 마법사(첫 실행)
- 감지: `claude`, `codex`, `git`, `node`, `rustup` 등 PATH·기본 경로 검색, 버전 표시
- 설치: 공식 설치 명령을 내장 터미널에서 실행(`irm https://claude.ai/install.ps1 | iex`, `npm i -g @openai/codex` 등)
- 로그인: 내장 터미널에서 `claude`, `codex login` 실행 → 완료 후 상태 재확인
- 전역 기본값: 기본 에이전트, 모델, effort, 권한 프리셋, 프로젝트 루트 폴더

---

## 5. 데이터 저장

SQLite(`%APPDATA%\vibecode\vibecode.db`):
```
projects(id, name, path, target_os, project_type, stack_id, github_url,
         default_provider, default_model, default_effort, default_permission,
         created_at, last_opened_at)
sessions(id, project_id, provider, external_ref /* claude session_id | codex thread id */,
         title, model, effort, permission, total_cost_usd, created_at, last_used_at)
messages(id, session_id, seq, kind /* user|assistant|tool|permission|system */,
         payload_json, created_at)
settings(key, value_json)
```
비밀값(GitHub 토큰, API 키)은 DB가 아니라 keyring(Windows Credential Manager)에 저장한다.

---

## 6. 저장소 구조

```
vibecode/
├ src/                        # React 프론트엔드
│  ├ app/                     # 라우팅, 레이아웃
│  ├ features/
│  │  ├ projects/  (마법사, 목록)
│  │  ├ chat/      (세션 뷰, 메시지 렌더러, 승인 팝업)
│  │  ├ git/       (패널, diff)
│  │  ├ settings/  (전역·프로젝트·세션 설정)
│  │  └ terminal/  (xterm.js)
│  ├ components/ui/           # shadcn/ui
│  ├ lib/ipc.ts               # invoke/Channel 래퍼 (타입은 Rust에서 생성: ts-rs 또는 specta)
│  └ stores/                  # zustand
├ src-tauri/
│  ├ src/
│  │  ├ main.rs, lib.rs
│  │  ├ commands/             # #[tauri::command] 모음
│  │  ├ agents/ {mod.rs (trait), claude.rs, codex.rs, events.rs}
│  │  ├ permission/           # 인앱 MCP 서버
│  │  ├ git/ {git.rs, github.rs}
│  │  ├ projects/ {catalog.rs, scaffold.rs, agent_docs.rs}
│  │  ├ pty/, db/, secrets/, process/
│  ├ resources/stacks.toml
│  ├ tauri.conf.json, Cargo.toml
├ docs/PLAN.md
├ .github/workflows/build-windows.yml   # tauri-action으로 NSIS 설치본 생성
└ CLAUDE.md / AGENTS.md                  # 이 프로젝트 자체의 에이전트 지침
```

주요 크레이트: tauri 2, tauri-plugin-{dialog, log, opener, window-state, updater}, tokio, serde_json,
rusqlite(bundled), keyring, portable-pty, rmcp + axum(권한 MCP 서버), reqwest(GitHub), which,
uuid, thiserror, ts-rs(타입 공유), win32job(Windows 프로세스 트리 관리).

---

## 7. 마일스톤

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| M0 기반 | Tauri v2 + React/TS 스캐폴딩, 레이아웃 셸, SQLite 초기화, CI에서 Windows exe 빌드 | GitHub Actions에서 설치 가능한 exe 산출 |
| M1 프로젝트 | 마법사 전체, 스택 카탈로그, 스캐폴딩 러너, git init, CLAUDE.md/AGENTS.md 생성, 프로젝트 열기·목록 | 새 프로젝트를 만들고 첫 커밋까지 GUI로 완료 |
| M2 Claude | Claude 어댑터(stream-json), 채팅 UI, 툴 카드, 권한 MCP 서버, 세션 저장·복구, 모델/effort/권한 GUI | Claude로 파일을 수정하고 승인 팝업이 동작 |
| M3 Codex | app-server 어댑터, 승인 요청 처리, model/list 연동, 공통 설정 매핑 | 같은 UI로 Codex 세션 수행 |
| M4 git·GitHub | git 패널, AI 커밋 메시지, push/pull, GitHub 저장소 생성(PAT → 디바이스 플로우) | 마법사에서 GitHub 저장소까지 자동 생성·푸시 |
| M5 설정·온보딩 | 첫 실행 마법사, CLI 감지·설치·로그인, 내장 터미널, 전역·프로젝트·세션 3단계 설정 상속 | 깨끗한 Windows에서 설치 후 10분 내 첫 세션 |
| M6 마감 | NSIS 설치본(WebView2 부트스트래퍼 포함), 자동 업데이트, 로그·크래시 리포트, 프로세스 정리 검증 | 배포 가능한 v1.0 |

M2에서 가장 먼저 검증할 것: Windows에서 stream-json 양방향 스트리밍, 인터럽트 방식, 권한 MCP 서버 왕복 지연.

---

### 진행 현황 (2026-09-04)
- M0~M5 구현 완료. GUI 자동화(CDP)로 온보딩 → 프로젝트 열기 → git 패널 → Claude 세션 스트리밍 → 권한 승인 → 터미널 → 마법사 → 설정까지 실제 동작 확인.
- Codex는 어댑터·프로토콜 테스트 완료, 실제 턴은 사용자가 WSL에서 `codex login` 후 확인 필요.
- M6: NSIS 설치본 빌드와 GitHub Actions 워크플로 구성. 자동 업데이트는 개인용이라 제외.
- 앱 전용 리눅스 환경(2026-09-04 추가): WSL 미설치 시 관리자 권한 `wsl --install --no-distribution` + 재부팅 안내, 설치돼 있으면 Ubuntu Base 24.04 rootfs(약 30MB, SHA256 검증)를 받아 `Vibecoder` 배포판으로 임포트하고 git·ripgrep·python·Node LTS·Claude Code·Codex를 자동 설치(사용자 `vibe`, systemd 비활성). 이 PC에서 실제 프로비저닝 성공(약 2GB).
- 3차(2026-09-04): UI 미리보기(디자인 모드) — 프로젝트 dev 서버를 앱에서 실행하고 Tauri 자식 웹뷰로 채팅 옆에 실시간 표시, 요소 선택 → 입력창 삽입, 콘솔 오류 전달, 기기 프리셋.
- 4차(2026-09-05): 한 줄 설명으로 프로젝트 만들기 — 새 프로젝트 대화상자가 "무엇을 만들까요?" 한 화면으로 시작한다. `projects_ai_plan`이 카탈로그·설치된 도구·실행 환경을 담아 에이전트에게 구조화 출력(json-schema)으로 이름·폴더명·대상·유형·스택을 한 번에 받고, 카탈로그와 파일 시스템으로 검증한 뒤 요약 카드로 보여준다("이대로 만들기" / "바꾸기(고급)" → 값이 채워진 6단계 마법사). 생성이 끝나면 첫 세션을 자동으로 열고 사용자의 설명을 첫 지시로 보낸다. WSL에서 Windows 프로그램을 만드는 스택(stacks.toml `windows_toolchain`)은 `core::toolchain`이 Windows 쪽 rust/msvc/node/dotnet/go를 감지해 winget 설치 스크립트(호스트 PowerShell 터미널, `PtySpec.host`)를 제공하고, 생성 시 `~/.local/bin`에 `cargo.exe`/`npm.cmd` 같은 shim을 써서 스캐폴딩 명령·AGENTS.md 빌드 명령·미리보기 dev 명령을 Windows 툴체인으로 바꾼다. (2026-09-05 변경) 요약 화면의 "터미널에서 설치"/"Windows에 설치" 버튼은 없앴다. 대신 `projects_create`가 시작하자마자 없는 도구를 자동으로 설치한다(`projects::install`: Windows 툴체인은 호스트 winget, 백엔드 도구는 설치 힌트를 `sudo -n`·비대화형으로 실행, 실패해도 생성은 계속). 진행 상황은 `ScaffoldEvent::Install`로 스트리밍되어 생성 화면에 프로그레스 바(n/전체)와 도구별 상태로 표시되고, 실패·건너뜀 항목에만 "터미널에서 설치" 버튼이 남는다. 요약 화면은 "만들 때 자동으로 설치합니다: …" 한 줄만 보여 준다.
- 2차 배치(2026-09-04 완료, GUI 검증: 서브에이전트 작동창·질문 카드·체크포인트·파일 뷰어·MCP/정보 탭·라이트 테마): 턴별 체크포인트/롤백, 전용 환경 SSH 키·토큰 푸시, 완료/승인 알림, 파일 탐색기·뷰어, 에이전트 질문 카드, 마법사 AI 스택 추천, 세션 이름 변경/검색/보관/내보내기, MCP 서버 설정, 라이트 테마 점검, 자동 업데이트(docs/RELEASING.md), 서브에이전트 작동창.

## 8. 리스크와 대응

1. **약관·브랜딩**: Anthropic은 사전 승인 없이 서드파티 제품이 claude.ai 로그인이나 구독 한도를 제공하는 것을 허용하지 않으며, 제품 내 표기는 "Claude Code"가 아닌 "Claude"/"Claude Agent"를 쓰라고 안내한다. 개인 사용은 문제없지만 **배포 시에는 API 키 방식을 기본으로 두고 표기를 "Claude"로 통일**한다. Codex도 유사한 조건이 있는지 배포 전 확인.
2. **CLI 프로토콜 변경**: 두 CLI 모두 빠르게 바뀐다. 어댑터에 버전 감지와 호환 범위를 두고, 이벤트 파서에 샘플 로그 기반 테스트를 넣는다.
3. **Windows 프로세스 수명**: 앱 종료 시 에이전트가 띄운 dev 서버 등이 남을 수 있다. Job Object로 트리 전체를 묶고, 종료 전 SIGTERM 상당 처리 후 강제 종료한다.
4. **Git Bash 의존**: Claude의 Bash 툴은 Git for Windows가 있어야 한다. 마법사에서 필수 권장으로 안내하고 `CLAUDE_CODE_GIT_BASH_PATH`를 설정해 준다.
5. **SmartScreen 경고**: 코드 서명 없이 배포하면 경고가 뜬다. 초기엔 감수하고, 배포 단계에서 서명 인증서 구매를 결정한다.
6. **WebView2 부재**: 설치본에 evergreen 부트스트래퍼를 포함한다.
7. **경로 문제**: 한글·공백 경로에서 스캐폴딩 도구가 깨지는 경우가 있어 마법사에서 경고한다.

---

## 9. 결정 사항

1. **배포하지 않고 개인용으로만 사용한다.** (2026-09-04 확정) 따라서 8-1의 약관·브랜딩 제약은 적용되지 않으며, 인증은 API 키가 아니라 **각 CLI의 구독 로그인(claude 로그인, codex login)을 그대로 사용**한다. 앱은 로그인 상태만 확인하고, 로그인 자체는 내장 터미널에서 실행한다.
2. 프론트엔드 프레임워크: 미정. 후보 비교는 대화 기록 참조. 결정 후 M0 시작.
3. GitHub OAuth App: MVP는 PAT/SSH로 시작하고 디바이스 플로우는 후순위.
4. **WSL 실행 백엔드는 v1에 포함한다.** (2026-09-04 변경) 이 PC는 Claude Code가 WSL(Ubuntu)에만 설치·로그인되어 있고 Windows 쪽에는 claude.exe와 Git for Windows가 없다. 앱은 Windows에서 실행되지만 에이전트·git·스캐폴딩은 `ExecBackend` 추상화(Native | Wsl)를 통해 실행하며, 경로는 `C:\...` ↔ `/mnt/c/...`로 변환한다. 인터럽트는 WSL에서 pid 마커를 이용해 `kill -INT`로 보낸다.
5. **제품명은 Vibecoder, 아이콘은 핑크 `</>` 글리프(assets/icon.svg), 창은 커스텀 타이틀바(프레임 없는 창)로 한다.** (2026-09-04 사용자 요청) 저장소·크레이트 이름은 vibecode를 유지한다.
