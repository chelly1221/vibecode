// Register a directory created outside the app as a project. If only one of CLAUDE.md / AGENTS.md
// exists it is cloned into the other; when both are missing the user is offered to generate them.
import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { ipc, type ProjectRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { basename } from "./format";
import { validateProjectName } from "./validation";

interface DocsPrompt {
  project: ProjectRecord;
  missing: string[];
}

interface RegisterState {
  prompt: DocsPrompt | null;
  progress: { path: string | null; message: string } | null;
  draft: { path: string; name: string; error: string | null; resolve: (project: ProjectRecord | null) => void } | null;
  setPrompt: (p: DocsPrompt | null) => void;
  setName: (name: string) => void;
}

export const useRegisterStore = create<RegisterState>((set) => ({
  prompt: null,
  progress: null,
  draft: null,
  setPrompt: (prompt) => set({ prompt }),
  setName: (name) => set((s) => s.draft && !s.progress ? { draft: { ...s.draft, name, error: null } } : {}),
}));

function ensureRegistrationIdle() {
  const { progress, draft } = useRegisterStore.getState();
  if (progress || draft) {
    throw new Error("프로젝트를 등록하고 있어요. 완료 후 다시 시도해 주세요.");
  }
}

function reportProgress(path: string | null, message: string) {
  flushSync(() => useRegisterStore.setState({ progress: { path, message } }));
}

// Commit and paint the progress UI before entering the native dialog / registration IPC.
// Setting React state alone can leave the previous screen visible while native work begins.
function waitForProgressPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/** Keep feedback visible for the entire native picker round trip, including after it closes. */
export async function pickAndRegisterExistingProject(title = "등록할 프로젝트 폴더 선택"): Promise<ProjectRecord | null> {
  ensureRegistrationIdle();
  reportProgress(null, "폴더 선택을 처리하고 있어요");
  try {
    await waitForProgressPaint();
    const path = await openDialog({ directory: true, multiple: false, title });
    if (!path) return null;
    return await requestRegistration(path);
  } finally {
    useRegisterStore.setState({ progress: null });
  }
}

/** Register a dropped directory with the same progress UI, without opening a picker. */
export async function registerExistingProject(path: string): Promise<ProjectRecord | null> {
  ensureRegistrationIdle();
  try {
    reportProgress(path, "등록 정보를 준비하고 있어요");
    await waitForProgressPaint();
    return await requestRegistration(path);
  } finally {
    useRegisterStore.setState({ progress: null });
  }
}

function requestRegistration(path: string): Promise<ProjectRecord | null> {
  const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const existing = useAppStore.getState().projects.find((p) => normalizePath(p.path) === normalizePath(path));
  return new Promise((resolve) => {
    flushSync(() => useRegisterStore.setState({
      progress: null,
      draft: { path, name: existing?.name ?? basename(path), error: null, resolve },
    }));
  });
}

export function cancelExistingRegistration() {
  const { draft, progress } = useRegisterStore.getState();
  if (!draft || progress) return;
  useRegisterStore.setState({ draft: null });
  draft.resolve(null);
}

/** Keep the name and error available for retry without reopening the native picker. */
export async function submitExistingRegistration(): Promise<void> {
  const { draft, progress } = useRegisterStore.getState();
  if (!draft || progress) return;
  const name = draft.name.trim();
  const error = validateProjectName(name);
  if (error) {
    useRegisterStore.setState({ draft: { ...draft, error } });
    return;
  }
  try {
    const project = await registerProject(draft.path, name);
    useRegisterStore.setState({ draft: null, progress: null });
    draft.resolve(project);
  } catch (e) {
    useRegisterStore.setState({ progress: null, draft: { ...draft, name, error: String(e) } });
  }
}

/** Clone lone agent docs and queue the missing-docs prompt once the project is ready. */
async function registerProject(path: string, name: string): Promise<ProjectRecord> {
  const { loadProjects, selectProject } = useAppStore.getState();
  reportProgress(path, "폴더와 프로젝트 정보를 확인하고 있어요");
  await waitForProgressPaint();
  const project = await ipc.projects.open(path, name);
  reportProgress(path, "프로젝트 지침 파일을 확인하고 있어요");
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
  reportProgress(path, "프로젝트 화면을 준비하고 있어요");
  await loadProjects();
  selectProject(project.id);
  useRegisterStore.getState().setPrompt(prompt);
  toast.success(`"${project.name}" 프로젝트를 등록했습니다${project.stack_id ? ` (스택: ${project.stack_id})` : ""}.`);
  if (cloned.length) toast.info(`${cloned.join(", ")}을(를) 기존 지침 파일에서 복제했습니다. 두 파일은 앞으로 같은 내용으로 유지됩니다.`);
  return project;
}

/** Register several dropped paths; non-directories are reported and skipped. */
export async function registerDroppedPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      if (!await registerExistingProject(p)) break;
    } catch (e) {
      toast.error(`등록 실패 (${p}): ${String(e)}`);
    }
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Automation hook for GUI verification (dev builds only).
  (window as unknown as { __vcRegister?: typeof registerExistingProject }).__vcRegister = registerExistingProject;
}
