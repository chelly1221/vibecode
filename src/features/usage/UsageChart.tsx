// Remaining-usage line chart (SVG, no chart library): one line per rate-limit window over the
// selected time range, crosshair + tooltip on hover, legend and direct labels at the line ends.
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { WindowUsage } from "@/stores/usage";
import { remainingPercent, seriesColor, timeTick } from "./format";

const W = 640;
const H = 220;
const PAD = { top: 14, right: 64, bottom: 26, left: 36 };

interface Series {
  id: string;
  label: string;
  color: string;
  points: Array<{ t: number; v: number }>;
}

export function UsageChart({ windows, rangeHours, nowSecs, className }: { windows: WindowUsage[]; rangeHours: number; nowSecs: number; className?: string }) {
  const t1 = nowSecs;
  const t0 = nowSecs - rangeHours * 3600;
  const series: Series[] = useMemo(
    () =>
      windows.map((w, i) => {
        const inRange = w.points.filter((p) => p.t >= t0 && p.t <= t1);
        // Carry the last value before the range in as the starting point so the line spans the chart.
        const before = w.points.filter((p) => p.t < t0).pop();
        const pts = (before ? [{ t: t0, used: before.used }] : []).concat(inRange).map((p) => ({ t: p.t, v: remainingPercent(p.used) }));
        // Extend the latest value to "now" (a flat line: nothing changed since the last report).
        const last = pts[pts.length - 1];
        if (last && last.t < t1) pts.push({ t: t1, v: last.v });
        return { id: w.window.id, label: w.window.label, color: seriesColor(i), points: pts };
      }),
    [windows, t0, t1],
  );

  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / 100) * (H - PAD.top - PAD.bottom);

  const ticks = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n);
  }, [t0, t1]);

  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (t1 - t0);
    setHover(Math.max(t0, Math.min(t1, t)));
  };

  const valueAt = (s: Series, t: number): number | null => {
    if (s.points.length === 0) return null;
    let v: number | null = null;
    for (const p of s.points) {
      if (p.t <= t) v = p.v;
      else break;
    }
    return v;
  };

  const hasData = series.some((s) => s.points.length > 0);
  const tooltipLeft = hover !== null ? x(hover) : 0;
  const flip = tooltipLeft > W * 0.65;

  return (
    <div className={cn("relative", className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full select-none"
        role="img"
        aria-label="남은 사용량 추이"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* recessive grid */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v === 0 ? 0.35 : 0.12} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.6}>
              {v}%
            </text>
          </g>
        ))}
        {ticks.map((t, i) => (
          <text key={i} x={x(t)} y={H - PAD.bottom + 16} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} fontSize={10} fill="currentColor" fillOpacity={0.6}>
            {timeTick(t, rangeHours)}
          </text>
        ))}
        {/* series */}
        {series.map((s) => {
          if (s.points.length === 0) return null;
          const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.id}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(last.t)} cy={y(last.v)} r={3.5} fill={s.color} stroke="var(--card)" strokeWidth={2} />
              <text x={x(last.t) + 8} y={y(last.v) + 3.5} fontSize={11} fill="currentColor" fillOpacity={0.85}>
                {s.label} {Math.round(last.v)}%
              </text>
            </g>
          );
        })}
        {!hasData && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={12} fill="currentColor" fillOpacity={0.55}>
            이 기간에는 기록이 없어요
          </text>
        )}
        {/* crosshair */}
        {hover !== null && hasData && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="3 3" />
            {series.map((s) => {
              const v = valueAt(s, hover);
              return v === null ? null : <circle key={s.id} cx={x(hover)} cy={y(v)} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />;
            })}
          </g>
        )}
      </svg>
      {hover !== null && hasData && (
        <div
          className="pointer-events-none absolute top-2 rounded-md border bg-popover px-2 py-1.5 text-[11px] text-popover-foreground shadow-md"
          style={{ left: `${(tooltipLeft / W) * 100}%`, transform: flip ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
        >
          <div className="mb-0.5 text-muted-foreground">{new Date(hover * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</div>
          {series.map((s) => {
            const v = valueAt(s, hover);
            return (
              <div key={s.id} className="flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-sm" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="ml-auto pl-3 font-mono tabular-nums">{v === null ? "-" : `${Math.round(v)}%`}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-3 px-1 text-[11px] text-muted-foreground" aria-label="범례">
        {series.map((s) => (
          <span key={s.id} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} /> {s.label} 남은 비율
          </span>
        ))}
      </div>
    </div>
  );
}
