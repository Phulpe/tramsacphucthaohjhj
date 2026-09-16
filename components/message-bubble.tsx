'use client';

import { useState } from 'react';
import { Check, Copy, Sprout } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMessage } from '@/lib/format-message';
import { BESTIE_NAME } from '@/lib/system-prompt';
import { Button } from '@/components/ui/button';

type BubbleRole = 'user' | 'assistant';

interface MessageBubbleProps {
  role: BubbleRole;
  content: string;
  /** true khi đây là tin nhắn đang được stream (chưa kết thúc) */
  isStreaming?: boolean;
}

/**
 * MessageBubble — một câu nói trong cuộc trò chuyện.
 *
 * Quy ước thị giác:
 *   - Bestie (trái): bubble tối, viền nhẹ, avatar mầm cây 🌱, bo góc lớn.
 *   - Người dùng (phải): bubble sage chìm, không avatar (không cần "mặt" của
 *     chính mình — cậu ấy đang ở đây rồi).
 * Cả hai đều rounded-2xl + shadow mềm theo yêu cầu thiết kế.
 */
export function MessageBubble({ role, content, isStreaming = false }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isBestie = role === 'assistant';

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      // 1.6s là đủ để mắt kịp nhận ra, không đủ để thành "thông báo phiền".
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard bị chặn (http, quyền) → im lặng, không làm ồn cuộc trò chuyện.
    }
  }

  return (
    <div
      className={cn(
        'group flex w-full animate-fade-up items-end gap-2.5',
        isBestie ? 'justify-start' : 'justify-end',
      )}
    >
      {isBestie && (
        <div
          className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sage/25 bg-sage/10"
          aria-hidden
        >
          <Sprout className="h-4 w-4 text-sage" />
        </div>
      )}

      <div className={cn('flex max-w-[85%] flex-col sm:max-w-[78%]', isBestie ? 'items-start' : 'items-end')}>
        <div
          className={cn(
            'rounded-2xl px-4 py-3 text-[15px] leading-relaxed shadow-soft',
            isBestie ? 'bubble-bestie text-mist' : 'bubble-me text-mist',
          )}
        >
          <div className="break-words [overflow-wrap:anywhere]">
            {formatMessage(content)}
            {/* Con trỏ nhấp nháy khi đang stream — cảm giác "đang gõ thật" */}
            {isStreaming && (
              <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[2px] animate-pulse bg-sage/80 align-middle" />
            )}
          </div>
        </div>

        {/* Nút copy chỉ hiện khi rê chuột — không chiếm chỗ thị giác */}
        {!isStreaming && content.trim().length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="mt-1 h-7 px-2 text-[11px] text-mist-dim opacity-0 transition-opacity duration-200 focus-visible:opacity-100 group-hover:opacity-100"
            aria-label="Sao chép tin nhắn"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" /> Đã chép
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> Chép
              </>
            )}
          </Button>
        )}

        {/* Nhãn người gửi chỉ xuất hiện ở tin đầu/cuối nhóm để đỡ rối mắt */}
        {isBestie && !isStreaming && (
          <span className="mt-1 px-1 text-[11px] text-mist-dim/70">{BESTIE_NAME}</span>
        )}
      </div>
    </div>
  );
}
