// Background tool install with streamed progress (no terminal). One install at a time per tool.
import { useCallback, useState } from "react";
import { ipc, type ToolStatus } from "@/lib/ipc";

export interface ToolInstallState {
  running: boolean;
  lines: string[];
  /** Result message once finished (version, or the failure reason). */
  message: string | null;
  ok: boolean | null;
}

const MAX_LINES = 40;

export function useToolInstalls(onFinished?: (name: string, status: ToolStatus) => void) {
  const [byName, setByName] = useState<Record<string, ToolInstallState>>({});
  const patch = (name: string, p: Partial<ToolInstallState>) =>
    setByName((m) => {
      const base: ToolInstallState = m[name] ?? { running: false, lines: [], message: null, ok: null };
      return { ...m, [name]: { ...base, ...p } };
    });

  const install = useCallback(
    async (name: string) => {
      patch(name, { running: true, lines: [], message: null, ok: null });
      try {
        const status = await ipc.tools.install(name, (e) => {
          if (e.type === "log") {
            setByName((m) => {
              const cur = m[name] ?? { running: true, lines: [], message: null, ok: null };
              return { ...m, [name]: { ...cur, lines: [...cur.lines, e.line].slice(-MAX_LINES) } };
            });
          } else {
            patch(name, { running: false, message: e.message, ok: e.ok });
          }
        });
        onFinished?.(name, status);
      } catch (e) {
        patch(name, { running: false, message: String(e), ok: false });
      }
    },
    [onFinished],
  );

  return { byName, install };
}
