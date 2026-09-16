import { cn } from '@/lib/utils';

/**
 * TypingIndicator — ba chấm đang "gõ".
 *
 * Chi tiết nhỏ nhưng quan trọng về mặt cảm xúc: khoảng lặng giữa câu hỏi và
 * câu trả lời nếu để trống sẽ giống như bị bỏ rơi. Ba chấm này nói rằng
 * "tớ đang gõ đây, tớ vẫn ở đây".
 */
export function TypingIndicator() {
  return (
    <div
      className="flex items-center gap-1.5 rounded-2xl bg-ink-700 px-4 py-3.5 shadow-soft"
      role="status"
      aria-label="Bestie đang gõ"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn('h-1.5 w-1.5 rounded-full bg-sage/70 animate-dot-pulse')}
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
