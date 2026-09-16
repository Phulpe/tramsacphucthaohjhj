'use client';

import { useState } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ErrorNoticeProps {
  /** Thông điệp thân thiện hiển thị trước. */
  message: string;
  /** Chi tiết kỹ thuật (thông điệp gốc) — ẩn sau nút "xem chi tiết". */
  detail?: string;
  /** Gợi ý cách khắc phục, hiển thị ngay dưới thông điệp. */
  hint?: string;
}

/**
 * ErrorNotice — khi có lỗi.
 *
 * Nguyên tắc: không "đổ" stack trace vào mặt người đang cần được an ủi.
 * Hiển thị một câu dịu dàng bằng tiếng Việt, kèm cách xử lý; chi tiết kỹ thuật
 * để trong mục mở rộng dành cho ai thực sự muốn debug.
 */
export function ErrorNotice({ message, detail, hint }: ErrorNoticeProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-1 rounded-2xl border border-amber/25 bg-amber/[0.06] px-4 py-3 text-[13px] text-mist-soft">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="leading-relaxed">{message}</p>
          {hint && <p className="mt-1 leading-relaxed text-mist-dim">{hint}</p>}

          {detail && (
            <>
              <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-mist-dim transition-colors hover:text-mist-soft"
              >
                <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
                {open ? 'Ẩn chi tiết kỹ thuật' : 'Xem chi tiết kỹ thuật'}
              </button>
              {open && (
                <pre className="scrollbar-healing mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-ink-900/70 p-3 font-mono text-[11.5px] text-mist-dim">
                  {detail}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
