import { Component, type ErrorInfo, type ReactNode } from "react";

/** Keep a rendering failure recoverable instead of leaving an empty desktop window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("화면 오류", error, info); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center text-foreground" role="alert">
        <h1 className="text-xl font-semibold">화면을 표시하는 중 문제가 생겼어요</h1>
        <p className="max-w-md text-sm text-muted-foreground">화면을 다시 불러와서 계속할 수 있습니다. 전송하지 않은 입력은 사라질 수 있습니다.</p>
        <button type="button" className="rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground" onClick={() => window.location.reload()}>화면 다시 불러오기</button>
      </main>
    );
  }
}
