import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type ProjectRecord, type SessionRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { useSessionsStore } from "@/stores/sessions";
import { startQuickSession } from "../quickSession";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    accounts: { project: vi.fn() },
    sessions: { start: vi.fn(), send: vi.fn() },
    projects: { syncAgentDocs: vi.fn().mockResolvedValue([]) },
    settings: { get: vi.fn() },
    usage: { latest: vi.fn(), history: vi.fn(), refresh: vi.fn() },
  },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(), windowUnfocused: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), success: vi.fn() } }));

const project: ProjectRecord = {
  id: "p1", name: "앱", path: "C:\\code\\app", target_os: "windows", project_type: "desktop_app", stack_id: "tauri-react", github_url: null,
  default_provider: "codex", default_model: "gpt-5.3-codex", default_effort: "xhigh", default_permission: "auto_edit", auto_git: null,
  created_at: "2026-09-04T00:00:00Z", last_opened_at: "2026-09-04T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(ipc.sessions.start).mockReset();
  vi.mocked(ipc.accounts.project).mockReset();
  useAppStore.setState({ projects: [project], activeProjectId: "p1", activeSessionId: null, accountsDialogProjectId: null, settings: { default_provider: "claude", default_permission: "full_auto", default_effort: "high" } as never });
  useSessionsStore.setState({ sessions: {} });
});

describe("startQuickSession", () => {
  it("starts with the project's defaults and selects the session", async () => {
    vi.mocked(ipc.accounts.project).mockResolvedValue({ claude: null, codex: "acc-codex", github: null, git_user_name: null, git_user_email: null });
    const record = { id: "s1", project_id: "p1", provider: "codex", external_ref: null, title: "새 세션", model: "gpt-5.3-codex", effort: "xhigh", permission: "auto_edit", total_cost_usd: 0, archived: false, created_at: "", last_used_at: "" } as SessionRecord;
    vi.mocked(ipc.sessions.start).mockResolvedValue(record);
    const out = await startQuickSession("p1");
    expect(out?.id).toBe("s1");
    const config = vi.mocked(ipc.sessions.start).mock.calls[0][0];
    expect(config).toMatchObject({ project_id: "p1", provider: "codex", model: "gpt-5.3-codex", effort: "xhigh", permission: "auto_edit", resume_ref: null, fork: false });
    expect(useAppStore.getState().activeSessionId).toBe("s1");
  });

  it("opens the account picker instead of starting when the provider has no account", async () => {
    vi.mocked(ipc.accounts.project).mockResolvedValue({ claude: "acc-claude", codex: null, github: null, git_user_name: null, git_user_email: null });
    const out = await startQuickSession("p1");
    expect(out).toBeNull();
    expect(ipc.sessions.start).not.toHaveBeenCalled();
    expect(useAppStore.getState().accountsDialogProjectId).toBe("p1");
  });

  it("shares one start between concurrent clicks", async () => {
    vi.mocked(ipc.accounts.project).mockResolvedValue({ claude: null, codex: "acc-codex", github: null, git_user_name: null, git_user_email: null });
    let resolve!: (r: SessionRecord) => void;
    vi.mocked(ipc.sessions.start).mockReturnValue(new Promise((yes) => { resolve = yes; }));
    const a = startQuickSession("p1");
    const b = startQuickSession("p1");
    expect(a).toBe(b);
    resolve({ id: "s2", project_id: "p1", provider: "codex", external_ref: null, title: "새 세션", model: null, effort: null, permission: "auto_edit", total_cost_usd: 0, archived: false, created_at: "", last_used_at: "" } as SessionRecord);
    await Promise.all([a, b]);
    expect(ipc.sessions.start).toHaveBeenCalledTimes(1);
  });
});
