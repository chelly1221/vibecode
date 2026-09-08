// Runtime session state for the chat UI: a pure event reducer (`applyEvent`),
// a loader for persisted transcripts (`fromMessages`) and a zustand store that
// drives the Tauri session commands. Components toast errors; this module throws.

import { create } from "zustand";
import {
  ipc,
  type AgentQuestion,
  type MessageRecord,
  type PermissionReply,
  type QuestionAnswer,
  type SessionConfig,
  type SessionConfigPatch,
  type SessionEvent,
  type SessionRecord,
} from "@/lib/ipc";
import { notify, windowUnfocused } from "@/lib/notify";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionDecision } from "@/lib/bindings/PermissionDecision";
import type { PermissionKind } from "@/lib/bindings/PermissionKind";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import type { PlanStep } from "@/lib/bindings/PlanStep";
import type { Usage } from "@/lib/bindings/Usage";
import { useAppStore } from "@/stores/app";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnMeta {
  cost_usd: number | null;
  duration_ms: number;
  stop_reason: string | null;
  usage: Usage;
}

export type ChatItem =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string; streaming: boolean }
  | { type: "thinking"; id: string; text: string }
  | {
      type: "tool";
      id: string;
      toolId: string;
      name: string;
      input: unknown;
      output?: string;
      is_error?: boolean;
      done: boolean;
    }
  | {
      type: "permission";
      id: string;
      request_id: string;
      kind: PermissionKind;
      title: string;
      detail: unknown;
      decision?: PermissionDecision;
    }
  | { type: "plan"; id: string; steps: PlanStep[] }
  | {
      type: "question";
      id: string;
      request_id: string;
      questions: AgentQuestion[];
      answered: boolean;
      answers?: QuestionAnswer[];
    }
  | { type: "checkpoint"; id: string; checkpoint_id: string; label: string }
  | { type: "system"; id: string; text: string; variant: "info" | "error" | "turn_end" | "exited"; meta?: TurnMeta };

/** Item inside a subagent transcript (a reduced ChatItem). */
export type SubItem =
  | { type: "text"; id: string; text: string; streaming: boolean; role: "assistant" | "user" }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; toolId: string; name: string; input: unknown; output?: string; is_error?: boolean; done: boolean }
  | { type: "status"; id: string; text: string };

/** Live transcript of one subagent, keyed by the tool call (Agent/Task) that spawned it. */
export interface SubagentState {
  parentToolId: string;
  /** Tool id of the subagent that contains the parent tool call, or null at the top level. */
  parentSubagentId: string | null;
  name: string;
  items: SubItem[];
  running: boolean;
  startedAt: number;
  /** Short description of the latest activity, for list views. */
  lastActivity: string;
  itemCounter: number;
}

export interface QuestionRequest {
  request_id: string;
  questions: AgentQuestion[];
}

export interface PermissionRequest {
  request_id: string;
  kind: PermissionKind;
  title: string;
  detail: unknown;
}

export interface SessionState {
  record: SessionRecord;
  /** Provider process/thread is attached to this UI. */
  live: boolean;
  /** A turn is in progress. */
  running: boolean;
  /** `startSession` is in flight for this id (resume). */
  starting: boolean;
  model: string | null;
  /** Model reported by the provider in `init` (may differ from the alias the user picked). */
  resolvedModel: string | null;
  effort: Effort | null;
  permission: PermissionPreset;
  items: ChatItem[];
  pendingPermissions: PermissionRequest[];
  pendingQuestions: QuestionRequest[];
  /** Subagent transcripts keyed by the spawning tool id. */
  subagents: Record<string, SubagentState>;
  usage: Usage;
  cost: number;
  lastError: string | null;
  statusMessage: string | null;
  historyLoaded: boolean;
  /** "그만 보기" was pressed on the long-session banner for this session. */
  longWarningDismissed: boolean;
  /** Counter for live item ids (`e<n>`); persisted items use `h<seq>`. */
  nextId: number;
}

export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
  };
}

