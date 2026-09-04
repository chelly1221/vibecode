// Renders one tool call (Claude built-in tools, Codex items, MCP tools).

import { useMemo, useState } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  GlobeIcon,
  ListChecksIcon,
  Loader2Icon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ChatItem } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import { DiffView } from "./DiffView";
import { PlanCard } from "./PlanCard";

type ToolItem = Extract<ChatItem, { type: "tool" }>;

type Category = "search" | "edit" | "command" | "subagent" | "mcp" | "todo" | "web" | "other";

const OUTPUT_PREVIEW_CHARS = 2000;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pickString(r: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).join(" ");
  }
  return null;
}

export function categorize(name: string): Category {
  const n = name.toLowerCase();
  if (n.startsWith("mcp__")) return "mcp";
  if (["read", "glob", "grep", "ls", "notebookread", "fileread", "file_read", "search", "list_dir"].includes(n)) return "search";
  if (["edit", "write", "multiedit", "notebookedit", "filechange", "file_change", "apply_patch", "applypatch", "str_replace_based_edit_tool", "create_file"].includes(n)) return "edit";
  if (["bash", "powershell", "commandexecution", "command_execution", "shell", "exec_command", "local_shell"].includes(n)) return "command";
  if (["agent", "task", "subagent"].includes(n)) return "subagent";
  if (["todowrite", "todoread", "update_plan"].includes(n)) return "todo";
  if (["webfetch", "websearch", "web_search", "web_fetch"].includes(n)) return "web";
  return "other";
}

const CATEGORY_LABEL: Record<Category, string> = {
  search: "검색",
  edit: "편집",
  command: "명령",
  subagent: "서브에이전트",
  mcp: "MCP",
  todo: "할 일",
  web: "웹",
  other: "도구",
};

function CategoryIcon({ c, className }: { c: Category; className?: string }) {
  const cls = cn("size-3.5", className);
  switch (c) {
    case "search":
      return <SearchIcon className={cls} />;
    case "edit":
      return <FilePenLineIcon className={cls} />;
    case "command":
      return <TerminalIcon className={cls} />;
    case "subagent":
      return <BotIcon className={cls} />;
    case "mcp":
      return <PlugIcon className={cls} />;
    case "todo":
      return <ListChecksIcon className={cls} />;
    case "web":
      return <GlobeIcon className={cls} />;
    default:
      return <WrenchIcon className={cls} />;
  }
}

/** Short one-line summary shown next to the tool name. */
export function summarize(name: string, input: unknown): string {
  const r = rec(input);
  const c = categorize(name);
  if (c === "command") return pickString(r, ["command", "cmd", "description"]) ?? "";
  if (c === "edit") {
    const path = pickString(r, ["file_path", "path", "filePath", "notebook_path"]);
    if (path) return path;
    const changes = r.changes;
    if (Array.isArray(changes)) return `${changes.length}개 파일`;
    return "";
  }
  if (c === "search") return pickString(r, ["file_path", "pattern", "path", "query", "glob"]) ?? "";
  if (c === "web") return pickString(r, ["url", "query"]) ?? "";
  if (c === "subagent") return pickString(r, ["description", "prompt"]) ?? "";
  if (c === "mcp") return name.split("__").slice(1).join(" / ");
  return pickString(r, ["description", "path", "query", "command"]) ?? "";
}

/** Extract diff-able content from an edit-like tool input. */
function editViews(input: unknown): Array<{ path: string | null; oldText?: string; newText?: string; unified?: string }> {
  const r = rec(input);
  const path = pickString(r, ["file_path", "path", "filePath", "notebook_path"]);
  if (typeof r.old_string === "string" || typeof r.new_string === "string") {
    return [{ path, oldText: String(r.old_string ?? ""), newText: String(r.new_string ?? "") }];
  }
  if (Array.isArray(r.edits)) {
    return r.edits.map((e) => {
      const er = rec(e);
      return { path, oldText: String(er.old_string ?? ""), newText: String(er.new_string ?? "") };
    });
  }
  if (typeof r.content === "string") return [{ path, oldText: "", newText: r.content }];
  if (typeof r.new_source === "string") return [{ path, oldText: "", newText: r.new_source }];
  if (Array.isArray(r.changes)) {
    return r.changes.map((ch) => {
      const cr = rec(ch);
      const p = pickString(cr, ["path", "file_path"]);
      if (typeof cr.diff === "string") return { path: p, unified: cr.diff };
      if (typeof cr.unified_diff === "string") return { path: p, unified: cr.unified_diff };
      return { path: p, oldText: String(cr.old ?? cr.before ?? ""), newText: String(cr.new ?? cr.after ?? cr.content ?? "") };
    });
  }
  if (typeof r.diff === "string") return [{ path, unified: r.diff }];
  if (typeof r.patch === "string") return [{ path, unified: r.patch }];
  return [];
}

