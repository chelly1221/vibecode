// Git panel state for the active project.

import { create } from "zustand";
import { ipc, type GitBranch, type GitCommit, type GitStatus } from "@/lib/ipc";

export interface SelectedFile {
  path: string;
  staged: boolean;
}

interface GitState {
  projectId: string | null;
  status: GitStatus | null;
  branches: GitBranch[];
  log: GitCommit[];
  selected: SelectedFile | null;
  diff: string;
  diffLoading: boolean;
  loading: boolean;
  /** Name of the long-running action in flight (push/pull/fetch/commit/checkout). */
  busy: string | null;
  error: string | null;

  setProject: (id: string | null) => void;
  refresh: () => Promise<void>;
  loadLog: () => Promise<void>;
  selectFile: (file: SelectedFile | null) => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  commit: (message: string, stageAll: boolean) => Promise<string>;
  push: () => Promise<string>;
  pull: () => Promise<string>;
  fetch: () => Promise<string>;
  checkout: (branch: string, create: boolean) => Promise<void>;
}

export const useGitStore = create<GitState>((set, get) => {
  let projectVersion = 0;
  let refreshVersion = 0;
  let diffVersion = 0;
  let logVersion = 0;
  const requireProject = (): string => {
    const id = get().projectId;
    if (!id) throw new Error("선택된 프로젝트가 없습니다.");
    return id;
  };

  const withBusy = async <T,>(name: string, fn: (id: string) => Promise<T>): Promise<T> => {
    const id = requireProject();
    if (get().busy) throw new Error("진행 중인 저장 작업이 끝난 후 다시 시도해 주세요.");
    const version = projectVersion;
    set({ busy: name, error: null });
    try {
      const out = await fn(id);
      if (version === projectVersion) await get().refresh();
      return out;
    } catch (err) {
      if (version === projectVersion) set({ error: String(err) });
      throw err;
    } finally {
      if (version === projectVersion) set({ busy: null });
    }
  };

  return {
    projectId: null, status: null, branches: [], log: [], selected: null,
    diff: "", diffLoading: false, loading: false, busy: null, error: null,

    setProject: (id) => {
      if (id === get().projectId) return;
      projectVersion++;
      refreshVersion++;
      diffVersion++;
      logVersion++;
      set({ projectId: id, status: null, branches: [], log: [], selected: null, diff: "", error: null, busy: null, loading: false, diffLoading: false });
    },

    refresh: async () => {
      const id = get().projectId;
      if (!id) return;
      const version = ++refreshVersion;
      const current = () => version === refreshVersion;
      set({ loading: true });
      try {
        const status = await ipc.git.status(id);
        if (!current()) return;
        const branches = status.is_repo ? await ipc.git.branches(id) : [];
        if (!current()) return;
        set({ status, branches, error: null });
        const sel = get().selected;
        if (sel) {
          const stillThere = status.files.some((f) => f.path === sel.path && (sel.staged ? f.staged : f.unstaged || f.untracked));
          if (stillThere) await get().selectFile(sel);
          else await get().selectFile(null);
        }
      } catch (err) {
        if (current()) set({ error: String(err) });
      } finally {
        if (current()) set({ loading: false });
      }
    },

    loadLog: async () => {
      const id = get().projectId;
      if (!id) return;
      const version = ++logVersion;
      try {
        const log = await ipc.git.log(id, 50);
        if (version === logVersion) set({ log });
      } catch (err) {
        if (version === logVersion) set({ error: String(err) });
      }
    },

    selectFile: async (file) => {
      const id = get().projectId;
      const version = ++diffVersion;
      set({ selected: file, diff: "", diffLoading: !!file && !!id });
      if (!file || !id) return;
      try {
        const diff = await ipc.git.diff(id, file.path, file.staged);
        if (version === diffVersion) set({ diff });
      } catch (err) {
        if (version === diffVersion) set({ error: String(err) });
      } finally {
        if (version === diffVersion) set({ diffLoading: false });
      }
    },

    stage: (paths) => withBusy("stage", (id) => ipc.git.stage(id, paths)),
    unstage: (paths) => withBusy("unstage", (id) => ipc.git.unstage(id, paths)),
    commit: (message, stageAll) =>
      withBusy("commit", async (id) => {
        const version = projectVersion;
        if (stageAll) {
          const paths = get().status?.files.filter((f) => f.unstaged || f.untracked).map((f) => f.path) ?? [];
          if (paths.length) await ipc.git.stage(id, paths);
        }
        const out = await ipc.git.commit(id, message);
        if (version === projectVersion) void get().loadLog();
        return out;
      }),
    push: () => withBusy("push", (id) => ipc.git.push(id)),
    pull: () => withBusy("pull", (id) => ipc.git.pull(id)),
    fetch: () => withBusy("fetch", (id) => ipc.git.fetch(id)),
    checkout: (branch, create) => withBusy("checkout", (id) => ipc.git.checkout(id, branch, create)),
  };
});
