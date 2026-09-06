// State for the project creation wizard (steps, form, scaffold progress).

import { create } from "zustand";
import {
  ipc,
  type AppSettings,
  type CreateProjectRequest,
  type ProjectPlan,
  type ProjectRecord,
  type ProjectType,
  type Provider,
  type ScaffoldEvent,
  type StackInfo,
  type StackRecommendation,
  type TargetOs,
  type ToolStatus,
} from "@/lib/ipc";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import { applyInstallEvent, type InstallItem } from "@/features/projects/install";
import { validateDirName, validateProjectName } from "@/features/projects/validation";

export const WIZARD_STEPS = ["이름 · 경로", "대상 OS", "유형", "스택", "옵션", "생성"] as const;
export type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;

/** quick = describe in one line, the agent picks everything; advanced = the six-step wizard. */
export type WizardMode = "quick" | "advanced";
export type QuickView = "describe" | "summary";
export type AutoStartStatus = "idle" | "starting" | "done" | "failed";

export interface WizardForm {
  name: string;
  /** ASCII folder/package name used by tools; auto-derived from `name` until edited. */
  dirName: string;
  dirNameEdited: boolean;
  parentDir: string;
  description: string;
  targetOs: TargetOs | null;
  projectType: ProjectType | null;
  /** null = no stack (empty project). Only meaningful when stackChosen. */
  stackId: string | null;
  stackChosen: boolean;
  gitInit: boolean;
  createGithub: boolean;
  githubPrivate: boolean;
  generateDocs: boolean;
  /** Install the stack's missing prerequisites automatically while creating. */
  installTools: boolean;
  provider: Provider | null;
  model: string | null;
  effort: Effort | null;
  permission: PermissionPreset | null;
}

export type ScaffoldStatus = "idle" | "running" | "done" | "failed";

export interface ScaffoldState {
  status: ScaffoldStatus;
  steps: { name: string; done: boolean }[];
  logs: { line: string; isErr: boolean }[];
  /** Automatic tool installs reported by the backend (progress bar in StepCreate). */
  installs: InstallItem[];
  installTotal: number;
  project: ProjectRecord | null;
  error: string | null;
}

interface WizardState {
  step: WizardStep;
  mode: WizardMode;
  quickView: QuickView;
  /** Result of the one-line plan (quick mode). */
  plan: ProjectPlan | null;
  planLoading: boolean;
  planError: string | null;
  /** First session auto-start after a quick-mode creation. */
  autoStart: AutoStartStatus;
  autoStartError: string | null;
  form: WizardForm;
  stacks: StackInfo[];
  stacksLoading: boolean;
  tools: ToolStatus[] | null;
  scaffold: ScaffoldState;
  /** "AI에게 물어보기" result for the current (targetOs, projectType, description). */
  aiRecs: StackRecommendation[] | null;
  aiLoading: boolean;

  reset: (settings: AppSettings | null) => void;
  setMode: (mode: WizardMode) => void;
  setQuickView: (view: QuickView) => void;
  /** Ask the agent for the whole configuration and copy it into the form. */
  runPlan: (provider: Provider) => Promise<ProjectPlan | null>;
  setAutoStart: (status: AutoStartStatus, error?: string | null) => void;
  setField: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
  goTo: (step: WizardStep) => void;
  next: () => void;
  prev: () => void;
  stepError: () => string | null;
  loadStacks: () => Promise<void>;
  loadTools: () => Promise<void>;
  askAi: (provider: Provider) => Promise<void>;
  buildRequest: () => CreateProjectRequest;
  runCreate: () => Promise<ProjectRecord | null>;
}

function initialForm(settings: AppSettings | null): WizardForm {
  return {
    name: "",
    dirName: "",
    dirNameEdited: false,
    parentDir: settings?.projects_root ?? "",
    description: "",
    targetOs: null,
    projectType: null,
    stackId: null,
    stackChosen: false,
    gitInit: false,
    createGithub: false,
    githubPrivate: true,
    generateDocs: true,
    installTools: true,
    provider: settings?.default_provider ?? "claude",
    model:
      settings?.default_provider === "codex"
        ? (settings?.default_model_codex ?? null)
        : (settings?.default_model_claude ?? null),
    effort: settings?.default_effort ?? "high",
    permission: settings?.default_permission ?? "full_auto",
  };
}

const initialScaffold: ScaffoldState = { status: "idle", steps: [], logs: [], installs: [], installTotal: 0, project: null, error: null };

