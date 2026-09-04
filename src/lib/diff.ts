// Lightweight line diff utilities for tool cards and permission prompts.

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export type DiffRow = DiffLine | { type: "skip"; count: number; start: number; end: number };

/** Above this many cell comparisons fall back to a delete-all/add-all diff. */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

type Op = "eq" | "del" | "add";

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("eq");
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push("del");
      i++;
    } else {
      ops.push("add");
      j++;
    }
  }
  while (i < n) {
    ops.push("del");
    i++;
  }
  while (j < m) {
    ops.push("add");
    j++;
  }
  return ops;
}

/** Line-based diff of two texts (common prefix/suffix trimmed, LCS in the middle). */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < start; i++) out.push({ type: "context", text: a[i], oldNo: oldNo++, newNo: newNo++ });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let ops: Op[];
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > MAX_CELLS) {
    ops = [...midA.map((): Op => "del"), ...midB.map((): Op => "add")];
  } else {
    ops = lcsOps(midA, midB);
  }
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === "eq") {
      out.push({ type: "context", text: midA[ai++], oldNo: oldNo++, newNo: newNo++ });
      bi++;
    } else if (op === "del") {
      out.push({ type: "del", text: midA[ai++], oldNo: oldNo++ });
    } else {
      out.push({ type: "add", text: midB[bi++], newNo: newNo++ });
    }
  }
  for (let i = endA; i < a.length; i++) out.push({ type: "context", text: a[i], oldNo: oldNo++, newNo: newNo++ });
  return out;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse unified diff text (git style) into lines. Tolerates missing headers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (!inHunk || line.startsWith("diff --git")) {
        inHunk = false;
        continue;
      }
    }
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      out.push({ type: "add", text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith("-")) {
      out.push({ type: "del", text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(" ")) {
      out.push({ type: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line === "" && !inHunk) {
      continue;
    } else if (inHunk) {
      out.push({ type: "context", text: line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

/** Collapse long unchanged runs, keeping `context` lines around each change. */
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "context") {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    if (j - i <= 2) {
      for (let k = i; k < j; k++) out.push(lines[k]);
    } else {
      out.push({ type: "skip", count: j - i, start: i, end: j });
    }
    i = j;
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}
