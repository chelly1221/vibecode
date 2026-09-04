import { describe, expect, it } from "vitest";
import type { MessageRecord, SessionEvent, SessionRecord } from "@/lib/ipc";
import { applyEvent, createSessionState, fromMessages, type SessionState } from "@/stores/sessions";

const record: SessionRecord = {
  id: "s1",
  project_id: "p1",
  provider: "claude",
  external_ref: null,
  title: "test",
  model: "opus",
  effort: "high",
  permission: "auto_edit",
  total_cost_usd: 0,
  archived: false,
  created_at: "2026-09-04T00:00:00Z",
  last_used_at: "2026-09-04T00:00:00Z",
};

function run(events: SessionEvent[], start: SessionState = createSessionState(record)): SessionState {
  return events.reduce((s, ev) => applyEvent(s, ev), start);
}

const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_tokens: 0, cache_write_tokens: 0 });

describe("applyEvent", () => {
  it("init marks live and records the external ref", () => {
    const s = run([{ type: "init", provider: "claude", model: "claude-opus-5", external_ref: "abc", tools: [] }]);
    expect(s.live).toBe(true);
    expect(s.record.external_ref).toBe("abc");
    expect(s.resolvedModel).toBe("claude-opus-5");
    expect(s.items[0]).toMatchObject({ type: "system", variant: "info" });
  });

  it("accumulates text deltas and finalizes with the text event", () => {
    const s = run([
      { type: "user_message", text: "hi" },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
    ]);
    expect(s.running).toBe(true);
    expect(s.items).toHaveLength(2);
    expect(s.items[1]).toMatchObject({ type: "assistant", text: "Hello", streaming: true });

    const done = applyEvent(s, { type: "text", text: "Hello!" });
    expect(done.items).toHaveLength(2);
    expect(done.items[1]).toMatchObject({ type: "assistant", text: "Hello!", streaming: false });

    // A new delta after finalization opens a new assistant item.
    const next = applyEvent(done, { type: "text_delta", text: "More" });
    expect(next.items).toHaveLength(3);
    expect(next.items[2]).toMatchObject({ type: "assistant", text: "More", streaming: true });
  });

  it("text without prior deltas pushes a complete assistant item", () => {
    const s = run([{ type: "text", text: "whole" }]);
    expect(s.items[0]).toMatchObject({ type: "assistant", text: "whole", streaming: false });
  });

  it("pairs tool_start with tool_end by id and finalizes streaming text", () => {
    const s = run([
      { type: "text_delta", text: "Let me look" },
      { type: "tool_start", id: "t1", name: "Read", input: { file_path: "a.rs" } },
      { type: "tool_start", id: "t2", name: "Bash", input: { command: "ls" } },
      { type: "tool_end", id: "t1", output: "contents", is_error: false },
    ]);
    expect(s.items[0]).toMatchObject({ type: "assistant", streaming: false });
    expect(s.items[1]).toMatchObject({ type: "tool", toolId: "t1", name: "Read", output: "contents", done: true, is_error: false });
    expect(s.items[2]).toMatchObject({ type: "tool", toolId: "t2", done: false });
    const s2 = applyEvent(s, { type: "tool_end", id: "t2", output: "boom", is_error: true });
    expect(s2.items[2]).toMatchObject({ done: true, is_error: true, output: "boom" });
  });

  it("tracks permission requests and resolutions", () => {
    const s = run([{ type: "permission_request", request_id: "r1", kind: "command", title: "Bash: rm -rf", detail: { command: "rm -rf x" } }]);
    expect(s.pendingPermissions).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ type: "permission", request_id: "r1" });
    expect((s.items[0] as { decision?: unknown }).decision).toBeUndefined();
    const s2 = applyEvent(s, { type: "permission_resolved", request_id: "r1", decision: "deny" });
    expect(s2.pendingPermissions).toHaveLength(0);
    expect(s2.items[0]).toMatchObject({ type: "permission", decision: "deny" });
  });

  it("thinking text accumulates into one block", () => {
    const s = run([
      { type: "thinking", text: "a" },
      { type: "thinking", text: "b" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ type: "thinking", text: "ab" });
  });

  it("plan updates replace the latest plan within a turn", () => {
    const s = run([
      { type: "plan", steps: [{ text: "a", status: "pending" }] },
      { type: "tool_start", id: "t", name: "Bash", input: {} },
      { type: "plan", steps: [{ text: "a", status: "completed" }] },
    ]);
    expect(s.items.filter((i) => i.type === "plan")).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ type: "plan", steps: [{ text: "a", status: "completed" }] });
  });

  it("turn_end accumulates usage and cost and stops running", () => {
    const s = run([
      { type: "user_message", text: "1" },
      { type: "turn_end", cost_usd: 0.01, usage: usage(100, 20), duration_ms: 1200, stop_reason: "end_turn" },
      { type: "user_message", text: "2" },
      { type: "turn_end", cost_usd: 0.02, usage: usage(50, 10), duration_ms: 800, stop_reason: null },
    ]);
    expect(s.running).toBe(false);
    expect(s.cost).toBeCloseTo(0.03);
    expect(s.usage).toEqual(usage(150, 30));
    const ends = s.items.filter((i) => i.type === "system" && i.variant === "turn_end");
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ meta: { duration_ms: 1200, cost_usd: 0.01 } });
  });

  it("status sets a transient message cleared at turn_end", () => {
    const s = run([{ type: "user_message", text: "x" }, { type: "status", message: "재시도 중" }]);
    expect(s.statusMessage).toBe("재시도 중");
    const s2 = applyEvent(s, { type: "turn_end", cost_usd: null, usage: usage(0, 0), duration_ms: 1, stop_reason: null });
    expect(s2.statusMessage).toBeNull();
  });

  it("fatal errors stop running; non-fatal keep running", () => {
    const s = run([{ type: "user_message", text: "x" }, { type: "error", message: "rate limit", fatal: false }]);
    expect(s.running).toBe(true);
    expect(s.lastError).toBe("rate limit");
    const s2 = applyEvent(s, { type: "error", message: "dead", fatal: true });
    expect(s2.running).toBe(false);
    expect(s2.items.filter((i) => i.type === "system" && i.variant === "error")).toHaveLength(2);
  });

  it("exited marks the session not live and clears pending permissions", () => {
    const s = run([
      { type: "init", provider: "codex", model: "gpt", external_ref: "thr", tools: [] },
      { type: "user_message", text: "x" },
      { type: "text_delta", text: "partial" },
      { type: "permission_request", request_id: "r", kind: "file_edit", title: "edit", detail: null },
      { type: "exited", code: 1 },
    ]);
    expect(s.live).toBe(false);
    expect(s.running).toBe(false);
    expect(s.pendingPermissions).toHaveLength(0);
    expect(s.items.find((i) => i.type === "assistant")).toMatchObject({ streaming: false });
    expect(s.items[s.items.length - 1]).toMatchObject({ type: "system", variant: "exited", text: "세션 종료 (코드 1)" });
  });

  it("does not mutate the previous state", () => {
    const s0 = createSessionState(record);
    const s1 = applyEvent(s0, { type: "text_delta", text: "a" });
    applyEvent(s1, { type: "text_delta", text: "b" });
    expect(s0.items).toHaveLength(0);
    expect(s1.items[0]).toMatchObject({ text: "a" });
  });
});

