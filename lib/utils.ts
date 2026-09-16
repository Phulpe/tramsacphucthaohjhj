import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * cn() — helper chuẩn của shadcn/ui.
 * Gộp class có điều kiện (clsx) rồi ghi đè class Tailwind trùng nhau (twMerge),
 * nhờ vậy component cha có thể "đè" style của component con một cách sạch sẽ.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
