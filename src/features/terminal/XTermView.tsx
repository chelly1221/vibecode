import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { ipc } from "@/lib/ipc";
import { useTerminalStore, type TerminalTab } from "@/stores/terminal";

const DARK = { background: "#100b0e", foreground: "#eee7eb", cursor: "#f9a8d4", selectionBackground: "#54223e" };

interface Props {
  tab: TerminalTab;
  active: boolean;
}

/** One xterm.js instance bound to one pty. Kept mounted (hidden) while inactive. */
export function XTermView({ tab, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Create terminal + pty once per tab.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "Cascadia Code, Consolas, 'D2Coding', 'Noto Sans Mono CJK KR', monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: DARK,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => openUrl(uri).catch(() => window.open(uri, "_blank"))));
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const safeFit = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          /* ignore fit errors while hidden */
        }
      }
    };
    safeFit();

    const onData = term.onData((data) => {
      const id = ptyIdRef.current;
      if (id) ipc.pty.write(id, data).catch(() => {});
    });

    (async () => {
      try {
        const ptyId = await ipc.pty.open(
          { program: tab.program, args: tab.args, cwd: tab.cwd, cols: term.cols, rows: term.rows },
          (ev) => {
            if (disposed) return;
            if (ev.type === "data") term.write(ev.data);
            else {
              const code = ev.code ?? null;
              term.write(`\r\n\x1b[2m[프로세스 종료${code === null ? "" : ` code ${code}`}]\x1b[0m\r\n`);
              useTerminalStore.getState().setExited(tab.id, code);
              ptyIdRef.current = null;
            }
          },
          tab.projectId,
        );
        if (disposed) {
          ipc.pty.close(ptyId).catch(() => {});
          return;
        }
        ptyIdRef.current = ptyId;
        useTerminalStore.getState().setPtyId(tab.id, ptyId);
        // Sync size in case the terminal was fitted after open.
        ipc.pty.resize(ptyId, term.cols, term.rows).catch(() => {});
      } catch (e) {
        term.write(`\r\n\x1b[31m[터미널을 열 수 없습니다] ${String(e)}\x1b[0m\r\n`);
        useTerminalStore.getState().setExited(tab.id, null);
      }
    })();

    const ro = new ResizeObserver(() => {
      safeFit();
      const id = ptyIdRef.current;
      if (id) ipc.pty.resize(id, term.cols, term.rows).catch(() => {});
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      onData.dispose();
      const id = ptyIdRef.current;
      if (id) ipc.pty.close(id).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The tab's command never changes after creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Re-fit + focus when the tab becomes visible.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    const t = window.setTimeout(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
        const id = ptyIdRef.current;
        if (id) ipc.pty.resize(id, term.cols, term.rows).catch(() => {});
      }
      term.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [active]);

  return <div ref={hostRef} className="h-full w-full" style={{ display: active ? "block" : "none" }} />;
}
