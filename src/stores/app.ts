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
  gitPanelOpen: true,
  terminalOpen: false,
  newSessionOpen: false,
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
  selectProject: (id) => set({ activeProjectId: id, activeSessionId: null }),
  selectSession: (id) => set({ activeSessionId: id }),
  setWizardOpen: (open) => set({ wizardOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setGitPanelOpen: (open) => set({ gitPanelOpen: open }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setNewSessionOpen: (open) => set({ newSessionOpen: open }),
  setFilesPanelOpen: (open) => set({ filesPanelOpen: open }),
}));
