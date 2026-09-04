// Pure helpers for the MCP server editor.
import type { McpServerConfig } from "@/lib/ipc";
import type { EnvVar } from "@/lib/bindings/EnvVar";

/** Split a command line into arguments: whitespace separated, single/double quotes group, backslash escapes inside quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && i + 1 < input.length && input[i + 1] === quote) {
        cur += quote;
        i++;
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Quote an argument list back into a single line (inverse of splitArgs for display). */
export function joinArgs(args: string[]): string {
  return args.map((a) => (a === "" || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

/** Parse `KEY=VALUE` lines (blank lines and `#` comments ignored). */
export function parseEnv(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

export function formatEnv(env: EnvVar[]): string {
  return env.map((e) => `${e.key}=${e.value}`).join("\n");
}

export const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Returns an error message or null. */
export function validateServer(s: McpServerConfig, others: McpServerConfig[]): string | null {
  if (!s.name.trim()) return "이름을 입력하세요.";
  if (!NAME_RE.test(s.name)) return "이름은 영문, 숫자, - _ 만 사용할 수 있습니다.";
  if (others.some((o) => o.id !== s.id && o.name === s.name)) return "같은 이름의 서버가 이미 있습니다.";
  if (s.transport === "stdio") {
    if (!s.command?.trim()) return "stdio 서버는 실행 명령이 필요합니다.";
  } else if (!s.url || !/^https?:\/\/\S+$/i.test(s.url.trim())) {
    return "http 서버는 http(s):// 로 시작하는 URL이 필요합니다.";
  }
  if (s.env.some((e) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key))) return "환경 변수 이름이 올바르지 않습니다.";
  return null;
}

export function newServer(): McpServerConfig {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
    name: "",
    transport: "stdio",
    command: null,
    args: [],
    env: [],
    url: null,
    enabled: true,
    providers: [],
  };
}
