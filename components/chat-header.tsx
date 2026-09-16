'use client';

import { Cloud, HeartPulse, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { APP_NAME, APP_OWNERS } from '@/lib/system-prompt';

/**
 * Tình trạng "bộ não" hiển thị trên header.
 *
 * `state` ở đây đã được RÚT GỌN so với API: server trả về nhiều trạng thái chi
 * tiết hơn (missing-key, unauthorized, model-missing…), nhưng trên UI chỉ cần
 * biết "dùng được hay không" — còn lý do cụ thể thì hiển thị trong thông báo lỗi
 * khi người dùng thực sự gửi tin nhắn.
 */
export type LlmStatus = {
  state: 'checking' | 'ready' | 'offline';
  model?: string;
  /** Nhãn nhà cung cấp, ví dụ "Groq (cloud)" hoặc "Ollama (local)". */
  providerLabel?: string;
  /** true = nội dung người dùng đi qua dịch vụ cloud (không còn 100% cục bộ). */
  cloud?: boolean;
  /** Lý do kỹ thuật (dùng cho tooltip, không hiển thị to). */
  detail?: string;
};

interface ChatHeaderProps {
  status: LlmStatus;
  onReset: () => void;
  canReset: boolean;
}

const STATUS_STYLE: Record<LlmStatus['state'], { dot: string; label: string }> = {
  checking: { dot: 'bg-amber/70 animate-pulse', label: 'đang tìm Bestie…' },
  ready: { dot: 'bg-sage', label: 'đang ở đây' },
  offline: { dot: 'bg-red-400/80', label: 'chưa kết nối được' },
};

/**
 * ChatHeader — "biển hiệu" phía trên cuộc trò chuyện.
 *
 * Chấm trạng thái là thông tin CÓ THẬT (gọi /api/health), không phải trang trí:
 * - Với bản chạy local, nó cho biết Ollama đã bật chưa.
 * - Với bản trên cloud, nó cho biết API key còn dùng được không.
 * Ngoài ra nhãn "local/cloud" cho người dùng biết dữ liệu của họ đang đi đâu —
 * đây là điều tối thiểu phải minh bạch trong một ứng dụng tâm sự.
 */
export function ChatHeader({ status, onReset, canReset }: ChatHeaderProps) {
  const style = STATUS_STYLE[status.state];

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border/60 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sage/20 bg-sage/10 shadow-glow"
          aria-hidden
        >
          <HeartPulse className="h-5 w-5 text-sage" />
        </div>

        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-medium leading-tight text-mist">
            {APP_NAME} <span className="font-normal text-mist-dim">của {APP_OWNERS}</span>
          </h1>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-mist-dim">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', style.dot)} aria-hidden />
            <span className="truncate">
              {style.label}
              {status.state === 'ready' && status.model ? ` · ${status.model}` : ''}
            </span>

            {/* Nhãn minh bạch dữ liệu: local (không rời máy) hay cloud (có đi ra ngoài) */}
            {status.cloud !== undefined && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-none',
                  status.cloud
                    ? 'border-amber/25 text-amber-soft'
                    : 'border-sage/25 text-sage-soft',
                )}
                title={
                  status.cloud
                    ? `Nội dung tâm sự được gửi tới ${status.providerLabel ?? 'dịch vụ cloud'} để sinh câu trả lời. Nhà cung cấp có thể lưu log theo chính sách của họ.`
                    : 'Model chạy ngay trên máy bạn. Không có nội dung nào rời khỏi thiết bị.'
                }
              >
                {status.cloud && <Cloud className="h-2.5 w-2.5" aria-hidden />}
                {status.cloud ? (status.providerLabel ?? 'cloud') : 'local · riêng tư'}
              </span>
            )}
          </p>
        </div>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onReset}
        disabled={!canReset}
        className="shrink-0 text-mist-dim hover:text-mist"
        title="Bắt đầu một cuộc trò chuyện mới (xoá hết tin nhắn hiện tại)"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Bắt đầu lại</span>
      </Button>
    </header>
  );
}