export function createSessionState(record: SessionRecord): SessionState {
  return {
    record,
    live: false,
    running: false,
    starting: false,
    model: record.model ?? null,
    resolvedModel: null,
    effort: record.effort ?? null,
    permission: record.permission,
    items: [],
    pendingPermissions: [],
    pendingQuestions: [],
    subagents: {},
    usage: emptyUsage(),
    cost: record.total_cost_usd ?? 0,
    lastError: null,
    statusMessage: null,
    historyLoaded: false,
    longWarningDismissed: false,
    nextId: 1,
  };
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

function finalizeStreaming(items: ChatItem[]): void {
  const last = items[items.length - 1];
  if (last && last.type === "assistant" && last.streaming) {
    items[items.length - 1] = { ...last, streaming: false };
  }
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Name for a subagent from the spawning tool's input (Agent tool: description/prompt). */
function subagentName(input: unknown, fallback: string): string {
  const r = rec(input);
  for (const k of ["description", "name", "subagent_type", "prompt"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return fallback;
}

function findTool(items: ChatItem[], toolId: string): Extract<ChatItem, { type: "tool" }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "tool" && it.toolId === toolId) return it;
  }
  return undefined;
}

function findSubTool(items: SubItem[], toolId: string): Extract<SubItem, { type: "tool" }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "tool" && it.toolId === toolId) return it;
  }
  return undefined;
}

