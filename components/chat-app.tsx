'use client';

import { useCallback, useEffect, useState } from 'react';
import { useChat } from 'ai/react';
import type { Message } from 'ai';
import { STARTER_PROMPTS, WELCOME_MESSAGE } from '@/lib/system-prompt';
import { ChatHeader, type LlmStatus } from '@/components/chat-header';
import { ChatComposer } from '@/components/chat-composer';
import { ErrorNotice } from '@/components/error-notice';
import { MessageList } from '@/components/message-list';
import { StarterChips } from '@/components/starter-chips';

/** id cố định cho tin nhắn chào — để React không re-mount khi reset. */
const WELCOME_ID = 'bestie-welcome';

/** Cuộc trò chuyện luôn bắt đầu bằng lời chào, không phải màn hình trắng. */
const WELCOME_MESSAGE_ITEM: Message = {
  id: WELCOME_ID,
  role: 'assistant',
  content: WELCOME_MESSAGE,
};

interface Notice {
  message: string;
  hint?: string;
  detail?: string;
}

/** Hình dạng phản hồi của /api/health (chỉ những field UI cần). */
interface HealthResponse {
  ok: boolean;
  state?: string;
  model?: string;
  providerLabel?: string;
  cloud?: boolean;
  message?: string;
}

/**
 * ============================================================================
 *  ChatApp — nơi mọi thứ được ghép lại
 * ============================================================================
 *
 *  Trách nhiệm:
 *    - Gọi /api/chat qua useChat của Vercel AI SDK và nhận stream về.
 *    - Hỏi /api/health để biết "bộ não" đã sẵn sàng chưa (chấm trạng thái).
 *    - Biến mọi lỗi kỹ thuật thành một câu nói tử tế dành cho người dùng.
 *
 *  Frontend KHÔNG cần biết đang chạy Ollama hay Groq/OpenRouter: mọi khác biệt
 *  được xử lý ở server. Nhờ vậy cùng một giao diện chạy đúng ở cả hai môi trường.
 *
 *  Lưu ý về quyền riêng tư: KHÔNG có localStorage, KHÔNG có database. Cuộc trò
 *  chuyện chỉ tồn tại trong bộ nhớ của tab trình duyệt này; tải lại trang là mọi
 *  thứ được trả về cho sự riêng tư của cậu ấy. (Lưu ý riêng cho bản cloud: nội
 *  dung tin nhắn vẫn được gửi tới nhà cung cấp model để sinh câu trả lời — điều
 *  này được nói rõ trên header bằng nhãn "cloud".)
 */
