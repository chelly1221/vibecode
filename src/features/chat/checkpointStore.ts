// UI state for checkpoint dialogs (restore confirmation, diff preview), shared by the
// transcript markers and the header popover. The dialogs themselves are mounted once in ChatView.

import { create } from "zustand";
import { toast } from "sonner";
import { ipc, type CheckpointRecord } from "@/lib/ipc";

interface Target {
  id: string;
  label: string;
}

interface CheckpointUiState {
  restoreTarget: Target | null;
  diffTarget: Target | null;
  diffText: string | null;
  diffLoading: boolean;
  restoring: boolean;
  /** Bumped after a restore/create so lists can refresh. */
  version: number;
  openRestore: (id: string, label: string) => void;
  openDiff: (id: string, label: string) => void;
  close: () => void;
  confirmRestore: () => Promise<CheckpointRecord | null>;
}

export const useCheckpointUi = create<CheckpointUiState>((set, get) => ({
  restoreTarget: null,
  diffTarget: null,
  diffText: null,
  diffLoading: false,
  restoring: false,
  version: 0,

  openRestore: (id, label) => set({ restoreTarget: { id, label } }),

  openDiff: (id, label) => {
    set({ diffTarget: { id, label }, diffText: null, diffLoading: true });
    ipc.checkpoints
      .diff(id)
      .then((text) => {
        if (get().diffTarget?.id === id) set({ diffText: text, diffLoading: false });
      })
      .catch((e) => {
        if (get().diffTarget?.id === id) set({ diffText: null, diffLoading: false });
        toast.error("변경 내용을 가져오지 못했습니다", { description: String(e) });
      });
  },

  close: () => set({ restoreTarget: null, diffTarget: null, diffText: null, diffLoading: false }),

  confirmRestore: async () => {
    const target = get().restoreTarget;
    if (!target) return null;
    set({ restoring: true });
    try {
      const safety = await ipc.checkpoints.restore(target.id);
      toast.success(`"${target.label}" 시점으로 되돌렸습니다`, { description: `되돌리기 전 상태는 "${safety.label}"로 저장되었습니다.` });
      set({ restoreTarget: null, version: get().version + 1 });
      return safety;
    } catch (e) {
      toast.error("되돌리기 실패", { description: String(e) });
      return null;
    } finally {
      set({ restoring: false });
    }
  },
}));
