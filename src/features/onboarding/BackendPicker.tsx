import { CheckCircle2, Monitor, Terminal, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { BackendConfig } from "@/lib/bindings/BackendConfig";
import type { BackendKind } from "@/lib/bindings/BackendKind";
import type { ToolStatus } from "@/lib/bindings/ToolStatus";
import { toolFound } from "./recommend";
import { ManagedEnvCard } from "./ManagedEnvCard";
import { isManagedBackend, MANAGED_BACKEND, MANAGED_DISTRO } from "./useManagedEnv";
import type { WslStatus } from "@/lib/ipc";

interface Props {
  value: BackendConfig;
  onChange: (v: BackendConfig) => void;
  distros: string[];
  nativeTools: ToolStatus[] | null;
  /** Tools of the currently selected distro. */
  wslTools: ToolStatus[] | null;
  wslToolsByDistro?: Record<string, ToolStatus[] | null>;
  nativeLoggedIn?: boolean | null;
  wslLoggedIn?: boolean | null;
  recommended: BackendKind | null;
  recommendedDistro?: string | null;
  loading: boolean;
  /** App-owned environment card (first position). */
  managed?: {
    status: WslStatus | null;
    tools: ToolStatus[] | null;
    loggedIn: boolean | null;
    recommended: boolean;
    onChanged: () => void | Promise<void>;
  };
}

function Marks({ tools, loggedIn }: { tools: ToolStatus[] | null; loggedIn?: boolean | null }) {
  const items = ["claude", "codex", "git"];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {items.map((n) => {
        const found = toolFound(tools, n);
        return (
          <span key={n} className="inline-flex items-center gap-1 text-muted-foreground">
            {tools === null ? (
              <span className="size-3.5 animate-pulse rounded-full bg-muted" />
            ) : found ? (
              <CheckCircle2 className="size-3.5 text-emerald-600" />
            ) : (
              <XCircle className="size-3.5" />
            )}
            <span className="font-mono">{n}</span>
            {n === "claude" && found && loggedIn !== undefined && loggedIn !== null && (
              <Badge variant={loggedIn ? "default" : "outline"} className="ml-0.5 px-1.5 py-0 text-[10px]">
                {loggedIn ? "로그인됨" : "로그인 필요"}
              </Badge>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Compact per-distro summary shown inside the Select items. */
function distroSummary(tools: ToolStatus[] | null | undefined): string {
  if (!tools) return "";
  const have = ["claude", "codex", "git"].filter((n) => toolFound(tools, n));
  return have.length ? ` · ${have.join(" ")}` : " · 도구 없음";
}

/** Two selectable cards: Windows native vs WSL (with distro select). */
export function BackendPicker({
  value,
  onChange,
  distros,
  nativeTools,
  wslTools,
  wslToolsByDistro = {},
  nativeLoggedIn = null,
  wslLoggedIn = null,
  recommended,
  recommendedDistro = null,
  loading,
  managed,
}: Props) {
  const isManaged = isManagedBackend(value);
  const userDistros = distros.filter((d) => d !== MANAGED_DISTRO);
  const card = (
    kind: BackendKind,
    icon: React.ReactNode,
    title: string,
    desc: string,
    tools: ToolStatus[] | null,
    loggedIn: boolean | null,
    extra?: React.ReactNode,
  ) => {
    const selected = value.kind === kind && !(kind === "wsl" && isManaged);
    return (
      <button
        type="button"
        onClick={() =>
          onChange({
            kind,
            wsl_distro: kind === "wsl" ? ((isManaged ? null : value.wsl_distro) ?? recommendedDistro ?? userDistros[0] ?? null) : null,
          })
        }
        aria-pressed={selected}
        className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors ${
          selected ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "hover:bg-accent/40"
        }`}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium">{title}</span>
          {recommended === kind && !managed?.recommended && !loading && <Badge className="ml-auto">추천</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{desc}</p>
        <Marks tools={tools} loggedIn={loggedIn} />
        {extra}
      </button>
    );
  };

  return (
    <div className={managed ? "grid gap-4 md:grid-cols-3" : "grid gap-4 md:grid-cols-2"}>
      {managed && (
        <ManagedEnvCard
          status={managed.status}
          tools={managed.tools}
          claudeLoggedIn={managed.loggedIn}
          selected={isManaged}
          recommended={managed.recommended && !loading}
          onChanged={managed.onChanged}
          onSelect={() => onChange(MANAGED_BACKEND)}
        />
      )}
      {card(
        "native",
        <Monitor className="size-5" />,
        "Windows 네이티브",
        "Windows에 설치된 claude / codex / git을 직접 실행합니다. Claude의 Bash 도구는 Git for Windows가 필요합니다.",
        nativeTools,
        nativeLoggedIn,
      )}
      {card(
        "wsl",
        <Terminal className="size-5" />,
        "WSL",
        "WSL 배포판 안의 도구를 사용합니다. 리눅스 툴체인과 샌드박스를 그대로 쓸 수 있습니다.",
        wslTools,
        wslLoggedIn,
        userDistros.length > 0 ? (
          <div onClick={(e) => e.stopPropagation()} className="w-full">
            <Select
              value={(isManaged ? null : value.wsl_distro) ?? recommendedDistro ?? userDistros[0]}
              onValueChange={(d) => onChange({ kind: "wsl", wsl_distro: d })}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue placeholder="배포판 선택" />
              </SelectTrigger>
              <SelectContent>
                {userDistros.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                    <span className="text-muted-foreground">{distroSummary(wslToolsByDistro[d])}</span>
                    {d === recommendedDistro && <span className="text-primary"> · 추천</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">PC에 설치된 WSL 배포판이 없습니다 (전용 환경 제외).</p>
        ),
      )}
    </div>
  );
}
