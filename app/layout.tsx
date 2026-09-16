import type { Metadata, Viewport } from 'next';
import './globals.css';
import { APP_NAME, APP_OWNERS } from '@/lib/system-prompt';

/**
 * Metadata cho tab trình duyệt và khi share link.
 * Đây là "biển hiệu" của căn phòng — nhìn là biết đây không phải công cụ năng suất.
 */
export const metadata: Metadata = {
  title: `${APP_NAME} của ${APP_OWNERS}`,
  description:
    'Một góc nhỏ để cậu xả hết những điều còn kẹt trong lòng. Không lưu trữ, không theo dõi, không phán xét — chạy bằng model trên máy cậu hoặc qua API cloud do bạn tự cấu hình.',
  applicationName: APP_NAME,
  keywords: ['tâm sự', 'chữa lành', 'healing', 'AI companion', 'Ollama', 'Next.js'],
  authors: [{ name: APP_OWNERS }],
  robots: { index: false, follow: false }, // chuyện riêng tư thì đừng để Google đọc
};

/** Màu thanh trạng thái trên mobile, khớp với nền #121212 của app. */
export const viewport: Viewport = {
  themeColor: '#121212',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        {/*
          Font Be Vietnam Pro: thiết kế riêng cho tiếng Việt, dấu thanh không bị
          lệch. Dùng thẻ <link> thay vì next/font để build không phụ thuộc mạng
          (máy nào offline vẫn build được, tự fallback về font hệ thống).
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router: font áp dụng toàn app qua layout gốc */}
        <link
          href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className="min-h-screen bg-ink-900 font-sans text-mist antialiased"
        style={{ fontFamily: "'Be Vietnam Pro', system-ui, -apple-system, 'Segoe UI', sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