describe("fromMessages", () => {
  const msg = (seq: number, kind: MessageRecord["kind"], payload: unknown): MessageRecord => ({
    id: `m${seq}`,
    session_id: "s1",
    seq,
    kind,
    payload,
    created_at: "2026-09-04T00:00:00Z",
  });

  it("maps persisted records to chat items and totals", () => {
    const { items, usage: u, cost, externalRef } = fromMessages([
      msg(1, "system", { subtype: "init", model: "claude-opus-5", external_ref: "sess-1" }),
      msg(2, "user", { text: "hello" }),
      msg(3, "assistant", { text: "hi there" }),
      msg(4, "tool", { id: "t1", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" }, output: "ok", is_error: false }),
      msg(5, "tool", { id: "t2", name: "Bash", input: { command: "ls" } }),
      msg(6, "permission", { request_id: "r1", kind: "command", title: "Bash", detail: { command: "ls" }, decision: "allow" }),
      msg(7, "system", { subtype: "turn_end", cost_usd: 0.05, usage: usage(10, 5), duration_ms: 500, stop_reason: "end_turn" }),
      msg(8, "system", { subtype: "error", message: "oops" }),
    ]);
    expect(externalRef).toBe("sess-1");
    expect(items.map((i) => i.type)).toEqual(["system", "user", "assistant", "tool", "tool", "permission", "system", "system"]);
    expect(items[1]).toMatchObject({ id: "h2", text: "hello" });
    expect(items[3]).toMatchObject({ toolId: "t1", name: "Edit", output: "ok", done: true });
    expect(items[4]).toMatchObject({ toolId: "t2", done: false, output: undefined });
    expect(items[5]).toMatchObject({ request_id: "r1", kind: "command", decision: "allow" });
    expect(items[6]).toMatchObject({ variant: "turn_end", meta: { cost_usd: 0.05, duration_ms: 500 } });
    expect(items[7]).toMatchObject({ variant: "error", text: "oops" });
    expect(u).toEqual(usage(10, 5));
    expect(cost).toBeCloseTo(0.05);
  });

  it("tolerates malformed payloads", () => {
    const { items } = fromMessages([msg(1, "user", null), msg(2, "permission", { kind: "weird" }), msg(3, "system", { subtype: "unknown", message: "m" })]);
    expect(items[0]).toMatchObject({ type: "user", text: "" });
    expect(items[1]).toMatchObject({ type: "permission", kind: "other", title: "권한 요청" });
    expect(items[2]).toMatchObject({ type: "system", variant: "info", text: "m" });
  });
});

import { LONG_SESSION_QUESTIONS, questionCount } from "@/stores/sessions";

describe("long session hint", () => {
  it("counts only user messages", () => {
    const items = [
      { type: "user", id: "1", text: "a" },
      { type: "assistant", id: "2", text: "b", streaming: false },
      { type: "user", id: "3", text: "c" },
    ] as never[];
    expect(questionCount(items)).toBe(2);
    expect(LONG_SESSION_QUESTIONS).toBeGreaterThan(0);
  });
});

import { applySubagentEvent, runningSubagents, subagentDepth } from "@/stores/sessions";

describe("agent questions", () => {
  const q = { id: "q1", header: "Auth", question: "Which auth?", options: [{ label: "OAuth", description: null }, { label: "Key", description: null }], multi_select: false, allow_free_text: true };

  it("adds a pending question item and resolves it", () => {
    const s = run([
      { type: "text_delta", text: "Let me ask" },
      { type: "question", request_id: "qr1", questions: [q] },
    ]);
    expect(s.items[0]).toMatchObject({ type: "assistant", streaming: false });
    expect(s.items[1]).toMatchObject({ type: "question", request_id: "qr1", answered: false });
    expect(s.pendingQuestions).toHaveLength(1);
    const s2 = applyEvent(s, { type: "question_resolved", request_id: "qr1" });
    expect(s2.pendingQuestions).toHaveLength(0);
    expect(s2.items[1]).toMatchObject({ type: "question", answered: true });
  });

  it("exited clears pending questions", () => {
    const s = run([{ type: "question", request_id: "qr", questions: [q] }, { type: "exited", code: 0 }]);
    expect(s.pendingQuestions).toHaveLength(0);
  });
});

describe("subagent transcripts", () => {
  const wrap = (parent: string, event: SessionEvent): SessionEvent => ({ type: "subagent", parent_tool_use_id: parent, event });

  it("accumulates deltas, tools and status under the spawning tool", () => {
    const s = run([
      { type: "tool_start", id: "agent1", name: "Agent", input: { description: "Explore repo", prompt: "look around" } },
      wrap("agent1", { type: "text_delta", text: "Sear" }),
      wrap("agent1", { type: "text_delta", text: "ching" }),
      wrap("agent1", { type: "tool_start", id: "st1", name: "Grep", input: { pattern: "foo" } }),
      wrap("agent1", { type: "tool_end", id: "st1", output: "3 matches", is_error: false }),
      wrap("agent1", { type: "text", text: "Found it" }),
    ]);
    const sub = s.subagents["agent1"];
    expect(sub).toBeDefined();
    expect(sub.name).toBe("Explore repo");
    expect(sub.running).toBe(true);
    expect(sub.parentSubagentId).toBeNull();
    expect(sub.items.map((i) => i.type)).toEqual(["text", "tool", "text"]);
    expect(sub.items[0]).toMatchObject({ type: "text", text: "Searching", streaming: false });
    expect(sub.items[1]).toMatchObject({ type: "tool", toolId: "st1", name: "Grep", output: "3 matches", done: true });
    expect(sub.items[2]).toMatchObject({ type: "text", text: "Found it", streaming: false });
    expect(sub.lastActivity).toBe("Found it");
    expect(runningSubagents(s.subagents)).toBe(1);
    // Main transcript is untouched by subagent events.
    expect(s.items).toHaveLength(1);
    expect(s.running).toBe(true);

    const done = applyEvent(s, { type: "tool_end", id: "agent1", output: "summary", is_error: false });
    expect(done.subagents["agent1"].running).toBe(false);
    expect(done.items[0]).toMatchObject({ type: "tool", done: true, output: "summary" });
    expect(runningSubagents(done.subagents)).toBe(0);
  });

  it("nests a subagent spawned from inside another subagent", () => {
    const s = run([
      { type: "tool_start", id: "A", name: "Task", input: { description: "outer" } },
      wrap("A", { type: "tool_start", id: "B", name: "Agent", input: { description: "inner" } }),
      wrap("B", { type: "text_delta", text: "hi from inner" }),
    ]);
    expect(s.subagents["A"].parentSubagentId).toBeNull();
    expect(s.subagents["B"]).toMatchObject({ name: "inner", parentSubagentId: "A", running: true });
    expect(subagentDepth(s.subagents, "B")).toBe(1);
    expect(subagentDepth(s.subagents, "A")).toBe(0);
    // Double-wrapped form (outer wrapper carries the ancestor) works the same.
    const s2 = applyEvent(s, wrap("A", wrap("B", { type: "text", text: "done" })));
    expect(s2.subagents["B"].items[0]).toMatchObject({ type: "text", text: "done", streaming: false });
  });

  it("turn_end stops all running subagents", () => {
    const s = run([
      { type: "tool_start", id: "A", name: "Agent", input: {} },
      wrap("A", { type: "text_delta", text: "x" }),
      { type: "turn_end", cost_usd: null, usage: usage(1, 1), duration_ms: 5, stop_reason: null },
    ]);
    expect(s.subagents["A"].running).toBe(false);
    expect(s.subagents["A"].items[0]).toMatchObject({ streaming: false });
  });

  it("applySubagentEvent is pure", () => {
    const base = { parentToolId: "p", parentSubagentId: null, name: "n", items: [], running: true, startedAt: 0, lastActivity: "", itemCounter: 1 };
    const next = applySubagentEvent(base, { type: "thinking", text: "hmm" });
    expect(base.items).toHaveLength(0);
    expect(next.items[0]).toMatchObject({ type: "thinking", text: "hmm" });
    expect(next.lastActivity).toBe("생각 중…");
  });
});

describe("checkpoints", () => {
  it("adds checkpoint markers from events", () => {
    const s = run([{ type: "checkpoint", checkpoint_id: "c1", label: "턴 3 시작 전" }, { type: "user_message", text: "go" }]);
    expect(s.items[0]).toMatchObject({ type: "checkpoint", checkpoint_id: "c1", label: "턴 3 시작 전" });
    expect(s.items[1]).toMatchObject({ type: "user" });
  });
});

describe("fromMessages (new payloads)", () => {
  const msg = (seq: number, kind: MessageRecord["kind"], payload: unknown): MessageRecord => ({
    id: `m${seq}`,
    session_id: "s1",
    seq,
    kind,
    payload,
    created_at: "2026-09-04T00:00:00Z",
  });

  it("rebuilds subagent transcripts, checkpoints and answered questions", () => {
    const { items, subagents } = fromMessages([
      msg(1, "system", { subtype: "checkpoint", checkpoint_id: "c9", label: "턴 1 시작 전" }),
      msg(2, "user", { text: "do it" }),
      msg(3, "tool", {
        id: "agent1",
        name: "Agent",
        input: { description: "Explore" },
        output: "summary",
        is_error: false,
        subagent: [
          { kind: "text", text: "Looking" },
          { kind: "tool", id: "st1", name: "Grep", input: { pattern: "x" }, output: "1 match", is_error: false },
          { kind: "thinking", text: "hmm" },
        ],
      }),
      msg(4, "system", { subtype: "question", request_id: "qr", questions: [{ id: "q1", header: "H", question: "Q?", options: [{ label: "A" }], multi_select: false, allow_free_text: false }], answers: [{ question_id: "q1", answers: ["A"] }] }),
    ]);
    expect(items[0]).toMatchObject({ type: "checkpoint", checkpoint_id: "c9" });
    expect(items[2]).toMatchObject({ type: "tool", toolId: "agent1", done: true });
    expect(subagents["agent1"]).toMatchObject({ name: "Explore", running: false });
    expect(subagents["agent1"].items.map((i) => i.type)).toEqual(["text", "tool", "thinking"]);
    expect(subagents["agent1"].items[1]).toMatchObject({ type: "tool", toolId: "st1", output: "1 match", done: true });
    expect(items[3]).toMatchObject({ type: "question", request_id: "qr", answered: true, answers: [{ question_id: "q1", answers: ["A"] }] });
    expect((items[3] as { questions: unknown[] }).questions).toHaveLength(1);
  });
});
