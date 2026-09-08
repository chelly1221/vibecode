// Terminal tabs. Each tab carries the command spec; the XTerm view opens the pty when
// it mounts (it needs the fitted cols/rows) and records the ptyId here.
import { create } from "zustand";
import { useAppStore } from "@/stores/app";
import type { TerminalCommand } from "@/features/terminal/commands";

export interface TerminalTab {
  id: string;
  title: string;
  program: string | null;
  args: string[];
  cwd: string | null;
  ptyId: string | null;
  projectId: string | null;
  exitCode: number | null | undefined; // undefined = running
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  addTab: (cmd: TerminalCommand, cwd?: string | null) => string;
  removeTab: (id: string) => void;
  setActive: (id: string) => void;
  setPtyId: (id: string, ptyId: string | null) => void;
  setExited: (id: string, code: number | null) => void;
}

let counter = 0;
function nextId() {
  counter += 1;
  return `term-${Date.now().toString(36)}-${counter}`;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  tabs: [],
  activeTabId: null,
  addTab: (cmd, cwd) => {
    const id = nextId();
    const tab: TerminalTab = {
      id,
      title: cmd.title,
      program: cmd.program,
      args: cmd.args,
      cwd: cwd ?? null,
      ptyId: null,
      projectId: useAppStore.getState().activeProjectId,
      exitCode: undefined,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },
  removeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId = s.activeTabId === id ? (tabs.at(-1)?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    }),
  setActive: (id) => set({ activeTabId: id }),
  setPtyId: (id, ptyId) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ptyId } : t)) })),
  setExited: (id, code) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, exitCode: code } : t)) })),
}));

/** Active project directory (Windows path) if a project is selected. */
export function activeProjectDir(): string | null {
  const { projects, activeProjectId } = useAppStore.getState();
  return projects.find((p) => p.id === activeProjectId)?.path ?? null;
}

/**
 * Open the terminal panel with a new tab running `cmd`. Used by onboarding and settings
 * to trigger installs and logins. Returns the tab id.
 */
export function openTerminalWith(cmd: TerminalCommand, cwd?: string | null): string {
  const id = useTerminalStore.getState().addTab(cmd, cwd === undefined ? activeProjectDir() : cwd);
  useAppStore.getState().setTerminalOpen(true);
  return id;
}
