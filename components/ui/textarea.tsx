import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Textarea — bản shadcn/ui rút gọn.
 * Không tự động co giãn ở đây; việc auto-resize do ChatComposer quản lý
 * (vì nó cần biết chiều cao tối đa và cuộn nội bộ).
 */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none rounded-2xl border border-border/70 bg-ink-800/80 px-4 py-3 text-[15px] leading-relaxed text-mist placeholder:text-mist-dim/80',
        'scrollbar-healing transition-colors duration-200',
        'focus:border-sage/40 focus:outline-none focus:ring-2 focus:ring-sage/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Textarea };