function finalizeSubStreaming(items: SubItem[]): void {
  const last = items[items.length - 1];
  if (last && last.type === "text" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
}

function activityOf(it: SubItem): string {
  switch (it.type) {
    case "text":
      return it.text.trim().split("\n").pop()?.slice(0, 120) ?? "";
    case "thinking":
      return "생각 중…";
    case "tool":
      return `${it.name}${it.done ? " 완료" : " 실행 중"}`;
    case "status":
      return it.text;
  }
}

/** Unwrap nested `subagent` wrappers: returns the innermost parent id, the ancestor wrapper ids and the inner event. */
function unwrapSubagent(ev: Extract<SessionEvent, { type: "subagent" }>): { parentId: string; wrappers: string[]; inner: SessionEvent } {
  const wrappers: string[] = [];
  let cur: SessionEvent = ev;
  let parentId = ev.parent_tool_use_id;
  while (cur.type === "subagent") {
    wrappers.push(cur.parent_tool_use_id);
    parentId = cur.parent_tool_use_id;
    cur = cur.event;
  }
  wrappers.pop();
  return { parentId, wrappers, inner: cur };
}

/** Reduce one inner event into a subagent transcript. Returns the updated subagent (new object). */
export function applySubagentEvent(sub: SubagentState, inner: SessionEvent): SubagentState {
  const items = sub.items.slice();
  let counter = sub.itemCounter;
  const mk = () => `${sub.parentToolId}:${counter++}`;
  let running = sub.running;
  switch (inner.type) {
    case "user_message": {
      finalizeSubStreaming(items);
      items.push({ type: "text", id: mk(), text: inner.text, streaming: false, role: "user" });
      break;
    }
    case "text_delta": {
      const last = items[items.length - 1];
      if (last && last.type === "text" && last.streaming) items[items.length - 1] = { ...last, text: last.text + inner.text };
      else items.push({ type: "text", id: mk(), text: inner.text, streaming: true, role: "assistant" });
      break;
    }
    case "text": {
      const last = items[items.length - 1];
      if (last && last.type === "text" && last.streaming) items[items.length - 1] = { ...last, text: inner.text || last.text, streaming: false };
      else if (inner.text) items.push({ type: "text", id: mk(), text: inner.text, streaming: false, role: "assistant" });
      break;
    }
    case "thinking": {
      const last = items[items.length - 1];
      if (last && last.type === "thinking") items[items.length - 1] = { ...last, text: last.text + inner.text };
      else {
        finalizeSubStreaming(items);
        items.push({ type: "thinking", id: mk(), text: inner.text });
      }
      break;
    }
    case "tool_start": {
      finalizeSubStreaming(items);
      items.push({ type: "tool", id: mk(), toolId: inner.id, name: inner.name, input: inner.input, done: false });
      break;
    }
    case "tool_end": {
      const idx = items.findIndex((it) => it.type === "tool" && it.toolId === inner.id);
      if (idx >= 0) {
        const it = items[idx] as Extract<SubItem, { type: "tool" }>;
        items[idx] = { ...it, output: inner.output, is_error: inner.is_error, done: true };
      } else {
        items.push({ type: "tool", id: mk(), toolId: inner.id, name: "tool", input: null, output: inner.output, is_error: inner.is_error, done: true });
      }
      break;
    }
    case "status": {
      items.push({ type: "status", id: mk(), text: inner.message });
      break;
    }
    case "error": {
      items.push({ type: "status", id: mk(), text: `오류: ${inner.message}` });
      break;
    }
    case "turn_end":
    case "exited": {
      finalizeSubStreaming(items);
      running = false;
      break;
    }
    default:
      break;
  }
  const last = items[items.length - 1];
  return { ...sub, items, itemCounter: counter, running, lastActivity: last ? activityOf(last) : sub.lastActivity };
}

/** Mark every running subagent finished (and close its streaming text). */
function stopSubagents(subagents: Record<string, SubagentState>): Record<string, SubagentState> | undefined {
  if (!Object.values(subagents).some((sub) => sub.running)) return undefined;
  const stopped: Record<string, SubagentState> = {};
  for (const [k, sub] of Object.entries(subagents)) {
    if (!sub.running) {
      stopped[k] = sub;
      continue;
    }
    const items = sub.items.slice();
    finalizeSubStreaming(items);
    stopped[k] = { ...sub, items, running: false };
  }
  return stopped;
}

export function applyEvent(state: SessionState, ev: SessionEvent): SessionState {
  const items = state.items.slice();
  let nextId = state.nextId;
  const mk = () => `e${nextId++}`;
  const patch: Partial<SessionState> = {};

  switch (ev.type) {
    case "init": {
      patch.live = true;
      patch.resolvedModel = ev.model || null;
      patch.record = { ...state.record, external_ref: ev.external_ref || state.record.external_ref };
      patch.lastError = null;
      items.push({ type: "system", id: mk(), variant: "info", text: `세션 연결됨 · ${ev.model}` });
      break;
    }
    case "user_message": {
      finalizeStreaming(items);
      items.push({ type: "user", id: mk(), text: ev.text });
      patch.running = true;
      patch.lastError = null;
      patch.statusMessage = null;
      break;
    }
    case "text_delta": {
      const last = items[items.length - 1];
      if (last && last.type === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        items.push({ type: "assistant", id: mk(), text: ev.text, streaming: true });
      }
      patch.running = true;
      break;
    }
    case "text": {
      const last = items[items.length - 1];
      if (last && last.type === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: ev.text || last.text, streaming: false };
      } else if (ev.text) {
        items.push({ type: "assistant", id: mk(), text: ev.text, streaming: false });
      }
      break;
    }
    case "thinking": {
      const last = items[items.length - 1];
      if (last && last.type === "thinking") {
        items[items.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        finalizeStreaming(items);
        items.push({ type: "thinking", id: mk(), text: ev.text });
      }
      patch.running = true;
      break;
    }
    case "tool_start": {
      finalizeStreaming(items);
      items.push({ type: "tool", id: mk(), toolId: ev.id, name: ev.name, input: ev.input, done: false });
      patch.running = true;
      break;
    }
    case "tool_end": {
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.type === "tool" && it.toolId === ev.id) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        const it = items[idx] as Extract<ChatItem, { type: "tool" }>;
        items[idx] = { ...it, output: ev.output, is_error: ev.is_error, done: true };
      } else {
        items.push({ type: "tool", id: mk(), toolId: ev.id, name: "tool", input: null, output: ev.output, is_error: ev.is_error, done: true });
      }
      const sub = state.subagents[ev.id];
      if (sub && sub.running) {
        const subItems = sub.items.slice();
        finalizeSubStreaming(subItems);
        patch.subagents = { ...state.subagents, [ev.id]: { ...sub, items: subItems, running: false } };
      }
      break;
    }
    case "permission_request": {
      finalizeStreaming(items);
      items.push({ type: "permission", id: mk(), request_id: ev.request_id, kind: ev.kind, title: ev.title, detail: ev.detail });
      patch.pendingPermissions = [
        ...state.pendingPermissions.filter((p) => p.request_id !== ev.request_id),
        { request_id: ev.request_id, kind: ev.kind, title: ev.title, detail: ev.detail },
      ];
      break;
    }
    case "permission_resolved": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.type === "permission" && it.request_id === ev.request_id) {
          items[i] = { ...it, decision: ev.decision };
          break;
        }
      }
      patch.pendingPermissions = state.pendingPermissions.filter((p) => p.request_id !== ev.request_id);
      break;
    }
    case "question": {
      finalizeStreaming(items);
      items.push({ type: "question", id: mk(), request_id: ev.request_id, questions: ev.questions, answered: false });
      patch.pendingQuestions = [...state.pendingQuestions.filter((q) => q.request_id !== ev.request_id), { request_id: ev.request_id, questions: ev.questions }];
      break;
    }
    case "question_resolved": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.type === "question" && it.request_id === ev.request_id) {
          items[i] = { ...it, answered: true };
          break;
        }
      }
      patch.pendingQuestions = state.pendingQuestions.filter((q) => q.request_id !== ev.request_id);
      break;
    }
    case "checkpoint": {
      finalizeStreaming(items);
      items.push({ type: "checkpoint", id: mk(), checkpoint_id: ev.checkpoint_id, label: ev.label });
      break;
    }
    case "subagent": {
      const { parentId, wrappers, inner } = unwrapSubagent(ev);
      const subagents = { ...(patch.subagents ?? state.subagents) };
      let sub = subagents[parentId];
      if (!sub) {
        // Locate the spawning tool call: top level or inside another subagent.
        let parentSubagentId: string | null = wrappers.length ? wrappers[wrappers.length - 1] : null;
        let input: unknown = null;
        const top = findTool(items, parentId);
        if (top) input = top.input;
        else {
          for (const other of Object.values(subagents)) {
            const t = findSubTool(other.items, parentId);
            if (t) {
              input = t.input;
              parentSubagentId = other.parentToolId;
              break;
            }
          }
        }
        sub = {
          parentToolId: parentId,
          parentSubagentId,
          name: subagentName(input, "서브에이전트"),
          items: [],
          running: true,
          startedAt: Date.now(),
          lastActivity: "",
          itemCounter: 1,
        };
      }
      subagents[parentId] = applySubagentEvent(sub, inner);
      patch.subagents = subagents;
      patch.running = true;
      break;
    }
    case "plan": {
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].type === "plan") {
          idx = i;
          break;
        }
      }
      // Replace the latest plan only if nothing but tools/thinking came after it.
      if (idx >= 0 && items.slice(idx + 1).every((it) => it.type !== "user" && it.type !== "system")) {
        items[idx] = { type: "plan", id: items[idx].id, steps: ev.steps };
      } else {
        items.push({ type: "plan", id: mk(), steps: ev.steps });
      }
      break;
    }
    case "status": {
      patch.statusMessage = ev.message;
      break;
    }
    case "turn_end": {
      finalizeStreaming(items);
      const meta: TurnMeta = {
        cost_usd: ev.cost_usd ?? null,
        duration_ms: ev.duration_ms,
        stop_reason: ev.stop_reason ?? null,
        usage: ev.usage,
      };
      items.push({ type: "system", id: mk(), variant: "turn_end", text: "완료", meta });
      patch.running = false;
      {
        const stopped = stopSubagents(state.subagents);
        if (stopped) patch.subagents = stopped;
      }
      patch.statusMessage = null;
      patch.usage = addUsage(state.usage, ev.usage);
      patch.cost = state.cost + (ev.cost_usd ?? 0);
      break;
    }
    case "error": {
      finalizeStreaming(items);
      items.push({ type: "system", id: mk(), variant: "error", text: ev.message });
      patch.lastError = ev.message;
      if (ev.fatal) {
        patch.running = false;
        patch.statusMessage = null;
      }
      break;
    }
    case "exited": {
      finalizeStreaming(items);
      const code = ev.code ?? null;
      items.push({
        type: "system",
        id: mk(),
        variant: "exited",
        text: code === null || code === 0 ? "세션 종료" : `세션 종료 (코드 ${code})`,
      });
      patch.live = false;
      patch.running = false;
      patch.starting = false;
      patch.statusMessage = null;
      patch.pendingPermissions = [];
      patch.pendingQuestions = [];
      {
        const stopped = stopSubagents(state.subagents);
        if (stopped) patch.subagents = stopped;
      }
      break;
    }
  }

  return { ...state, ...patch, items, nextId };
}

