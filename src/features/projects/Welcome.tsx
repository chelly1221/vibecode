import { ArrowRight, FolderOpen, MessageSquare, MonitorPlay, Sparkles } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app";
import { registerExistingProject } from "./registerExisting";

export function Welcome() {
  const projects = useAppStore((s) => s.projects);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const selectProject = useAppStore((s) => s.selectProject);
  const openExisting = async () => {
    try {
      const path = await open({ directory: true, multiple: false, title: "이어서 작업할 폴더 선택" });
      if (path) await registerExistingProject(path);
    } catch (e) {
      toast.error("폴더를 열지 못했어요", { description: String(e) });
    }
  };
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top_right,var(--accent),transparent_65%)]">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center gap-8 px-8 py-10 lg:px-14">
        <div className="space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium text-primary"><Sparkles className="size-3.5" /> 아이디어를 실제 프로그램으로</span>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight lg:text-4xl">만들고 싶은 것을<br />말로 설명해 주세요.</h1>
          <p className="max-w-lg text-base leading-relaxed text-muted-foreground">코드를 몰라도 괜찮아요. AI와 대화하며 만들고, 결과를 확인하고, 원하는 모습으로 바꿀 수 있어요.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={() => setWizardOpen(true)} className="group rounded-2xl border border-primary/25 bg-primary p-5 text-left text-primary-foreground shadow-sm transition-transform hover:-translate-y-0.5">
            <Sparkles className="mb-4 size-6" />
            <span className="flex items-center justify-between text-lg font-semibold">새로 만들기 <ArrowRight className="size-5 transition-transform group-hover:translate-x-1" /></span>
            <span className="mt-2 block text-sm opacity-85">아이디어만 있으면 시작할 수 있어요</span>
          </button>
          <button type="button" onClick={() => void openExisting()} className="group rounded-2xl border bg-card p-5 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-accent/50">
            <FolderOpen className="mb-4 size-6 text-primary" />
            <span className="flex items-center justify-between text-lg font-semibold">기존 폴더 열기 <ArrowRight className="size-5 text-muted-foreground" /></span>
            <span className="mt-2 block text-sm text-muted-foreground">이미 만든 프로그램을 이어서 수정해요</span>
          </button>
        </div>
        {projects.length > 0 && <section className="space-y-3">
          <h2 className="text-sm font-semibold">이어서 작업하기</h2>
          <div className="flex flex-wrap gap-2">{projects.slice(0, 4).map((p) => <Button key={p.id} variant="outline" className="max-w-full" onClick={() => selectProject(p.id)}><FolderOpen /><span className="truncate">{p.name}</span><ArrowRight /></Button>)}</div>
        </section>}
        <ol className="grid gap-4 border-t pt-6 text-sm sm:grid-cols-3">
          {[[MessageSquare, "1. 원하는 것 설명하기", "AI가 만드는 방법을 제안해요"], [Sparkles, "2. 대화하며 만들기", "원하는 기능과 수정을 요청하세요"], [MonitorPlay, "3. 결과 확인하기", "미리보기로 확인하고 다듬어요"]].map(([Icon, title, desc]) => {
            const StepIcon = Icon as typeof MessageSquare;
            return <li key={String(title)} className="space-y-2"><StepIcon className="size-5 text-primary" /><div className="font-medium">{String(title)}</div><p className="text-xs leading-relaxed text-muted-foreground">{String(desc)}</p></li>;
          })}
        </ol>
      </div>
    </main>
  );
}
