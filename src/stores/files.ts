// File explorer state: lazily loaded directory tree per project + the open viewer file.
import { create } from "zustand";
import { ipc, type FsEntry, type FsFile } from "@/lib/ipc";

export interface DirNode {
  entries: FsEntry[];
  loading: boolean;
  error: string | null;
}

interface FilesState {
  projectId: string | null;
  /** relPath ("" = root) → loaded listing */
  dirs: Record<string, DirNode>;
  expanded: Record<string, boolean>;
  filter: string;
  viewer: { relPath: string; file: FsFile | null; loading: boolean; error: string | null } | null;

  setProject: (projectId: string | null) => void;
  loadDir: (relPath: string, force?: boolean) => Promise<void>;
  toggleDir: (relPath: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  setFilter: (q: string) => void;
  openFile: (relPath: string) => Promise<void>;
  closeViewer: () => void;
}

export const useFilesStore = create<FilesState>((set, get) => {
  let version = 0;
  let viewerRequest = 0;
  const dirRequests = new Map<string, number>();
  return {
    projectId: null,
    dirs: {},
    expanded: { "": true },
    filter: "",
    viewer: null,

    setProject: (projectId) => {
      if (get().projectId === projectId) return;
      version++;
      viewerRequest++;
      dirRequests.clear();
      set({ projectId, dirs: {}, expanded: { "": true }, filter: "", viewer: null });
      if (projectId) get().loadDir("").catch(() => {});
    },

    loadDir: async (relPath, force = false) => {
      const { projectId, dirs } = get();
      if (!projectId) return;
      const existing = dirs[relPath];
      const projectVersion = version;
      if (existing && !force && (existing.loading || existing.entries.length > 0 || existing.error === null)) {
        return;
      }
      const request = (dirRequests.get(relPath) ?? 0) + 1;
      dirRequests.set(relPath, request);
      const current = () => version === projectVersion && dirRequests.get(relPath) === request;
      set((s) => ({ dirs: { ...s.dirs, [relPath]: { entries: existing?.entries ?? [], loading: true, error: null } } }));
      try {
        const entries = await ipc.fs.list(projectId, relPath);
        if (!current()) return;
        set((s) => ({ dirs: { ...s.dirs, [relPath]: { entries, loading: false, error: null } } }));
      } catch (e) {
        if (!current()) return;
        set((s) => ({ dirs: { ...s.dirs, [relPath]: { entries: existing?.entries ?? [], loading: false, error: String(e) } } }));
      }
    },

    toggleDir: async (relPath) => {
      const open = !get().expanded[relPath];
      set((s) => ({ expanded: { ...s.expanded, [relPath]: open } }));
      if (open && !get().dirs[relPath]) await get().loadDir(relPath);
    },

    refreshAll: async () => {
      const { expanded, dirs, loadDir } = get();
      const targets = Object.keys(dirs).filter((p) => p === "" || expanded[p]);
      await Promise.all(targets.map((p) => loadDir(p, true)));
    },

    setFilter: (q) => set({ filter: q }),

    openFile: async (relPath) => {
      const { projectId } = get();
      if (!projectId) return;
      const request = ++viewerRequest;
      set({ viewer: { relPath, file: null, loading: true, error: null } });
      try {
        const file = await ipc.fs.read(projectId, relPath);
        set((s) => (request === viewerRequest && s.projectId === projectId && s.viewer?.relPath === relPath ? { viewer: { relPath, file, loading: false, error: null } } : {}));
      } catch (e) {
        set((s) => (request === viewerRequest && s.projectId === projectId && s.viewer?.relPath === relPath ? { viewer: { relPath, file: null, loading: false, error: String(e) } } : {}));
      }
    },

    closeViewer: () => { viewerRequest++; set({ viewer: null }); },
  };
});