// ---------------------------------------------------------------------------
// Persisted transcript loader
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v == null ? fallback : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

function usageOf(v: unknown): Usage {
  const r = asRecord(v);
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  return {
    input_tokens: n("input_tokens"),
    output_tokens: n("output_tokens"),
    cache_read_tokens: n("cache_read_tokens"),
    cache_write_tokens: n("cache_write_tokens"),
  };
}

const PERMISSION_KINDS: PermissionKind[] = ["command", "file_edit", "tool", "other"];
const DECISIONS: PermissionDecision[] = ["allow", "allow_session", "deny"];

/**
 * Rebuild chat items from the messages table. Payload contract (written by the
 * Rust SessionManager):
 *   user       {text}
 *   assistant  {text}
 *   tool       {id, name, input, output, is_error}
 *   permission {request_id, kind, title, detail, decision}
 *   system     {subtype: "turn_end", cost_usd, usage, duration_ms, stop_reason}
 *              | {subtype: "error", message} | {subtype: "init", model, external_ref}
 */
/** Persisted subagent transcript entries: `{kind:"text",text}` / `{kind:"tool",name,input,output,is_error}` / `{kind:"thinking",text}`. */
function subagentFromPayload(parentToolId: string, parentInput: unknown, raw: unknown): SubagentState | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: SubItem[] = [];
  let n = 1;
  for (const entry of raw) {
    const e = asRecord(entry);
    const id = `${parentToolId}:${n++}`;
    const kind = str(e.kind);
    if (kind === "text") items.push({ type: "text", id, text: str(e.text), streaming: false, role: e.role === "user" ? "user" : "assistant" });
    else if (kind === "thinking") items.push({ type: "thinking", id, text: str(e.text) });
    else if (kind === "status") items.push({ type: "status", id, text: str(e.text) });
    else if (kind === "tool") {
      const hasOutput = e.output !== undefined && e.output !== null;
      items.push({
        type: "tool",
        id,
        toolId: str(e.id, id),
        name: str(e.name, "tool"),
        input: e.input ?? null,
        output: hasOutput ? str(e.output) : undefined,
        is_error: typeof e.is_error === "boolean" ? e.is_error : undefined,
        done: true,
      });
    }
  }
  const last = items[items.length - 1];
  return {
    parentToolId,
    parentSubagentId: null,
    name: subagentName(parentInput, "서브에이전트"),
    items,
    running: false,
    startedAt: 0,
    lastActivity: last ? activityOf(last) : "",
    itemCounter: n,
  };
}