export const useWizardStore = create<WizardState>((set, get) => ({
  step: 0,
  mode: "quick",
  quickView: "describe",
  plan: null,
  planLoading: false,
  planError: null,
  autoStart: "idle",
  autoStartError: null,
  form: initialForm(null),
  stacks: [],
  stacksLoading: false,
  tools: null,
  scaffold: initialScaffold,
  aiRecs: null,
  aiLoading: false,

  reset: (settings) =>
    set({
      step: 0,
      mode: "quick",
      quickView: "describe",
      plan: null,
      planLoading: false,
      planError: null,
      autoStart: "idle",
      autoStartError: null,
      form: initialForm(settings),
      stacks: [],
      scaffold: initialScaffold,
      aiRecs: null,
      aiLoading: false,
    }),

  setMode: (mode) => set({ mode, step: 0 }),
  setQuickView: (quickView) => set({ quickView }),

  runPlan: async (provider) => {
    const { form } = get();
    set({ planLoading: true, planError: null });
    try {
      const plan = await ipc.projects.aiPlan({ description: form.description.trim(), parent_dir: form.parentDir.trim(), provider });
      set((s) => ({
        plan,
        quickView: "summary",
        form: {
          ...s.form,
          name: plan.name,
          dirName: plan.dir_name,
          dirNameEdited: true,
          targetOs: plan.target_os,
          projectType: plan.project_type,
          stackId: plan.stack_id ?? null,
          stackChosen: true,
          gitInit: true,
          generateDocs: true,
        },
      }));
      return plan;
    } catch (e) {
      set({ planError: String(e) });
      return null;
    } finally {
      set({ planLoading: false });
    }
  },

  setAutoStart: (autoStart, error = null) => set({ autoStart, autoStartError: error }),

  setField: (key, value) => set((s) => ({ form: { ...s.form, [key]: value } })),

  goTo: (step) => set({ step }),

  next: () => {
    const { step, stepError } = get();
    if (stepError()) return;
    if (step < 5) set({ step: (step + 1) as WizardStep });
  },

  prev: () => {
    const { step } = get();
    if (step > 0) set({ step: (step - 1) as WizardStep });
  },

  stepError: () => {
    const { step, form } = get();
    switch (step) {
      case 0: {
        const nameErr = validateProjectName(form.name);
        if (nameErr) return nameErr;
        const dirErr = validateDirName(form.dirName);
        if (dirErr) return dirErr;
        if (!form.parentDir.trim()) return "프로젝트를 만들 상위 폴더를 선택하세요.";
        return null;
      }
      case 1:
        return form.targetOs ? null : "대상 OS를 선택하세요.";
      case 2:
        return form.projectType ? null : "프로젝트 유형을 선택하세요.";
      case 3:
        return form.stackChosen ? null : "스택을 선택하거나 '빈 프로젝트'를 고르세요.";
      default:
        return null;
    }
  },

  askAi: async (provider) => {
    const { form } = get();
    if (!form.targetOs || !form.projectType) return;
    set({ aiLoading: true });
    try {
      const recs = await ipc.projects.stacksAiRecommend({
        description: form.description.trim(),
        target_os: form.targetOs,
        project_type: form.projectType,
        provider,
      });
      set({ aiRecs: [...recs].sort((a, b) => b.score - a.score) });
    } finally {
      set({ aiLoading: false });
    }
  },

  loadStacks: async () => {
    const { form } = get();
    if (!form.targetOs || !form.projectType) return;
    set({ stacksLoading: true, aiRecs: null });
    try {
      const stacks = await ipc.projects.stacksRecommend(form.targetOs, form.projectType);
      set({ stacks });
    } finally {
      set({ stacksLoading: false });
    }
  },

  loadTools: async () => {
    if (get().tools) return;
    try {
      const tools = await ipc.tools.detect();
      set({ tools });
    } catch {
      set({ tools: [] });
    }
  },

  buildRequest: () => {
    const f = get().form;
    return {
      name: f.name.trim(),
      dir_name: f.dirName.trim() || null,
      parent_dir: f.parentDir.trim(),
      target_os: f.targetOs ?? "windows",
      project_type: f.projectType ?? "desktop_app",
      stack_id: f.stackId,
      description: f.description.trim(),
      git_init: f.gitInit,
      create_github_repo: f.gitInit && f.createGithub,
      github_private: f.githubPrivate,
      generate_agent_docs: f.generateDocs,
      install_missing_tools: f.installTools,
      default_provider: f.provider,
      default_model: f.model,
      default_effort: f.effort,
      default_permission: f.permission,
    };
  },

  runCreate: async () => {
    set({ step: 5, scaffold: { ...initialScaffold, status: "running" } });
    const onEvent = (e: ScaffoldEvent) => {
      set((s) => {
        const sc = s.scaffold;
        switch (e.type) {
          case "step":
            return {
              scaffold: {
                ...sc,
                steps: [...sc.steps.map((st) => ({ ...st, done: true })), { name: e.name, done: false }],
              },
            };
          case "log":
            return { scaffold: { ...sc, logs: [...sc.logs, { line: e.line, isErr: e.is_err }] } };
          case "install":
            return { scaffold: { ...sc, installs: applyInstallEvent(sc.installs, e), installTotal: e.total } };
          case "done":
            return {
              scaffold: {
                ...sc,
                status: "done",
                project: e.project,
                steps: sc.steps.map((st) => ({ ...st, done: true })),
              },
            };
          case "failed":
            return { scaffold: { ...sc, status: "failed", error: e.message } };
        }
      });
    };
    try {
      const project = await ipc.projects.create(get().buildRequest(), onEvent);
      set((s) => ({
        scaffold: {
          ...s.scaffold,
          status: "done",
          project,
          steps: s.scaffold.steps.map((st) => ({ ...st, done: true })),
        },
      }));
      return project;
    } catch (err) {
      set((s) => ({ scaffold: { ...s.scaffold, status: "failed", error: String(err) } }));
      return null;
    }
  },
}));
