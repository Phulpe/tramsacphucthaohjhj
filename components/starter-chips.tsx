import { Button } from '@/components/ui/button';

interface StarterChipsProps {
  prompts: readonly string[];
  onPick: (text: string) => void;
  disabled?: boolean;
}

/**
 * StarterChips — vài câu mở đầu gợi ý.
 *
 * Nhiều người mở app tâm sự rồi… đóng lại, vì không biết bắt đầu từ đâu.
 * Bấm một cái là câu chuyện tự mở ra, rào cản câu chữ biến mất.
 */
export function StarterChips({ prompts, onPick, disabled = false }: StarterChipsProps) {
  return (
    <div className="flex flex-wrap justify-center gap-2 pb-2">
      {prompts.map((prompt) => (
        <Button
          key={prompt}
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onPick(prompt)}
          className="h-auto max-w-full whitespace-normal rounded-2xl px-3.5 py-2 text-left text-[13px] font-normal text-mist-soft transition-all duration-200 hover:border-sage/35 hover:text-mist disabled:opacity-40"
        >
          {prompt}
        </Button>
      ))}
    </div>
  );
}
