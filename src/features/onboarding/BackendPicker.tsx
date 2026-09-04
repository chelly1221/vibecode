import { CheckCircle2, Monitor, Terminal, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { BackendConfig } from "@/lib/bindings/BackendConfig";
import type { BackendKind } from "@/lib/bindings/BackendKind";
import type { ToolStatus } from "@/lib/bindings/ToolStatus";
import { toolFound } from "./recommend";

interface Props {
  value: BackendConfig;
  onChange: (v: BackendConfig) => void;
  distros: string[];
  nativeTools: ToolStatus[] | null;
  wslTools: ToolStatus[] | null;
  recommended: BackendKind | null;
  loading: boolean;
}

function Marks({ tools }: { tools: ToolStatus[] | null }) {
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
          </span>
        );
      })}
    </div>
  );
}

/** Two selectable cards: Windows native vs WSL (with distro select). */
export function BackendPicker({ value, onChange, distros, nativeTools, wslTools, recommended, loading }: Props) {
  const card = (kind: BackendKind, icon: React.ReactNode, title: string, desc: string, tools: ToolStatus[] | null, extra?: React.ReactNode) => {
    const selected = value.kind === kind;
    return (
      <button
        type="button"
        onClick={() => onChange({ kind, wsl_distro: kind === "wsl" ? (value.wsl_distro ?? distros[0] ?? null) : null })}
        aria-pressed={selected}
        className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors ${
          selected ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "hover:bg-accent/40"
        }`}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium">{title}</span>
          {recommended === kind && !loading && <Badge className="ml-auto">추천</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{desc}</p>
        <Marks tools={tools} />
        {extra}
      </button>
    );
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {card(
        "native",
        <Monitor className="size-5" />,
        "Windows 네이티브",
        "Windows에 설치된 claude / codex / git을 직접 실행합니다. Claude의 Bash 도구는 Git for Windows가 필요합니다.",
        nativeTools,
      )}
      {card(
        "wsl",
        <Terminal className="size-5" />,
        "WSL",
        "WSL 배포판 안의 도구를 사용합니다. 리눅스 툴체인과 샌드박스를 그대로 쓸 수 있습니다.",
        wslTools,
        distros.length > 0 ? (
          <div onClick={(e) => e.stopPropagation()} className="w-full">
            <Select
              value={value.wsl_distro ?? distros[0]}
              onValueChange={(d) => onChange({ kind: "wsl", wsl_distro: d })}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue placeholder="배포판 선택" />
              </SelectTrigger>
              <SelectContent>
                {distros.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">설치된 WSL 배포판을 찾지 못했습니다.</p>
        ),
      )}
    </div>
  );
}