function questionsOf(v: unknown): AgentQuestion[] {
  if (!Array.isArray(v)) return [];
  return v.map((q, i) => {
    const r = asRecord(q);
    const options = Array.isArray(r.options)
      ? r.options.map((o) => {
          const orr = asRecord(o);
          return { label: str(orr.label), description: typeof orr.description === "string" ? orr.description : null };
        })
      : [];
    return {
      id: str(r.id, String(i)),
      header: str(r.header),
      question: str(r.question),
      options,
      multi_select: r.multi_select === true,
      allow_free_text: r.allow_free_text !== false,
    };
  });
}

function answersOf(v: unknown): QuestionAnswer[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((a) => {
    const r = asRecord(a);
    return { question_id: str(r.question_id), answers: Array.isArray(r.answers) ? r.answers.map((x) => str(x)) : [] };
  });
}

export function fromMessages(records: MessageRecord[]): {
  items: ChatItem[];
  usage: Usage;
  cost: number;
  externalRef: string | null;
  subagents: Record<string, SubagentState>;
} {
  const items: ChatItem[] = [];
  const subagents: Record<string, SubagentState> = {};
  let usage = emptyUsage();
  let cost = 0;
  let externalRef: string | null = null;

  for (const rec of records) {
    const p = asRecord(rec.payload);
    const id = `h${rec.seq}`;
    switch (rec.kind) {
      case "user":
        items.push({ type: "user", id, text: str(p.text) });
        break;
      case "assistant":
        items.push({ type: "assistant", id, text: str(p.text), streaming: false });
        break;
      case "tool": {
        const hasOutput = p.output !== undefined && p.output !== null;
        const toolId = str(p.id, id);
        items.push({
          type: "tool",
          id,
          toolId,
          name: str(p.name, "tool"),
          input: p.input ?? null,
          output: hasOutput ? str(p.output) : undefined,
          is_error: typeof p.is_error === "boolean" ? p.is_error : undefined,
          done: hasOutput,
        });
        const sub = subagentFromPayload(toolId, p.input, p.subagent);
        if (sub) subagents[toolId] = sub;
        break;
      }
      case "permission": {
        const kind = PERMISSION_KINDS.includes(p.kind as PermissionKind) ? (p.kind as PermissionKind) : "other";
        const decision = DECISIONS.includes(p.decision as PermissionDecision) ? (p.decision as PermissionDecision) : undefined;
        items.push({ type: "permission", id, request_id: str(p.request_id, id), kind, title: str(p.title, "권한 요청"), detail: p.detail ?? null, decision });
        break;
      }
      case "system": {
        const subtype = str(p.subtype);
        if (subtype === "turn_end") {
          const u = usageOf(p.usage);
          const c = typeof p.cost_usd === "number" ? p.cost_usd : null;
          usage = addUsage(usage, u);
          cost += c ?? 0;
          items.push({
            type: "system",
            id,
            variant: "turn_end",
            text: "완료",
            meta: { cost_usd: c, duration_ms: typeof p.duration_ms === "number" ? p.duration_ms : 0, stop_reason: typeof p.stop_reason === "string" ? p.stop_reason : null, usage: u },
          });
        } else if (subtype === "error") {
          items.push({ type: "system", id, variant: "error", text: str(p.message, "오류") });
        } else if (subtype === "init") {
          if (typeof p.external_ref === "string" && p.external_ref) externalRef = p.external_ref;
          items.push({ type: "system", id, variant: "info", text: `세션 시작 · ${str(p.model, "?")}` });
        } else if (subtype === "exited") {
          items.push({ type: "system", id, variant: "exited", text: "세션 종료" });
        } else if (subtype === "checkpoint") {
          items.push({ type: "checkpoint", id, checkpoint_id: str(p.checkpoint_id), label: str(p.label, "체크포인트") });
        } else if (subtype === "question") {
          items.push({ type: "question", id, request_id: str(p.request_id, id), questions: questionsOf(p.questions), answered: true, answers: answersOf(p.answers) });
        } else {
          items.push({ type: "system", id, variant: "info", text: str(p.message ?? p.text ?? subtype) });
        }
        break;
      }
    }
  }
  // Nested transcripts: a subagent whose spawning tool lives inside another subagent.
  for (const sub of Object.values(subagents)) {
    for (const other of Object.values(subagents)) {
      if (other !== sub && findSubTool(other.items, sub.parentToolId)) {
        sub.parentSubagentId = other.parentToolId;
        break;
      }
    }
  }
  return { items, usage, cost, externalRef, subagents };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SessionsStore {
  sessions: Record<string, SessionState>;
  /** Make sure a state entry exists for a persisted record. */
  ensure: (record: SessionRecord) => void;
  dispatch: (id: string, ev: SessionEvent) => void;
  /** Start (or resume) a provider session; returns the persisted record. */
  startSession: (config: SessionConfig, opts?: { fromSessionId?: string }) => Promise<SessionRecord>;
  /** Re-attach a non-live session using its external ref. */
  resume: (id: string) => Promise<SessionRecord>;
  loadHistory: (record: SessionRecord) => Promise<void>;
  send: (id: string, text: string) => Promise<void>;
  interrupt: (id: string) => Promise<void>;
  permissionReply: (id: string, reply: PermissionReply) => Promise<void>;
  /** Answer a pending agent question. */
  answerQuestion: (id: string, requestId: string, answers: QuestionAnswer[]) => Promise<void>;
  updateConfig: (id: string, patch: SessionConfigPatch) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  remove: (id: string) => void;
  dismissLongWarning: (id: string) => void;
}

function configForResume(st: SessionState): SessionConfig {
  return {
    project_id: st.record.project_id,
    provider: st.record.provider,
    model: st.model,
    effort: st.effort,
    permission: st.permission,
    append_system_prompt: null,
    resume_ref: st.record.external_ref ?? null,
    fork: false,
  };
}

const resuming = new Map<string, Promise<SessionRecord>>();

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: {},

  ensure: (record) => {
    if (get().sessions[record.id]) return;
    set((s) => ({ sessions: { ...s.sessions, [record.id]: createSessionState(record) } }));
  },

  dispatch: (id, ev) => {
    const cur = get().sessions[id];
    if (!cur) return;
    set((s) => ({ sessions: { ...s.sessions, [id]: applyEvent(cur, ev) } }));
    if (ev.type === "turn_end" || ev.type === "exited" || ev.type === "init") {
      useAppStore
        .getState()
        .loadSessions(cur.record.project_id)
        .catch(() => {});
    }
    maybeNotify(cur, ev);
  },

  startSession: async (config, opts) => {
    let id: string | null = null;
    const queue: SessionEvent[] = [];
    const onEvent = (ev: SessionEvent) => {
      if (id) get().dispatch(id, ev);
      else queue.push(ev);
    };
    const from = opts?.fromSessionId;
    if (from && get().sessions[from]) {
      set((s) => ({ sessions: { ...s.sessions, [from]: { ...s.sessions[from], starting: true, lastError: null } } }));
    }
    let record: SessionRecord;
    try {
      record = await ipc.sessions.start(config, onEvent);
    } catch (e) {
      if (from && get().sessions[from]) {
        set((s) => ({ sessions: { ...s.sessions, [from]: { ...s.sessions[from], starting: false } } }));
      }
      throw e;
    }
    set((s) => {
      const existing = s.sessions[record.id];
      const source = from ? s.sessions[from] : undefined;
      let st = existing ?? createSessionState(record);
      if (!existing && source) {
        // The provider handed us a new id for a resumed conversation: carry the transcript over.
        st = { ...st, items: source.items, subagents: source.subagents, usage: source.usage, cost: source.cost, nextId: source.nextId, historyLoaded: true };
      }
      st = {
        ...st,
        record: { ...record, external_ref: record.external_ref ?? st.record.external_ref ?? null },
        live: true,
        starting: false,
        model: config.model ?? null,
        effort: config.effort ?? null,
        permission: config.permission,
        lastError: null,
      };
      const sessions = { ...s.sessions, [record.id]: st };
      if (from && from !== record.id) delete sessions[from];
      return { sessions };
    });
    id = record.id;
    for (const ev of queue) get().dispatch(id, ev);
    const app = useAppStore.getState();
    if (from && from !== record.id && app.activeSessionId === from) app.selectSession(record.id);
    app.loadSessions(config.project_id).catch(() => {});
    return record;
  },

  resume: async (id) => {
    const st = get().sessions[id];
    if (!st) throw new Error("세션 정보를 찾을 수 없습니다");
    if (st.live) return st.record;
    const pending = resuming.get(id);
    if (pending) return pending;
    const request = get().startSession(configForResume(st), { fromSessionId: id });
    resuming.set(id, request);
    try { return await request; }
    finally { if (resuming.get(id) === request) resuming.delete(id); }
  },

  loadHistory: async (record) => {
    get().ensure(record);
    const st = get().sessions[record.id];
    if (!st || st.historyLoaded || st.live) return;
    const msgs = await ipc.sessions.messages(record.id);
    const { items, usage, cost, externalRef, subagents } = fromMessages(msgs);
    set((s) => {
      const cur = s.sessions[record.id];
      if (!cur || cur.live || cur.historyLoaded) return {};
      return {
        sessions: {
          ...s.sessions,
          [record.id]: {
            ...cur,
            record: { ...cur.record, external_ref: cur.record.external_ref ?? externalRef },
            items,
            subagents,
            usage,
            cost: cost || cur.cost,
            historyLoaded: true,
          },
        },
      };
    });
  },

  send: async (id, text) => {
    const st = get().sessions[id];
    if (!st) throw new Error("세션 정보를 찾을 수 없습니다");
    if (st.live) {
      await ipc.sessions.send(id, text);
      return;
    }
    const rec = await get().resume(id);
    await ipc.sessions.send(rec.id, text);
  },

  interrupt: async (id) => {
    await ipc.sessions.interrupt(id);
  },

  permissionReply: async (id, reply) => {
    await ipc.sessions.permissionReply(id, reply);
    // Optimistic: the provider will also emit permission_resolved.
    get().dispatch(id, { type: "permission_resolved", request_id: reply.request_id, decision: reply.decision });
  },

  answerQuestion: async (id, requestId, answers) => {
    await ipc.sessions.answerQuestion(id, requestId, answers);
    set((s) => {
      const cur = s.sessions[id];
      if (!cur) return {};
      const items = cur.items.map((it) => (it.type === "question" && it.request_id === requestId ? { ...it, answered: true, answers } : it));
      return { sessions: { ...s.sessions, [id]: { ...cur, items, pendingQuestions: cur.pendingQuestions.filter((q) => q.request_id !== requestId) } } };
    });
  },

  updateConfig: async (id, patch) => {
    const st = get().sessions[id];
    if (!st) throw new Error("세션 정보를 찾을 수 없습니다");
    if (st.live) await ipc.sessions.updateConfig(id, patch);
    set((s) => {
      const cur = s.sessions[id];
      if (!cur) return {};
      return {
        sessions: {
          ...s.sessions,
          [id]: {
            ...cur,
            model: patch.model !== undefined ? patch.model : cur.model,
            effort: patch.effort !== undefined ? patch.effort : cur.effort,
            permission: patch.permission != null ? patch.permission : cur.permission,
          },
        },
      };
    });
  },

  closeSession: async (id) => {
    await ipc.sessions.close(id);
    set((s) => {
      const cur = s.sessions[id];
      if (!cur) return {};
      return { sessions: { ...s.sessions, [id]: { ...cur, live: false, running: false, starting: false, pendingPermissions: [], pendingQuestions: [] } } };
    });
  },

  dismissLongWarning: (id) =>
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id], longWarningDismissed: true } } } : {})),
  remove: (id) => {
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions };
    });
  },
}));