export function OutputBlock({ text, isError }: { text: string; isError?: boolean }) {
  const [full, setFull] = useState(false);
  const truncated = !full && text.length > OUTPUT_PREVIEW_CHARS;
  const shown = truncated ? text.slice(0, OUTPUT_PREVIEW_CHARS) : text;
  return (
    <div>
      <pre
        className={cn(
          "max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-[0.75rem] leading-relaxed whitespace-pre-wrap break-all",
          isError && "border-destructive/40 bg-destructive/5 text-destructive",
        )}
      >
        {shown || <span className="text-muted-foreground">(출력 없음)</span>}
        {truncated && "…"}
      </pre>
      {text.length > OUTPUT_PREVIEW_CHARS && (
        <button type="button" className="mt-1 text-xs text-muted-foreground hover:underline" onClick={() => setFull((v) => !v)}>
          {full ? "접기" : `더 보기 (${text.length.toLocaleString()}자)`}
        </button>
      )}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return <OutputBlock text={text} />;
}

export function ToolCard({ item }: { item: ToolItem }) {
  const category = categorize(item.name);
  const summary = summarize(item.name, item.input);
  const [open, setOpen] = useState(category === "edit" || category === "command" || category === "todo");
  const input = rec(item.input);

  const body = (() => {
    switch (category) {
      case "edit": {
        const views = editViews(item.input);
        return (
          <div className="space-y-2">
            {views.length === 0 ? <JsonBlock value={item.input} /> : views.map((v, i) => <DiffView key={i} {...v} />)}
            {item.output !== undefined && (item.is_error || open) && item.output.trim() && item.is_error && <OutputBlock text={item.output} isError />}
          </div>
        );
      }
      case "command": {
        const cmd = pickString(input, ["command", "cmd"]) ?? "";
        const desc = typeof input.description === "string" ? input.description : null;
        return (
          <div className="space-y-2">
            {desc && <div className="text-xs text-muted-foreground">{desc}</div>}
            <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-2.5 font-mono text-[0.75rem] text-zinc-100 whitespace-pre-wrap break-all dark:bg-zinc-900">
              <span className="select-none text-zinc-500">$ </span>
              {cmd}
            </pre>
            {item.output !== undefined && <OutputBlock text={item.output} isError={item.is_error} />}
          </div>
        );
      }
      case "todo": {
        const todos = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : null;
        if (todos) {
          const steps = todos.map((t) => {
            const tr = rec(t);
            return { text: String(tr.content ?? tr.step ?? tr.text ?? ""), status: String(tr.status ?? "pending") };
          });
          return <PlanCard steps={steps} />;
        }
        return <JsonBlock value={item.input} />;
      }
      default:
        return (
          <div className="space-y-2">
            {item.input != null && Object.keys(input).length > 0 && (
              <div>
                <div className="mb-1 text-[11px] text-muted-foreground">입력</div>
                <JsonBlock value={item.input} />
              </div>
            )}
            {item.output !== undefined && (
              <div>
                <div className="mb-1 text-[11px] text-muted-foreground">결과</div>
                <OutputBlock text={item.output} isError={item.is_error} />
              </div>
            )}
          </div>
        );
    }
  })();

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("rounded-lg border bg-card text-sm", item.is_error && "border-destructive/40")}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50">
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <CategoryIcon c={category} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">{CATEGORY_LABEL[category]}</span>
        <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{item.name}</span>
        {summary && <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{summary}</span>}
        <span className="ml-auto shrink-0">
          {!item.done ? (
            <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
          ) : item.is_error ? (
            <XCircleIcon className="size-3.5 text-destructive" />
          ) : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-2.5 py-2">{body}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
