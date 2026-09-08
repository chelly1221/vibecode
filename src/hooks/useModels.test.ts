import { beforeEach, expect, it, vi } from "vitest";
import type { ModelInfo } from "@/lib/ipc";
const { listModels } = vi.hoisted(() => ({ listModels: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { tools: { listModels } } }));
beforeEach(() => { listModels.mockReset(); vi.resetModules(); });
const model = (id: string): ModelInfo => ({ id, label: id, provider: "codex", is_default: true, efforts: [] });
it("keeps model availability separate for each native account", async () => {
  const { fetchModels } = await import("./useModels");
  listModels.mockImplementation((_provider, id) => Promise.resolve([model(id)]));
  expect(await fetchModels("codex", false, "alice")).toEqual([model("alice")]);
  expect(await fetchModels("codex", false, "bob")).toEqual([model("bob")]);
  expect(await fetchModels("codex", false, "alice")).toEqual([model("alice")]);
  expect(listModels).toHaveBeenCalledTimes(2);
});
it("does not let an older request overwrite refreshed account models", async () => {
  const { fetchModels } = await import("./useModels");
  let resolveOld!: (v: ModelInfo[]) => void;
  listModels.mockImplementationOnce(() => new Promise<ModelInfo[]>((r) => { resolveOld = r; })).mockResolvedValueOnce([model("new")]);
  const old = fetchModels("codex", false, "alice");
  await fetchModels("codex", true, "alice");
  resolveOld([model("old")]); await old;
  expect(await fetchModels("codex", false, "alice")).toEqual([model("new")]);
});
