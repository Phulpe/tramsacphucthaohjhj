import { ChatApp } from '@/components/chat-app';

/**
 * Trang chủ — chỉ là một Server Component mỏng.
 *
 * Lý do tách như vậy: toàn bộ tương tác (streaming, input, scroll) cần
 * "use client", nên ta gom hết vào <ChatApp />. Trang vẫn được render phía
 * server trước (SSR) nên cậu ấy thấy nội dung ngay, không bị nháy trắng.
 */
export default function HomePage() {
  return (
    <main className="relative z-10 mx-auto flex h-[100dvh] w-full max-w-3xl flex-col px-3 sm:px-6">
      <ChatApp />
    </main>
  );
}
