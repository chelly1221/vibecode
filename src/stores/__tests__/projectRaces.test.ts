import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type FsFile, type GitStatus } from "@/lib/ipc";
import { useGitStore } from "../git";
import { useFilesStore } from "../files";

vi.mock("@/lib/ipc", () => ({ ipc: {
  git: { status: vi.fn(), branches: vi.fn(), diff: vi.fn(), log: vi.fn(), stage: vi.fn() },
  fs: { list: vi.fn(), read: vi.fn() },
} }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const status = (branch: string) => ({ is_repo: true, branch, files: [], ahead: 0, behind: 0 } as GitStatus);
const file = (content: string) => ({ rel_path: "README.md", content, size: 1, binary: false, truncated: false } as FsFile);

beforeEach(() => {
  vi.resetAllMocks();
  useGitStore.getState().setProject(null);
  useFilesStore.getState().setProject(null);
  vi.mocked(ipc.fs.list).mockResolvedValue([]);
  vi.mocked(ipc.git.branches).mockResolvedValue([]);
  vi.mocked(ipc.git.status).mockResolvedValue(status("main"));
});

describe("project-scoped Git requests", () => {
  it("ignores branches that finish after switching projects", async () => {
    const branches = deferred<never[]>();
    vi.mocked(ipc.git.branches).mockReturnValueOnce(branches.promise);
    useGitStore.getState().setProject("A");
    const pending = useGitStore.getState().refresh();
    await Promise.resolve();
    useGitStore.getState().setProject("B");
    await useGitStore.getState().refresh();
    branches.resolve([]);
    await pending;
    expect(useGitStore.getState().projectId).toBe("B");
    expect(useGitStore.getState().status?.branch).toBe("main");
  });
  it("does not apply an older refresh over a newer one", async () => {
    const old = deferred<GitStatus>();
    vi.mocked(ipc.git.status).mockReturnValueOnce(old.promise).mockResolvedValueOnce(status("new"));
    useGitStore.getState().setProject("A");
    const pending = useGitStore.getState().refresh();
    await useGitStore.getState().refresh();
    old.resolve(status("old"));
    await pending;
    expect(useGitStore.getState().status?.branch).toBe("new");
  });
  it("keeps staged and unstaged diffs of the same path separate", async () => {
    const old = deferred<string>();
    vi.mocked(ipc.git.diff).mockReturnValueOnce(old.promise).mockResolvedValueOnce("staged");
    useGitStore.getState().setProject("A");
    const pending = useGitStore.getState().selectFile({ path: "README.md", staged: false });
    await useGitStore.getState().selectFile({ path: "README.md", staged: true });
    old.resolve("unstaged");
    await pending;
    expect(useGitStore.getState().diff).toBe("staged");
  });
  it("ignores a same-path diff after leaving and returning to a project", async () => {
    const old = deferred<string>();
    vi.mocked(ipc.git.diff).mockReturnValueOnce(old.promise).mockResolvedValueOnce("fresh");
    useGitStore.getState().setProject("A");
    const pending = useGitStore.getState().selectFile({ path: "README.md", staged: false });
    useGitStore.getState().setProject("B");
    useGitStore.getState().setProject("A");
    await useGitStore.getState().selectFile({ path: "README.md", staged: false });
    old.resolve("stale");
    await pending;
    expect(useGitStore.getState().diff).toBe("fresh");
  });
  it("rejects duplicate mutations and does not clear another project's busy state", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    vi.mocked(ipc.git.stage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useGitStore.getState().setProject("A");
    const pendingA = useGitStore.getState().stage(["a"]);
    await expect(useGitStore.getState().stage(["a"])).rejects.toThrow();
    useGitStore.getState().setProject("B");
    const pendingB = useGitStore.getState().stage(["b"]);
    first.resolve();
    await pendingA;
    expect(useGitStore.getState().busy).toBe("stage");
    second.resolve();
    await pendingB;
    expect(useGitStore.getState().busy).toBeNull();
  });
});

describe("project-scoped file reads", () => {
  it("never displays another project's same-name file", async () => {
    const old = deferred<FsFile>();
    vi.mocked(ipc.fs.read).mockReturnValueOnce(old.promise).mockResolvedValueOnce(file("B"));
    useFilesStore.getState().setProject("A");
    const pending = useFilesStore.getState().openFile("README.md");
    useFilesStore.getState().setProject("B");
    await useFilesStore.getState().openFile("README.md");
    old.resolve(file("A"));
    await pending;
    expect(useFilesStore.getState().viewer?.file?.content).toBe("B");
  });
  it("does not reopen a viewer closed while a read is in flight", async () => {
    const pendingFile = deferred<FsFile>();
    vi.mocked(ipc.fs.read).mockReturnValueOnce(pendingFile.promise);
    useFilesStore.getState().setProject("A");
    const pending = useFilesStore.getState().openFile("README.md");
    useFilesStore.getState().closeViewer();
    pendingFile.resolve(file("A"));
    await pending;
    expect(useFilesStore.getState().viewer).toBeNull();
  });
  it("retains a successful retry when the previous read later fails", async () => {
    const old = deferred<FsFile>();
    vi.mocked(ipc.fs.read).mockReturnValueOnce(old.promise).mockResolvedValueOnce(file("new"));
    useFilesStore.getState().setProject("A");
    const pending = useFilesStore.getState().openFile("README.md");
    await useFilesStore.getState().openFile("README.md");
    old.reject(new Error("old failure"));
    await pending;
    expect(useFilesStore.getState().viewer?.file?.content).toBe("new");
    expect(useFilesStore.getState().viewer?.error).toBeNull();
  });
});
