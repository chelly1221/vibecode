import { beforeEach, expect, it, vi } from "vitest";
import { ipc, type PreviewEvent } from "@/lib/ipc";
import { usePreviewStore } from "../preview";

vi.mock("@/lib/ipc", () => ({ ipc: { preview: {
  close: vi.fn(), serverStatus: vi.fn(), serverStart: vi.fn(), serverStop: vi.fn(), open: vi.fn(), eval: vi.fn(),
} } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/stores/app", () => ({ useAppStore: { getState: () => ({ insertIntoComposer: vi.fn() }) } }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.preview.close).mockResolvedValue(undefined);
  vi.mocked(ipc.preview.serverStatus).mockResolvedValue({ running: false, url: null, command: null });
  usePreviewStore.getState().setProject(null);
});
it("clears the previous project's URL and command", async () => {
  usePreviewStore.getState().setProject("A");
  usePreviewStore.setState({ command: "run-a", url: "http://localhost:1111", manualUrl: "http://localhost:1111", running: true });
  await usePreviewStore.getState().syncStatus("B");
  expect(usePreviewStore.getState()).toMatchObject({ projectId: "B", command: "", url: null, manualUrl: "", running: false });
});
it("recovers when a server cannot start", async () => {
  usePreviewStore.getState().setProject("A");
  usePreviewStore.getState().setCommand("npm run dev");
  vi.mocked(ipc.preview.serverStart).mockRejectedValue(new Error("missing program"));
  await expect(usePreviewStore.getState().start("A")).rejects.toThrow("missing program");
  expect(usePreviewStore.getState()).toMatchObject({ running: false, starting: false });
});
it("ignores output belonging to a different project", async () => {
  let emit!: (event: PreviewEvent) => void;
  vi.mocked(ipc.preview.serverStart).mockImplementation(async (_id, _command, callback) => { emit = callback; });
  usePreviewStore.getState().setProject("A");
  usePreviewStore.getState().setCommand("npm run dev");
  await usePreviewStore.getState().start("A");
  usePreviewStore.getState().setProject("B");
  emit({ type: "url", url: "http://localhost:1111" });
  expect(usePreviewStore.getState().url).toBeNull();
});
it("requires a command before starting a process", async () => {
  usePreviewStore.getState().setProject("A");
  await expect(usePreviewStore.getState().start("A")).rejects.toThrow();
  expect(ipc.preview.serverStart).not.toHaveBeenCalled();
});
