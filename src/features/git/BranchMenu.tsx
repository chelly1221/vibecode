import { useState } from "react";
import { Check, GitBranch, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGitStore } from "@/stores/git";

/** Current branch dropdown: switch between local branches or create a new one. */
export function BranchMenu() {
  const status = useGitStore((s) => s.status);
  const branches = useGitStore((s) => s.branches);
  const busy = useGitStore((s) => s.busy);
  const checkout = useGitStore((s) => s.checkout);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const local = branches.filter((b) => !b.remote);
  const current = status?.branch ?? local.find((b) => b.current)?.name ?? "(분리됨)";

  const switchTo = async (name: string, create: boolean) => {
    try {
      await checkout(name, create);
      toast.success(`${name} 브랜치로 전환했습니다.`);
      setCreateOpen(false);
      setNewName("");
    } catch (e) {
      toast.error(`브랜치 전환 실패: ${e}`);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="max-w-40 gap-1.5" disabled={busy !== null}>
            <GitBranch />
            <span className="truncate font-mono text-xs">{current}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>브랜치</DropdownMenuLabel>
          {local.length === 0 && <DropdownMenuItem disabled>브랜치 없음</DropdownMenuItem>}
          {local.map((b) => (
            <DropdownMenuItem key={b.name} onClick={() => !b.current && switchTo(b.name, false)} className="font-mono text-xs">
              <Check className={b.current ? "opacity-100" : "opacity-0"} /> {b.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus /> 새 브랜치…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 브랜치</DialogTitle>
            <DialogDescription>현재 브랜치({current})에서 새 브랜치를 만들고 전환합니다.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="new-branch">브랜치 이름</Label>
            <Input
              id="new-branch"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="feature/login"
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) void switchTo(newName.trim(), true);
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              취소
            </Button>
            <Button disabled={!newName.trim() || /\s/.test(newName)} onClick={() => switchTo(newName.trim(), true)}>
              만들기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
