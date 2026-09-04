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
  const requireProject = (): string => {
    const id = get().projectId;
    if (!id) throw new Error("선택된 프로젝트가 없습니다.");
    return id;
  };

  const withBusy = async <T,>(name: string, fn: (id: string) => Promise<T>): Promise<T> => {
    const id = requireProject();
    set({ busy: name, error: null });
    try {
      const out = await fn(id);
      await get().refresh();
      return out;
    } catch (err) {
      set({ error: String(err) });
      throw err;
    } finally {
      set({ busy: null });
    }
  };

  return {
    projectId: null,
    status: null,
    branches: [],
    log: [],
    selected: null,
    diff: "",
    diffLoading: false,
    loading: false,
    busy: null,
    error: null,

    setProject: (id) => {
      if (id === get().projectId) return;
      set({ projectId: id, status: null, branches: [], log: [], selected: null, diff: "", error: null });
    },

    refresh: async () => {
      const id = get().projectId;
      if (!id) return;
      set({ loading: true });
      try {
        const status = await ipc.git.status(id);
        // Guard against a project switch while the request was in flight.
        if (get().projectId !== id) return;
        let branches: GitBranch[] = [];
        if (status.is_repo) {
          branches = await ipc.git.branches(id).catch(() => []);
        }
        set({ status, branches, error: null });
        // Re-fetch the diff of the selected file so it tracks the working tree.
        const sel = get().selected;
        if (sel) {
          const stillThere = status.files.some((f) => f.path === sel.path && (sel.staged ? f.staged : f.unstaged || f.untracked));
          if (stillThere) {
            const diff = await ipc.git.diff(id, sel.path, sel.staged).catch(() => "");
            if (get().projectId === id) set({ diff });
          } else {
            set({ selected: null, diff: "" });
          }
        }
      } catch (err) {
        if (get().projectId === id) set({ error: String(err) });
      } finally {
        if (get().projectId === id) set({ loading: false });
      }
    },

    loadLog: async () => {
      const id = get().projectId;
      if (!id) return;
      try {
        const log = await ipc.git.log(id, 50);
        if (get().projectId === id) set({ log });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    selectFile: async (file) => {
      const id = get().projectId;
      set({ selected: file, diff: "" });
      if (!file || !id) return;
      set({ diffLoading: true });
      try {
        const diff = await ipc.git.diff(id, file.path, file.staged);
        if (get().selected?.path === file.path) set({ diff });
      } catch (err) {
        set({ error: String(err) });
      } finally {
        set({ diffLoading: false });
      }
    },

    stage: (paths) => withBusy("stage", (id) => ipc.git.stage(id, paths)),
    unstage: (paths) => withBusy("unstage", (id) => ipc.git.unstage(id, paths)),

    commit: (message, stageAll) =>
      withBusy("commit", async (id) => {
        if (stageAll) {
          const st = get().status;
          const paths = st?.files.filter((f) => f.unstaged || f.untracked).map((f) => f.path) ?? [];
          if (paths.length) await ipc.git.stage(id, paths);
        }
        const out = await ipc.git.commit(id, message);
        void get().loadLog();
        return out;
      }),

    push: () => withBusy("push", (id) => ipc.git.push(id)),
    pull: () => withBusy("pull", (id) => ipc.git.pull(id)),
    fetch: () => withBusy("fetch", (id) => ipc.git.fetch(id)),
    checkout: (branch, create) => withBusy("checkout", (id) => ipc.git.checkout(id, branch, create)),
  };
});
