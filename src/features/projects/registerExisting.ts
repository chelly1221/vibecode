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
  progress: { path: string; message: string } | null;
  setPrompt: (p: DocsPrompt | null) => void;
}

export const useRegisterStore = create<RegisterState>((set) => ({
  prompt: null,
  progress: null,
  setPrompt: (prompt) => set({ prompt }),
}));

/**
 * Register `path` (a folder picked or dropped by the user). Returns the record.
 * A lone CLAUDE.md or AGENTS.md is cloned into the other; when both are missing a prompt is queued
 * (rendered by AgentDocsPrompt).
 */
export async function registerExistingProject(path: string): Promise<ProjectRecord> {
  if (useRegisterStore.getState().progress) {
    throw new Error("프로젝트를 등록하고 있어요. 완료 후 다시 시도해 주세요.");
  }
  const { loadProjects, selectProject } = useAppStore.getState();
  const reportProgress = (message: string) => useRegisterStore.setState({ progress: { path, message } });
  reportProgress("폴더와 프로젝트 정보를 확인하고 있어요");
  try {
    const project = await ipc.projects.open(path);
    reportProgress("프로젝트 지침 파일을 확인하고 있어요");
    // Clone a lone CLAUDE.md / AGENTS.md before the project is selected (selection syncs too, silently).
    const cloned = await ipc.projects.syncAgentDocs(project.id).catch(() => [] as string[]);
    let prompt: DocsPrompt | null = null;
    try {
      const st = await ipc.projects.agentDocsStatus(project.id);
      const missing = [...(!st.claude_md ? ["CLAUDE.md"] : []), ...(!st.agents_md ? ["AGENTS.md"] : [])];
      if (missing.length) prompt = { project, missing };
    } catch {
      /* status is best-effort */
    }
    reportProgress("프로젝트 화면을 준비하고 있어요");
    await loadProjects();
    selectProject(project.id);
    useRegisterStore.getState().setPrompt(prompt);
    toast.success(`"${project.name}" 프로젝트를 등록했습니다${project.stack_id ? ` (스택: ${project.stack_id})` : ""}.`);
    if (cloned.length) toast.info(`${cloned.join(", ")}을(를) 기존 지침 파일에서 복제했습니다. 두 파일은 앞으로 같은 내용으로 유지됩니다.`);
    return project;
  } finally {
    useRegisterStore.setState({ progress: null });
  }
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
