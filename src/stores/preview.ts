// UI preview state: dev-server process, detected URL, child-webview picker/console reports.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc, type PreviewEvent } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";

export type DevicePreset = "desktop" | "tablet" | "mobile";
export const DEVICE_SIZES: Record<DevicePreset, { width: number | null; height: number | null; label: string }> = {
  desktop: { width: null, height: null, label: "데스크톱" },
  tablet: { width: 820, height: 1180, label: "태블릿" },
  mobile: { width: 390, height: 844, label: "모바일" },
};

export interface PickedElement {
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  attrs: Record<string, string>;
  selector: string;
  rect: { x: number; y: number; w: number; h: number };
  react: { components: string[]; source: string | null } | null;
  url: string;
}

export interface ConsoleEntry {
  level: string;
  message: string;
  url: string;
  ts: number;
}

interface PreviewState {
  projectId: string | null;
  command: string;
  running: boolean;
  url: string | null;
  manualUrl: string;
  logs: string[];
  picking: boolean;
  device: DevicePreset;
  console: ConsoleEntry[];
  webviewOpen: boolean;
  lastPick: PickedElement | null;
  listenerReady: boolean;

  setCommand: (c: string) => void;
  setManualUrl: (u: string) => void;
  setDevice: (d: DevicePreset) => void;
  start: (projectId: string) => Promise<void>;
  stop: () => Promise<void>;
  openUrl: (url: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
  closeWebview: () => Promise<void>;
  togglePicking: () => Promise<void>;
  clearConsole: () => void;
  ensureListener: () => Promise<void>;
  syncStatus: (projectId: string) => Promise<void>;
}

/** Turn a picked element into a sentence the agent can act on. */
export function describePick(p: PickedElement): string {
  const comp = p.react?.components?.[0];
  const where = p.react?.source ? ` (${p.react.source})` : "";
  const label = p.text ? ` 텍스트 "${p.text.slice(0, 40)}"` : "";
  const cls = p.classes.length ? ` .${p.classes.slice(0, 3).join(".")}` : "";
  return `[미리보기에서 선택한 요소] <${p.tag}${p.id ? "#" + p.id : ""}${cls}>${label}${comp ? ` · React 컴포넌트 ${comp}${where}` : ""} · 위치 ${p.selector} · 페이지 ${p.url}\n이 요소를 다음과 같이 바꿔줘: `;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  projectId: null,
  command: "",
  running: false,
  url: null,
  manualUrl: "",
  logs: [],
  picking: false,
  device: "desktop",
  console: [],
  webviewOpen: false,
  lastPick: null,
  listenerReady: false,

  setCommand: (command) => set({ command }),
  setManualUrl: (manualUrl) => set({ manualUrl }),
  setDevice: (device) => set({ device }),

  ensureListener: async () => {
    if (get().listenerReady) return;
    set({ listenerReady: true });
    try {
      await listen<{ kind: string; payload: unknown }>("preview:report", (ev) => {
        const { kind, payload } = ev.payload;
        if (kind === "pick") {
          const p = payload as PickedElement;
          set({ lastPick: p, picking: false });
          useAppStore.getState().insertIntoComposer(describePick(p));
        } else if (kind === "picking") {
          set({ picking: !!(payload as { on: boolean }).on });
        } else if (kind === "console") {
          const e = payload as ConsoleEntry;
          set((s) => ({ console: [...s.console.slice(-199), e] }));
        }
      });
    } catch (e) {
      console.error("preview listener", e);
      set({ listenerReady: false });
    }
  },

  syncStatus: async (projectId) => {
    try {
      const st = await ipc.preview.serverStatus(projectId);
      set({ projectId, running: st.running, url: st.url ?? get().url, command: st.command ?? get().command });
    } catch {
      /* ignore */
    }
  },

  start: async (projectId) => {
    const command = get().command.trim();
    set({ projectId, running: true, url: null, logs: [], console: [] });
    await ipc.preview.serverStart(projectId, command, (e: PreviewEvent) => {
      if (e.type === "log") set((s) => ({ logs: [...s.logs.slice(-499), (e.is_err ? "! " : "") + e.line] }));
      else if (e.type === "url") set({ url: e.url });
      else if (e.type === "started") set((s) => ({ logs: [...s.logs, `$ ${e.command}`] }));
      else if (e.type === "exited") set((s) => ({ running: false, logs: [...s.logs, `[종료 code ${e.code ?? "?"}]`] }));
    });
  },

  stop: async () => {
    const pid = get().projectId;
    if (pid) await ipc.preview.serverStop(pid);
    set({ running: false });
  },

  openUrl: async (url, bounds) => {
    await ipc.preview.open(url, bounds);
    set({ webviewOpen: true, url });
  },

  closeWebview: async () => {
    await ipc.preview.close().catch(() => {});
    set({ webviewOpen: false, picking: false });
  },

  togglePicking: async () => {
    const on = !get().picking;
    set({ picking: on });
    await ipc.preview.eval(`window.__vibecoderPreview && window.__vibecoderPreview.setPicking(${on ? "true" : "false"})`);
  },

  clearConsole: () => set({ console: [] }),
}));