export function ChatApp() {
  const [status, setStatus] = useState<LlmStatus>({ state: 'checking' });
  const [notice, setNotice] = useState<Notice | null>(null);

  /**
   * Hỏi thăm tình trạng của "bộ não".
   * `force` = bỏ qua cache 20 giây ở server, dùng khi người dùng vừa gặp lỗi và
   * ta muốn biết ngay tình hình mới nhất.
   */
  const refreshStatus = useCallback(async (force = false) => {
    try {
      const response = await fetch(`/api/health${force ? '?force=1' : ''}`, {
        cache: 'no-store',
      });
      const data = (await response.json()) as HealthResponse;

      setStatus(
        data.ok
          ? {
              state: 'ready',
              model: data.model,
              providerLabel: data.providerLabel,
              cloud: data.cloud,
            }
          : {
              state: 'offline',
              model: data.model,
              providerLabel: data.providerLabel,
              cloud: data.cloud,
              detail: data.message,
            },
      );
    } catch {
      setStatus({ state: 'offline' });
    }
  }, []);

  // Kiểm tra ngay khi mở app, rồi lặp lại mỗi 30 giây.
  // Người dùng thường bật Ollama (hoặc thêm API key) SAU khi mở web — ta cần tự
  // phát hiện lại mà không bắt họ tải lại trang.
  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 30_000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  /**
   * fetch tuỳ biến cho useChat.
   *
   * useChat mặc định sẽ ném "Failed to fetch" hoặc JSON thô. Ta chặn ở đây để
   * đọc lỗi thân thiện do server trả về (server đã biết đang lỗi vì thiếu key,
   * sai key, hay mất mạng — nên server mới là nơi viết lời nhắn).
   */
  const chatFetch: typeof fetch = useCallback(
    async (input, init) => {
      const response = await fetch(input, init);

      if (!response.ok) {
        // `clone()` để không "uống" mất body — useChat vẫn cần nó.
        const cloned = response.clone();

        let friendly = 'Có chút trục trặc khi tớ đang lắng nghe. Cậu thử lại giúp tớ nhé.';
        let hint: string | undefined;
        let detail: string | undefined;

        try {
          const data = (await cloned.json()) as {
            error?: string;
            hint?: string;
            detail?: string;
          };
          friendly = data.error ?? friendly;
          hint = data.hint;
          detail = data.detail;
        } catch {
          detail = await cloned.text().catch(() => undefined);
        }

        setNotice({ message: friendly, hint, detail });
        void refreshStatus(true); // cập nhật chấm trạng thái ngay lập tức
      }

      return response;
    },
    [refreshStatus],
  );

  const { messages, append, isLoading, stop, error, setMessages } = useChat({
    api: '/api/chat',
    initialMessages: [WELCOME_MESSAGE_ITEM],
    fetch: chatFetch,
    // Gửi kèm id/role để server có đủ ngữ cảnh (đã được làm sạch ở server).
    sendExtraMessageFields: true,
    // Gộp cập nhật token ~40ms/lần: chữ hiện ra vẫn mượt mà đỡ re-render.
    experimental_throttle: 40,
    onResponse: () => setNotice(null), // có phản hồi tốt → xoá thông báo cũ
    onFinish: () => void refreshStatus(),
    onError: (err) => {
      // Chỉ hiển thị nếu chatFetch chưa kịp tạo thông báo thân thiện.
      setNotice((prev) =>
        prev ?? {
          message: 'Tớ bị mất kết nối giữa chừng. Cậu nhắn lại giúp tớ nhé.',
          detail: err.message,
        },
      );
      void refreshStatus(true);
    },
  });

  /** Gửi một câu tâm sự lên Bestie. */
  const handleSend = useCallback(
    (text: string) => {
      setNotice(null);
      void append({ role: 'user', content: text });
    },
    [append],
  );

  /** Xoá cuộc trò chuyện hiện tại, quay về lời chào đầu tiên. */
  const handleReset = useCallback(() => {
    stop();
    setMessages([WELCOME_MESSAGE_ITEM]);
    setNotice(null);
    void refreshStatus(true);
  }, [setMessages, stop, refreshStatus]);

  // Đã có tin nhắn của người dùng chưa? (để ẩn/hiện các gợi ý mở đầu)
  const hasUserMessage = messages.some((message) => message.role === 'user');

  return (
    <div className="ambient-room flex h-full flex-col">
      <ChatHeader
        status={status}
        onReset={handleReset}
        canReset={messages.length > 1 || isLoading}
      />

      <MessageList messages={messages} isLoading={isLoading} />

      <div className="space-y-3">
        {notice && (
          <ErrorNotice message={notice.message} hint={notice.hint} detail={notice.detail} />
        )}

        {error && !notice && (
          <ErrorNotice
            message="Tớ bị mất kết nối giữa chừng. Cậu nhắn lại giúp tớ nhé."
            detail={error.message}
          />
        )}

        {/* Gợi ý mở đầu chỉ hiện khi chưa có gì để kể — sau đó thì biến mất. */}
        {!hasUserMessage && (
          <StarterChips prompts={STARTER_PROMPTS} onPick={handleSend} disabled={isLoading} />
        )}

        <ChatComposer
          onSend={handleSend}
          onStop={stop}
          isLoading={isLoading}
          cloud={status.cloud}
        />
      </div>
    </div>
  );
}
