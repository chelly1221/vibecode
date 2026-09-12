// "새 빌드 적용": build state lives here (not in the dialog) so the dialog can be closed while the
// release build runs; when it succeeds a short countdown hands over to the swap script and the app
// restarts on the new exe.

import { create } from "zustand";
import { ipc, type ExportEvent, type SelfBuildInfo } from "@/lib/ipc";

export type BuildPhase = "idle" | "building" | "built" | "applying" | "failed";

/** Seconds between a successful build and the automatic restart. */
export const APPLY_COUNTDOWN_SECS = 5;
const LOG_LIMIT = 500;

interface SelfBuildStore {
  info: SelfBuildInfo | null;
  phase: BuildPhase;
  step: string | null;
  log: Array<{ line: string; err: boolean }>;
  builtExe: string | null;
  error: string | null;
  /** Seconds left before the automatic apply; null = no countdown running. */
  countdown: number | null;
  loadInfo: () => Promise<SelfBuildInfo>;
  /** Build in the background; on success starts the countdown to `apply`. */
  build: (repo: string) => Promise<void>;
  /** Hand over to the swap script and quit (build after exit when nothing was built yet). */
  apply: () => Promise<void>;
  cancelCountdown: () => void;
  reset: () => void;
}

let timer: number | null = null;

export const useSelfBuildStore = create<SelfBuildStore>((set, get) => ({
  info: null,
  phase: "idle",
  step: null,
  log: [],
  builtExe: null,
  error: null,
  countdown: null,

  loadInfo: async () => {
    const info = await ipc.selfBuild.info();
    set({ info });
    return info;
  },

  build: async (repo) => {
    if (get().phase === "building" || get().phase === "applying") return;
    set({ phase: "building", step: "빌드 준비", log: [], builtExe: null, error: null, countdown: null });
    try {
      const built = await ipc.selfBuild.run(repo, (e: ExportEvent) => {
        switch (e.type) {
          case "step":
            set({ step: e.name });
            break;
          case "log":
            set((s) => {
              const next = s.log.concat({ line: e.line, err: e.is_err });
              return { log: next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next };
            });
            break;
          case "failed":
            set({ error: e.message });
            break;
          default:
            break;
        }
      });
      set({ phase: "built", builtExe: built, countdown: APPLY_COUNTDOWN_SECS });
      timer = window.setInterval(() => {
        const left = get().countdown;
        if (left === null) return;
        if (left <= 1) {
          get().cancelCountdown();
          void get().apply();
        } else {
          set({ countdown: left - 1 });
        }
      }, 1000);
    } catch (e) {
      set((s) => ({ phase: "failed", error: s.error ?? String(e) }));
    }
  },

  apply: async () => {
    const { info, builtExe, phase } = get();
    if (!info?.repo || phase === "applying") return;
    get().cancelCountdown();
    set({ phase: "applying", error: null });
    try {
      await ipc.selfBuild.apply(info.repo, info.in_place ? null : builtExe);
    } catch (e) {
      set({ phase: builtExe ? "built" : "failed", error: String(e) });
    }
  },

  cancelCountdown: () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    set({ countdown: null });
  },

  reset: () => {
    get().cancelCountdown();
    set({ phase: "idle", step: null, log: [], builtExe: null, error: null });
  },
}));
