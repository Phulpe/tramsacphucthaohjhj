'use client';

import { useEffect, useRef } from 'react';
import type { Message } from 'ai';
import { MessageBubble } from '@/components/message-bubble';
import { TypingIndicator } from '@/components/typing-indicator';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
}

/**
 * MessageList — cuộn & hiển thị cuộc trò chuyện.
 *
 * Hai chi tiết "chữa lành" được xử lý ở đây:
 *  1. Tự cuộn xuống đáy, NHƯNG chỉ khi cậu ấy đang ở gần đáy. Nếu cậu ấy đang
 *     kéo lên đọc lại đoạn cũ, app sẽ không giật màn hình về cuối — bị giật
 *     khi đang đọc lại chuyện buồn là trải nghiệm rất khó chịu.
 *  2. Ba chấm "đang gõ" chỉ hiện khi Bestie chưa nhả ra chữ nào; khi chữ bắt
 *     đầu chảy về thì hiện con trỏ trong bubble thay vì ba chấm.
 */
export function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  // Theo dõi vị trí cuộn để quyết định có tự cuộn hay không.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onScroll() {
      if (!el) return;
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldAutoScroll.current = distanceToBottom < 120;
    }

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Cuộn theo nội dung mới (tin nhắn mới, hoặc token mới trong lúc stream).
  useEffect(() => {
    if (!shouldAutoScroll.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const lastMessage = messages[messages.length - 1];
  const isStreamingLast = isLoading && lastMessage?.role === 'assistant';
  const showTypingDots = isLoading && (!lastMessage || lastMessage.role === 'user');

  return (
    <div
      ref={containerRef}
      className="scrollbar-healing flex-1 space-y-5 overflow-y-auto px-1 py-6"
      aria-live="polite"
      aria-busy={isLoading}
    >
      {messages.map((message, index) => {
        if (message.role !== 'user' && message.role !== 'assistant') return null;

        const isLast = index === messages.length - 1;
        return (
          <MessageBubble
            key={message.id}
            role={message.role}
            content={message.content}
            // Tin cuối của Bestie đang nhận token → hiện con trỏ
            isStreaming={isStreamingLast && isLast && message.content.length > 0}
          />
        );
      })}

      {showTypingDots && (
        <div className="flex items-end gap-2.5 animate-fade-up">
          <div className="mb-1 h-8 w-8 shrink-0" aria-hidden />
          <TypingIndicator />
        </div>
      )}

      <div ref={bottomRef} className="h-1 w-full" aria-hidden />
    </div>
  );
}
