// Register a directory created outside the app as a project. If only one of CLAUDE.md / AGENTS.md
// exists it is cloned into the other; when both are missing the user is offered to generate them.
import { create } from "zustand";
import { toast } from "sonner";
import { ipc, type ProjectRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";

interface DocsPrompt {
  project: ProjectRecord;
  missing: string[];
}

interface RegisterState {
  prompt: DocsPrompt | null;
  busy: boolean;
  setPrompt: (p: DocsPrompt | null) => void;
  setBusy: (b: boolean) => void;
}

export const useRegisterStore = create<RegisterState>((set) => ({
  prompt: null,
  busy: false,
  setPrompt: (prompt) => set({ prompt }),
  setBusy: (busy) => set({ busy }),
}));

/**
 * Register `path` (a folder picked or dropped by the user). Returns the record.
 * A lone CLAUDE.md or AGENTS.md is cloned into the other; when both are missing a prompt is queued
 * (rendered by AgentDocsPrompt).
 */
export async function registerExistingProject(path: string): Promise<ProjectRecord> {
  const { loadProjects, selectProject } = useAppStore.getState();
  const project = await ipc.projects.open(path);
  // Clone a lone CLAUDE.md / AGENTS.md before the project is selected (selection syncs too, silently).
  const cloned = await ipc.projects.syncAgentDocs(project.id).catch(() => [] as string[]);
  await loadProjects();
  selectProject(project.id);
  toast.success(`"${project.name}" 프로젝트를 등록했습니다${project.stack_id ? ` (스택: ${project.stack_id})` : ""}.`);
  if (cloned.length) toast.info(`${cloned.join(", ")}을(를) 기존 지침 파일에서 복제했습니다. 두 파일은 앞으로 같은 내용으로 유지됩니다.`);
  try {
    const st = await ipc.projects.agentDocsStatus(project.id);
    const missing = [...(!st.claude_md ? ["CLAUDE.md"] : []), ...(!st.agents_md ? ["AGENTS.md"] : [])];
    if (missing.length) useRegisterStore.getState().setPrompt({ project, missing });
  } catch {
    /* status is best-effort */
  }
  return project;
}

/** Register several dropped paths; non-directories are reported and skipped. */
export async function registerDroppedPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await registerExistingProject(p);
    } catch (e) {
      toast.error(`등록 실패 (${p}): ${String(e)}`);
    }
  }
}

if (import.meta.env.DEV) {
  // Automation hook for GUI verification (dev builds only).
  (window as unknown as { __vcRegister?: typeof registerExistingProject }).__vcRegister = registerExistingProject;
}
