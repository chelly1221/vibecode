// Runtime session state for the chat UI: a pure event reducer (`applyEvent`),
// a loader for persisted transcripts (`fromMessages`) and a zustand store that
// drives the Tauri session commands. Components toast errors; this module throws.

import { create } from "zustand";
import { ipc, type MessageRecord, type PermissionReply, type SessionConfig, type SessionConfigPatch, type SessionEvent, type SessionRecord } from "@/lib/ipc";
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
  | { type: "system"; id: string; text: string; variant: "info" | "error" | "turn_end" | "exited"; meta?: TurnMeta };

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
export function fromMessages(records: MessageRecord[]): { items: ChatItem[]; usage: Usage; cost: number; externalRef: string | null } {
  const items: ChatItem[] = [];
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
        items.push({
          type: "tool",
          id,
          toolId: str(p.id, id),
          name: str(p.name, "tool"),
          input: p.input ?? null,
          output: hasOutput ? str(p.output) : undefined,
          is_error: typeof p.is_error === "boolean" ? p.is_error : undefined,
          done: hasOutput,
        });
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
        } else {
          items.push({ type: "system", id, variant: "info", text: str(p.message ?? p.text ?? subtype) });
        }
        break;
      }
    }
  }
  return { items, usage, cost, externalRef };
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
        st = { ...st, items: source.items, usage: source.usage, cost: source.cost, nextId: source.nextId, historyLoaded: true };
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
    return get().startSession(configForResume(st), { fromSessionId: id });
  },

  loadHistory: async (record) => {
    get().ensure(record);
    const st = get().sessions[record.id];
    if (!st || st.historyLoaded || st.live) return;
    const msgs = await ipc.sessions.messages(record.id);
    const { items, usage, cost, externalRef } = fromMessages(msgs);
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
    const rec = await get().startSession(configForResume(st), { fromSessionId: id });
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
      return { sessions: { ...s.sessions, [id]: { ...cur, live: false, running: false, starting: false, pendingPermissions: [] } } };
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

/** Show the "start a new conversation" hint once a session holds this many user questions. */
export const LONG_SESSION_QUESTIONS = 20;

/** Number of user messages (questions) in a session. */
export function questionCount(items: ChatItem[]): number {
  let n = 0;
  for (const it of items) if (it.type === "user") n++;
  return n;
}
