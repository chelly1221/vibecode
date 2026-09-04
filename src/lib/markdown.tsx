// Markdown renderer for assistant messages: GFM + syntax highlighting, external
// links opened with the OS browser, copy button on code blocks.

import { memo, useCallback, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import "@/lib/hljs.css";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false }] as const];

async function openExternal(href: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
  } catch {
    window.open(href, "_blank", "noopener");
  }
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, [text]);
  return (
    <button
      type="button"
      onClick={onClick}
      title="복사"
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/pre:opacity-100 focus-visible:opacity-100",
        copied && "opacity-100 text-green-600",
        className,
      )}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function Pre({ children, className, ...rest }: ComponentProps<"pre">) {
  const code = textOf(children);
  return (
    <div className="group/pre relative my-2">
      <pre
        className={cn("overflow-x-auto rounded-lg border bg-muted/40 p-3 text-[0.8rem] leading-relaxed [&_code]:bg-transparent [&_code]:p-0", className)}
        {...rest}
      >
        {children}
      </pre>
      <CopyButton text={code} className="absolute top-1.5 right-1.5 bg-background/80" />
    </div>
  );
}

const components: Components = {
  pre: Pre,
  code: ({ className, children, ...rest }) => (
    <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)} {...rest}>
      {children}
    </code>
  ),
  a: ({ href, children, ...rest }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-2"
      onClick={(e) => {
        e.preventDefault();
        if (href) void openExternal(href);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
  table: ({ children, ...rest }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left" {...rest}>
        {children}
      </table>
    </div>
  ),
  ul: ({ children, ...rest }) => (
    <ul className="my-1.5 list-disc pl-5 [&_ul]:my-0.5" {...rest}>
      {children}
    </ul>
  ),
  ol: ({ children, ...rest }) => (
    <ol className="my-1.5 list-decimal pl-5 [&_ol]:my-0.5" {...rest}>
      {children}
    </ol>
  ),
  li: ({ children, ...rest }) => (
    <li className="my-0.5" {...rest}>
      {children}
    </li>
  ),
  p: ({ children, ...rest }) => (
    <p className="my-1.5 leading-relaxed" {...rest}>
      {children}
    </p>
  ),
  h1: ({ children, ...rest }) => (
    <h1 className="mt-4 mb-2 text-lg font-semibold" {...rest}>
      {children}
    </h1>
  ),
  h2: ({ children, ...rest }) => (
    <h2 className="mt-3 mb-1.5 text-base font-semibold" {...rest}>
      {children}
    </h2>
  ),
  h3: ({ children, ...rest }) => (
    <h3 className="mt-3 mb-1 text-sm font-semibold" {...rest}>
      {children}
    </h3>
  ),
  blockquote: ({ children, ...rest }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground" {...rest}>
      {children}
    </blockquote>
  ),
  hr: (props) => <hr className="my-3 border-border" {...props} />,
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-sm break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