/** Fire a desktop notification for events that need attention while the window is unfocused. */
function maybeNotify(st: SessionState, ev: SessionEvent): void {
  if (ev.type !== "turn_end" && ev.type !== "permission_request" && ev.type !== "question") return;
  if (!windowUnfocused()) return;
  if (useAppStore.getState().settings?.notifications_enabled === false) return;
  const title = st.record.title || "Vibecoder";
  const body =
    ev.type === "turn_end"
      ? "작업이 끝났습니다"
      : ev.type === "permission_request"
        ? `${ev.kind === "command" ? "명령 실행" : ev.kind === "file_edit" ? "파일 수정" : "도구 사용"} 승인이 필요합니다: ${ev.title}`.slice(0, 200)
        : "질문에 답해 주세요";
  void notify(title, body);
}

/** Subagents still working in a session. */
export function runningSubagents(subagents: Record<string, SubagentState>): number {
  let n = 0;
  for (const sub of Object.values(subagents)) if (sub.running) n++;
  return n;
}

/** Depth of a subagent in the nesting tree (0 = spawned from the main conversation). */
export function subagentDepth(subagents: Record<string, SubagentState>, id: string): number {
  let depth = 0;
  let cur = subagents[id];
  const seen = new Set<string>();
  while (cur && cur.parentSubagentId && !seen.has(cur.parentSubagentId)) {
    seen.add(cur.parentSubagentId);
    depth++;
    cur = subagents[cur.parentSubagentId];
  }
  return depth;
}

/** Show the "start a new conversation" hint once a session holds this many user questions. */
export const LONG_SESSION_QUESTIONS = 20;

/** Number of user messages (questions) in a session. */
export function questionCount(items: ChatItem[]): number {
  let n = 0;
  for (const it of items) if (it.type === "user") n++;
  return n;
}
