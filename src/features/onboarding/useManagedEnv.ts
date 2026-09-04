// Status of the app-owned WSL distribution plus tool/login detection inside it.
import { useCallback, useEffect, useState } from "react";
import { ipc, type BackendConfig, type ToolStatus, type WslStatus } from "@/lib/ipc";
import { toolFound } from "./recommend";

export const MANAGED_DISTRO = "Vibecoder";
export const MANAGED_BACKEND: BackendConfig = { kind: "wsl", wsl_distro: MANAGED_DISTRO };

export function isManagedBackend(b: BackendConfig | null | undefined): boolean {
  return !!b && b.kind === "wsl" && b.wsl_distro === MANAGED_DISTRO;
}

export function useManagedEnv(auto = true) {
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const st = await ipc.env.wslStatus();
      setStatus(st);
      if (st.managed_ready) {
        const t = await ipc.tools.detect(MANAGED_BACKEND).catch(() => [] as ToolStatus[]);
        setTools(t);
        if (toolFound(t, "claude")) {
          const a = await ipc.tools.authStatus("claude", MANAGED_BACKEND).catch(() => null);
          setLoggedIn(a ? a.logged_in : null);
        } else {
          setLoggedIn(null);
        }
      } else {
        setTools(null);
        setLoggedIn(null);
      }
      return st;
    } catch (e) {
      console.error("wsl status", e);
      setStatus(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auto) refresh().catch(() => {});
  }, [auto, refresh]);

  return { status, tools, loggedIn, loading, refresh };
}
