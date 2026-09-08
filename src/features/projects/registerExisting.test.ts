import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc, type ProjectRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { cancelExistingRegistration, pickAndRegisterExistingProject, registerExistingProject, submitExistingRegistration, useRegisterStore } from "./registerExisting";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({ ipc: { projects: {
  open: vi.fn(), list: vi.fn(), syncAgentDocs: vi.fn(), agentDocsStatus: vi.fn(),
} } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const project = { id: "existing", name: "Existing", path: "C:\\code\\existing" } as ProjectRecord;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  useRegisterStore.setState({ progress: null, prompt: null, draft: null });
  useAppStore.setState({ projects: [], activeProjectId: null, activeSessionId: null });
  vi.mocked(ipc.projects.open).mockResolvedValue(project);
  vi.mocked(ipc.projects.list).mockResolvedValue([project]);
  vi.mocked(ipc.projects.syncAgentDocs).mockResolvedValue([]);
  vi.mocked(ipc.projects.agentDocsStatus).mockResolvedValue({ claude_md: false, agents_md: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("existing folder registration feedback", () => {
  it("covers the native picker response delay and stays visible until the project is ready", async () => {
    const picker = deferred<string | null>();
    const listing = deferred<ProjectRecord[]>();
    vi.mocked(openDialog).mockReturnValue(picker.promise);
    vi.mocked(ipc.projects.list).mockReturnValue(listing.promise);
    const pending = pickAndRegisterExistingProject();

    expect(useRegisterStore.getState().progress).not.toBeNull();
    // The native call must wait for the already-visible progress UI to paint.
    expect(openDialog).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(useRegisterStore.getState().progress).not.toBeNull();
    expect(ipc.projects.open).not.toHaveBeenCalled();

    const idleGaps: boolean[] = [];
    const unsubscribe = useRegisterStore.subscribe((s) => idleGaps.push(!s.progress && !s.draft));
    picker.resolve(project.path);
    await vi.runAllTimersAsync();
    expect(useRegisterStore.getState().draft?.path).toBe(project.path);
    expect(useRegisterStore.getState().draft?.name).toBe("existing");
    expect(ipc.projects.open).not.toHaveBeenCalled();
    useRegisterStore.getState().setName("내 프로젝트");
    const submission = submitExistingRegistration();
    expect(useRegisterStore.getState().progress?.path).toBe(project.path);
    await vi.runAllTimersAsync();
    expect(ipc.projects.open).toHaveBeenCalledWith(project.path, "내 프로젝트");
    expect(useAppStore.getState().activeProjectId).toBeNull();
    expect(idleGaps).not.toContain(true);
    unsubscribe();

    listing.resolve([project]);
    await submission;
    await expect(pending).resolves.toEqual(project);
    expect(useRegisterStore.getState().progress).toBeNull();
    expect(useRegisterStore.getState().prompt?.project.id).toBe(project.id);
    expect(useAppStore.getState().activeProjectId).toBe(project.id);
  });

  it("clears feedback on picker cancellation without registering a project", async () => {
    vi.mocked(openDialog).mockResolvedValue(null);
    const pending = pickAndRegisterExistingProject();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
    expect(useRegisterStore.getState().progress).toBeNull();
    expect(ipc.projects.open).not.toHaveBeenCalled();
  });

  it("releases the busy state after native picker errors so the user can retry", async () => {
    vi.mocked(openDialog).mockRejectedValueOnce(new Error("picker failed")).mockResolvedValueOnce(null);
    const failure = expect(pickAndRegisterExistingProject()).rejects.toThrow("picker failed");
    await vi.runAllTimersAsync();
    await failure;
    expect(useRegisterStore.getState().progress).toBeNull();
    const retry = pickAndRegisterExistingProject();
    await vi.runAllTimersAsync();
    await expect(retry).resolves.toBeNull();
  });

  it("keeps the entered name on failure and retries without another picker", async () => {
    vi.mocked(ipc.projects.open).mockRejectedValueOnce(new Error("folder unavailable")).mockResolvedValueOnce(project);
    const pending = registerExistingProject(project.path);
    expect(useRegisterStore.getState().progress?.path).toBe(project.path);
    expect(ipc.projects.open).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    useRegisterStore.getState().setName("사용자 지정 이름");
    const submission = submitExistingRegistration();
    await vi.runAllTimersAsync();
    await submission;
    expect(useRegisterStore.getState().progress).toBeNull();
    expect(useRegisterStore.getState().draft?.name).toBe("사용자 지정 이름");
    expect(useRegisterStore.getState().draft?.error).toContain("folder unavailable");
    const retry = submitExistingRegistration();
    await vi.runAllTimersAsync();
    await retry;
    await expect(pending).resolves.toEqual(project);
    expect(openDialog).not.toHaveBeenCalled();
    expect(useRegisterStore.getState().draft).toBeNull();
  });

  it("cancels the name form without changing projects and allows another registration", async () => {
    const pending = registerExistingProject(project.path);
    await vi.runAllTimersAsync();
    await expect(registerExistingProject(project.path)).rejects.toThrow();
    cancelExistingRegistration();
    await expect(pending).resolves.toBeNull();
    expect(ipc.projects.open).not.toHaveBeenCalled();
    const retry = registerExistingProject(project.path);
    await vi.runAllTimersAsync();
    cancelExistingRegistration();
    await expect(retry).resolves.toBeNull();
  });

  it("validates the name and prevents duplicate submission while registration is running", async () => {
    const pending = registerExistingProject(project.path);
    await vi.runAllTimersAsync();
    useRegisterStore.getState().setName("  ");
    await submitExistingRegistration();
    expect(useRegisterStore.getState().draft?.error).toBeTruthy();
    expect(ipc.projects.open).not.toHaveBeenCalled();
    useRegisterStore.getState().setName("  새 이름  ");
    const submission = submitExistingRegistration();
    await submitExistingRegistration();
    cancelExistingRegistration();
    expect(useRegisterStore.getState().draft).not.toBeNull();
    await vi.runAllTimersAsync();
    await submission;
    await pending;
    expect(ipc.projects.open).toHaveBeenCalledExactlyOnceWith(project.path, "새 이름");
  });

  it("prefills the saved display name when opening a registered folder again", async () => {
    useAppStore.setState({ projects: [project] });
    const pending = registerExistingProject(project.path + "\\");
    await vi.runAllTimersAsync();
    expect(useRegisterStore.getState().draft?.name).toBe(project.name);
    cancelExistingRegistration();
    await pending;
  });

  it("prevents duplicate pickers and dropped registrations while a picker response is pending", async () => {
    const picker = deferred<string | null>();
    vi.mocked(openDialog).mockReturnValue(picker.promise);
    const pending = pickAndRegisterExistingProject();
    await vi.runAllTimersAsync();
    await expect(pickAndRegisterExistingProject()).rejects.toThrow();
    await expect(registerExistingProject(project.path)).rejects.toThrow();
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(ipc.projects.open).not.toHaveBeenCalled();
    expect(useRegisterStore.getState().progress).not.toBeNull();
    picker.resolve(null);
    await pending;
  });
});
