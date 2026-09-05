// Start the first agent session of a freshly created project and send the user's description as
// the first instruction, so "만들기" alone gets the agent working.
import type { ProjectRecord, SessionConfig, SessionRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { useSessionsStore } from "@/stores/sessions";

/** Prompt sent as the first message: the user's own words plus a short working agreement. */
export function buildFirstPrompt(description: string): string {
  const desc = description.trim();
  return [
    "다음 프로그램을 만들어 주세요.",
    "",
    desc,
    "",
    "진행 방식:",
    "1. 먼저 무엇을 만들지 3~5줄로 정리해서 보여 주세요.",
    "2. 바로 구현을 시작하고, 필요한 패키지 설치와 빌드까지 끝내 주세요.",
    "3. 끝나면 실행하는 방법과 확인할 화면을 한국어로 알려 주세요.",
  ].join("\n");
}

/** Session config from the project's defaults, falling back to the global settings. */
export function firstSessionConfig(project: ProjectRecord): SessionConfig {
  const settings = useAppStore.getState().settings;
  const provider = project.default_provider ?? settings?.default_provider ?? "claude";
  const settingsModel = provider === "claude" ? settings?.default_model_claude ?? null : settings?.default_model_codex ?? null;
  return {
    project_id: project.id,
    provider,
    model: (project.default_provider === provider ? project.default_model ?? null : null) ?? settingsModel,
    effort: project.default_effort ?? settings?.default_effort ?? null,
    permission: project.default_permission ?? settings?.default_permission ?? "auto_edit",
    append_system_prompt: null,
    resume_ref: null,
    fork: false,
  };
}

/** Start a session for `project`, select it and send `text` as the first message. */
export async function startFirstSession(project: ProjectRecord, text: string): Promise<SessionRecord> {
  const sessions = useSessionsStore.getState();
  const record = await sessions.startSession(firstSessionConfig(project));
  useAppStore.getState().selectSession(record.id);
  await useSessionsStore.getState().send(record.id, text);
  return record;
}
