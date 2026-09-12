// "새 대화" without a dialog: start a session with the project's defaults (provider, model,
// effort, permission and the project's accounts). The only thing that can stop it is a missing
// AI account for the project's provider, in which case the account picker is opened instead.

import { toast } from "sonner";
import { ipc, type SessionRecord } from "@/lib/ipc";
import { firstSessionConfig } from "@/features/projects/firstSession";
import { useAppStore } from "@/stores/app";
import { useSessionsStore } from "@/stores/sessions";

let inFlight: Promise<SessionRecord | null> | null = null;

/**
 * Start a new session for `projectId` with its defaults and select it. Resolves with the record,
 * or null when the project has no account for its provider (the account dialog is opened).
 * Concurrent calls share one start so a double click cannot open two sessions.
 */
export function startQuickSession(projectId: string): Promise<SessionRecord | null> {
  if (inFlight) return inFlight;
  inFlight = run(projectId).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(projectId: string): Promise<SessionRecord | null> {
  const app = useAppStore.getState();
  const project = app.projects.find((p) => p.id === projectId);
  if (!project) throw new Error("프로젝트를 찾을 수 없습니다");
  const config = firstSessionConfig(project);
  const accounts = await ipc.accounts.project(projectId);
  if (!accounts[config.provider]) {
    toast.info("먼저 이 프로젝트에서 사용할 AI 계정을 선택해 주세요.");
    useAppStore.getState().setAccountsDialogProjectId(projectId);
    return null;
  }
  const record = await useSessionsStore.getState().startSession(config);
  const now = useAppStore.getState();
  if (now.activeProjectId === projectId) now.selectSession(record.id);
  return record;
}

/** UI wrapper: progress toast while the CLI starts, error toast on failure. */
export async function startQuickSessionWithToast(projectId: string): Promise<void> {
  const id = toast.loading("새 대화를 여는 중…");
  try {
    await startQuickSession(projectId);
  } catch (e) {
    toast.error("대화를 시작할 수 없습니다", { description: String(e) });
  } finally {
    toast.dismiss(id);
  }
}
