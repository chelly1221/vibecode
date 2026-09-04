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
