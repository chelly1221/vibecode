// Read-only CodeMirror viewer for a project file.
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2, WrapText } from "lucide-react";
import { toast } from "sonner";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app";
import { useFilesStore } from "@/stores/files";
import { formatSize, langFromPath, type ViewerLang } from "./path";

function langExtension(lang: ViewerLang): Extension | null {
  switch (lang) {
    case "javascript":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "rust":
      return rust();
    case "python":
      return python();
    case "json":
      return json();
    case "markdown":
      return markdown();
    default:
      return null;
  }
}

// Theme-agnostic colors (read fine on the light and dark token palettes).
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "#c678dd" },
  { tag: [t.string, t.special(t.string)], color: "#2e9e5b" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#d19a66" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#8a8f98", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#4078f2" },
  { tag: [t.typeName, t.className, t.namespace], color: "#c18401" },
  { tag: [t.propertyName, t.attributeName], color: "#e06c75" },
  { tag: t.heading, fontWeight: "bold" },
  { tag: t.link, textDecoration: "underline" },
]);

const baseTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "12.5px", height: "100%" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
});

export function FileViewerDialog() {
  const viewer = useFilesStore((s) => s.viewer);
  const closeViewer = useFilesStore((s) => s.closeViewer);
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const [wrap, setWrap] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const lang = useMemo(() => (viewer ? langFromPath(viewer.relPath) : "plain"), [viewer]);
  const content = viewer?.file && !viewer.file.binary ? viewer.file.content : "";

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !viewer?.file) return;
    const ext = langExtension(lang);
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        syntaxHighlighting(highlight),
        baseTheme,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        ...(wrap ? [EditorView.lineWrapping] : []),
        ...(ext ? [ext] : []),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [viewer?.file, content, lang, wrap]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("내용을 복사했습니다");
    } catch (e) {
      toast.error(`복사 실패: ${String(e)}`);
    }
  };

  const reveal = () => {
    if (!project || !viewer) return;
    const full = `${project.path.replace(/[\\/]+$/, "")}\\${viewer.relPath.replace(/\//g, "\\")}`;
    revealItemInDir(full).catch((e) => toast.error(`열기 실패: ${String(e)}`));
  };

  return (
    <Dialog open={!!viewer} onOpenChange={(o) => !o && closeViewer()}>
      <DialogContent className="flex h-[85vh] flex-col gap-2 sm:max-w-5xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex min-w-0 items-center gap-2 font-mono text-sm">
            <span className="truncate">{viewer?.relPath}</span>
            {viewer?.file && (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {formatSize(viewer.file.size)}
              </Badge>
            )}
            {viewer?.file?.truncated && (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                일부만 표시 (1MB 초과)
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-xs">{project?.path}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-xs" variant={wrap ? "secondary" : "ghost"} aria-label="줄 바꿈" onClick={() => setWrap((w) => !w)}>
                  <WrapText />
                </Button>
              </TooltipTrigger>
              <TooltipContent>줄 바꿈</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-xs" variant="ghost" aria-label="복사" onClick={copy} disabled={!content}>
                  <Copy />
                </Button>
              </TooltipTrigger>
              <TooltipContent>내용 복사</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-xs" variant="ghost" aria-label="탐색기에서 열기" onClick={reveal}>
                  <ExternalLink />
                </Button>
              </TooltipTrigger>
              <TooltipContent>탐색기에서 열기</TooltipContent>
            </Tooltip>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-background">
          {viewer?.loading && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 읽는 중…
            </div>
          )}
          {viewer?.error && <div className="p-4 text-sm text-destructive">{viewer.error}</div>}
          {viewer?.file?.binary && (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
              바이너리 파일이라 내용을 표시하지 않습니다. "탐색기에서 열기"로 확인하세요.
            </div>
          )}
          {viewer?.file && !viewer.file.binary && <div ref={hostRef} className="h-full" />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
