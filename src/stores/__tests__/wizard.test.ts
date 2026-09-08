import { beforeEach, expect, it, vi } from "vitest";
import { ipc, type ProjectPlan, type ProjectRecord } from "@/lib/ipc";
import { useWizardStore } from "../wizard";
vi.mock("@/lib/ipc", () => ({ ipc: { projects: { aiPlan: vi.fn(), create: vi.fn() } } }));
beforeEach(() => {
  vi.resetAllMocks();
  useWizardStore.getState().reset(null);
});
it("discards an AI plan from a previously closed creation form", async () => {
  let resolve!: (plan: ProjectPlan) => void;
  vi.mocked(ipc.projects.aiPlan).mockReturnValue(new Promise((yes) => { resolve = yes; }));
  useWizardStore.getState().setField("description", "old request");
  const pending = useWizardStore.getState().runPlan("claude");
  useWizardStore.getState().reset(null);
  useWizardStore.getState().setField("description", "new request");
  resolve({ name: "old", dir_name: "old" } as ProjectPlan);
  await pending;
  expect(useWizardStore.getState().form.description).toBe("new request");
  expect(useWizardStore.getState().plan).toBeNull();
  expect(useWizardStore.getState().quickView).toBe("describe");
});
it("invalidates the chosen stack after changing the target", () => {
  useWizardStore.getState().setField("stackId", "vite-react");
  useWizardStore.getState().setField("stackChosen", true);
  useWizardStore.getState().setField("targetOs", "android");
  expect(useWizardStore.getState().form.stackChosen).toBe(false);
  expect(useWizardStore.getState().form.stackId).toBeNull();
});
it("validates the entire form before creating files", async () => {
  useWizardStore.getState().goTo(4);
  await useWizardStore.getState().runCreate();
  expect(ipc.projects.create).not.toHaveBeenCalled();
  expect(useWizardStore.getState().scaffold.error).toBeTruthy();
});
it("does not reset or duplicate an active creation", async () => {
  let resolve!: (project: ProjectRecord) => void;
  vi.mocked(ipc.projects.create).mockReturnValue(new Promise((yes) => { resolve = yes; }));
  const store = useWizardStore.getState();
  store.setField("name", "Test"); store.setField("dirName", "test"); store.setField("parentDir", "C:\\code");
  store.setField("targetOs", "web"); store.setField("projectType", "web_app"); store.setField("stackChosen", true);
  const pending = store.runCreate();
  store.reset(null);
  await store.runCreate();
  expect(ipc.projects.create).toHaveBeenCalledTimes(1);
  expect(useWizardStore.getState().form.name).toBe("Test");
  resolve({ id: "created" } as ProjectRecord);
  await pending;
  expect(useWizardStore.getState().scaffold.status).toBe("done");
});
