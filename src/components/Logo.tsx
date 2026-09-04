// App logo: pink "</>" glyph (same artwork as src-tauri/icons, see assets/icon.svg).
import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={cn("size-5", className)} aria-hidden="true">
      <g fill="none" stroke="#F72E87" strokeWidth="112" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="286,296 62,500 286,704" />
        <polyline points="738,296 962,500 738,704" />
        <line x1="630" y1="152" x2="392" y2="848" />
      </g>
    </svg>
  );
}
