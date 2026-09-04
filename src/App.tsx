import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { ProjectSidebar } from "@/features/projects/ProjectSidebar";
import { ProjectWizard } from "@/features/projects/ProjectWizard";
import { ChatView } from "@/features/chat/ChatView";
import { GitPanel } from "@/features/git/GitPanel";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import { SettingsDialog } from "@/features/settings/SettingsDialog";

export default function App() {
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const gitPanelOpen = useAppStore((s) => s.gitPanelOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);

  useEffect(() => {
    loadSettings().catch((e) => console.error("settings", e));
    loadProjects().catch((e) => console.error("projects", e));
  }, [loadSettings, loadProjects]);

  useEffect(() => {
    const root = document.documentElement;
    const theme = settings?.theme ?? "system";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", theme === "dark" || (theme === "system" && prefersDark));
  }, [settings?.theme]);

  if (settings && !settings.onboarding_done) {
    return (
      <TooltipProvider>
        <Onboarding />
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
        <ProjectSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col">
              <ChatView />
            </main>
            {gitPanelOpen && (
              <aside className="w-80 shrink-0 border-l">
                <GitPanel />
              </aside>
            )}
          </div>
          {terminalOpen && (
            <div className="h-64 shrink-0 border-t">
              <TerminalPanel />
            </div>
          )}
        </div>
      </div>
      <ProjectWizard />
      <SettingsDialog />
      <Toaster />
    </TooltipProvider>
  );
}
