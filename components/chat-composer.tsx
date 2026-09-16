'use client';

import { useEffect, useRef, useState } from 'react';
import { SendHorizontal, Square } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { INPUT_PLACEHOLDER } from '@/lib/system-prompt';

interface ChatComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isLoading: boolean;
  /**
   * Chế độ đang chạy: true = cloud (nội dung đi tới nhà cung cấp model),
   * false/undefined = local (không có gì rời khỏi máy).
   *
   * Dùng để viết đúng sự thật ở dòng ghi chú dưới ô nhập. Trong một ứng dụng
   * tâm sự, nói sai về việc dữ liệu đi đâu là lỗi nghiêm trọng — kể cả khi câu
   * chữ nghe "an toàn" hơn.
   */
  cloud?: boolean;
}

/** Chiều cao tối đa của ô nhập (px) trước khi bật cuộn nội bộ. */
const MAX_TEXTAREA_HEIGHT = 160;

/**
 * ChatComposer — ô nhập liệu.
 *
 * Ba chi tiết được chăm chút:
 *  1. Auto-resize: ô nhập cao dần theo nội dung, tối đa 160px rồi tự cuộn.
 *     Khi đang xả một tràng dài, việc bị "nhét" vào 2 dòng rất bí bách.
 *  2. Enter để gửi, Shift + Enter để xuống dòng — và QUAN TRỌNG: bỏ qua Enter
 *     khi bộ gõ tiếng Việt (Telex/VNI) đang ở trạng thái composition, nếu không
 *     câu đang gõ dở sẽ bị gửi đi mất.
 *  3. Khi Bestie đang trả lời, nút Gửi biến thành nút Dừng — quyền ngắt lời
 *     luôn thuộc về cậu ấy, không phải về model.
 */
export function ChatComposer({ onSend, onStop, isLoading, cloud }: ChatComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Tự co giãn chiều cao theo nội dung.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  function handleSubmit() {
    const text = value.trim();
    if (!text || isLoading) return;
    onSend(text);
    setValue('');
    // Trả focus về ô nhập để không phải bấm lại — nhịp chat không bị ngắt.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  return (
    <div className="border-t border-border/60 bg-ink-900/80 pb-4 pt-3 backdrop-blur-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
        className="flex items-end gap-2"
      >
        <Textarea
          ref={textareaRef}
          value={value}
          rows={1}
          maxLength={4000}
          placeholder={INPUT_PLACEHOLDER}
          aria-label="Ô nhập tin nhắn tâm sự"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // `isComposing` = đang gõ dấu tiếng Việt → đừng gửi.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          className="max-h-40 min-h-[52px] flex-1"
        />

        {isLoading ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onStop}
            className="mb-0.5 h-[52px] w-[52px] rounded-2xl"
            aria-label="Dừng lại, để tớ nói tiếp"
            title="Dừng lại"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={value.trim().length === 0}
            className="mb-0.5 h-[52px] w-[52px] rounded-2xl"
            aria-label="Gửi tin nhắn"
            title="Gửi (Enter)"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        )}
      </form>

      <p className="mt-2 px-1 text-[11px] leading-relaxed text-mist-dim/70">
        {cloud
          ? 'Không lưu trên server · nội dung được gửi tới nhà cung cấp model để sinh câu trả lời · '
          : 'Chuyện ở đây không lưu trên server và không rời khỏi máy cậu · '}
        <span className="text-mist-dim">Enter để gửi, Shift + Enter để xuống dòng</span>
      </p>
    </div>
  );
}
