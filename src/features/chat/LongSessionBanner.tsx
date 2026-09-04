// Shown above the composer once a session has accumulated many questions:
// long conversations re-send the whole context every turn, so a fresh session saves tokens.
import { MessageSquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  count: number;
  onNewSession: () => void;
  onDismiss: () => void;
}

export function LongSessionBanner({ count, onNewSession, onDismiss }: Props) {
  return (
    <div className="border-t bg-sky-500/5 px-4 py-2">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 text-xs">
        <span className="text-foreground">
          이 대화에서 질문이 {count}번을 넘었습니다. 대화가 길어질수록 매 턴마다 더 많은 토큰을 쓰므로, 토큰 절약을 위해 새 대화를 시작하는 것을 권장합니다.
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={onNewSession}>
            <MessageSquarePlus className="size-4" /> 새 세션 시작
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="그만 보기">
            <X className="size-4" /> 그만 보기
          </Button>
        </div>
      </div>
    </div>
  );
}
