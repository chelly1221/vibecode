// Global app state: settings, projects, selection and panel visibility.
// Chat/session runtime state lives in src/stores/sessions.ts (owned by features/chat).

import { create } from "zustand";
import { ipc, type AppSettings, type ProjectRecord, type SessionRecord } from "@/lib/ipc";

interface AppState {
  settings: AppSettings | null;
  projects: ProjectRecord[];
  sessionsByProject: Record<string, SessionRecord[]>;
  activeProjectId: string | null;
  activeSessionId: string | null;

  // panels / dialogs
  wizardOpen: boolean;
  settingsOpen: boolean;
  gitPanelOpen: boolean;
  terminalOpen: boolean;
  newSessionOpen: boolean;
  previewOpen: boolean;
  /** Text the chat composer should append (set by the preview element picker). */
  composerInsert: { text: string; nonce: number } | null;
  filesPanelOpen: boolean;

  loadSettings: () => Promise<AppSettings>;
  saveSettings: (s: AppSettings) => Promise<void>;
  loadProjects: () => Promise<void>;
  loadSessions: (projectId: string) => Promise<void>;
  selectProject: (id: string | null) => void;
  selectSession: (id: string | null) => void;
  setWizardOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setGitPanelOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  setNewSessionOpen: (open: boolean) => void;
  setPreviewOpen: (open: boolean) => void;
  insertIntoComposer: (text: string) => void;
  setFilesPanelOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  projects: [],
  sessionsByProject: {},
  activeProjectId: null,
  activeSessionId: null,
  wizardOpen: false,
  settingsOpen: false,
  gitPanelOpen: false,
  terminalOpen: false,
  newSessionOpen: false,
  previewOpen: false,
  composerInsert: null,
  filesPanelOpen: false,

  loadSettings: async () => {
    const settings = await ipc.settings.get();
    set({ settings });
    return settings;
  },
  saveSettings: async (s) => {
    const settings = await ipc.settings.set(s);
    set({ settings });
  },
  loadProjects: async () => {
    const projects = await ipc.projects.list();
    set({ projects });
    const { activeProjectId } = get();
    if (activeProjectId && !projects.some((p) => p.id === activeProjectId)) {
      set({ activeProjectId: null, activeSessionId: null });
    }
  },
  loadSessions: async (projectId) => {
    const sessions = await ipc.sessions.list(projectId);
    set((s) => ({ sessionsByProject: { ...s.sessionsByProject, [projectId]: sessions } }));
  },
  selectProject: (id) => {
    if (get().activeProjectId === id) return;
    set({ activeProjectId: id, activeSessionId: null, composerInsert: null, newSessionOpen: false });
    // Keep the two agent instruction files identical whenever a project comes into focus.
    if (id) ipc.projects.syncAgentDocs(id).catch(() => {});
  },
  selectSession: (id) => set({ activeSessionId: id }),
  setWizardOpen: (open) => set({ wizardOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setGitPanelOpen: (open) => set({ gitPanelOpen: open, ...(open ? { filesPanelOpen: false, previewOpen: false } : {}) }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setNewSessionOpen: (open) => set({ newSessionOpen: open }),
  setPreviewOpen: (open) => set({ previewOpen: open, ...(open ? { gitPanelOpen: false, filesPanelOpen: false } : {}) }),
  insertIntoComposer: (text) => set({ composerInsert: { text, nonce: Date.now() } }),
  setFilesPanelOpen: (open) => set({ filesPanelOpen: open, ...(open ? { gitPanelOpen: false, previewOpen: false } : {}) }),
}));
