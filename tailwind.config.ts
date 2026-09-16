import type { Config } from 'tailwindcss';

/**
 * Theme "Healing Warm Dark"
 * - Nền:      #121212
 * - Chữ:      #E0E0E0
 * - Accent 1: Sage xanh  #8FBC8F
 * - Accent 2: Vàng ấm    #F4A261
 *
 * Toàn bộ màu được khai báo bằng CSS variable trong app/globals.css,
 * nên bạn chỉ cần đổi biến ở đó là cả app đổi màu theo.
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        // Nền & chữ
        ink: {
          900: 'hsl(var(--ink-900) / <alpha-value>)', // #121212
          800: 'hsl(var(--ink-800) / <alpha-value>)',
          700: 'hsl(var(--ink-700) / <alpha-value>)',
          600: 'hsl(var(--ink-600) / <alpha-value>)',
        },
        mist: {
          DEFAULT: 'hsl(var(--mist) / <alpha-value>)', // #E0E0E0
          soft: 'hsl(var(--mist-soft) / <alpha-value>)',
          dim: 'hsl(var(--mist-dim) / <alpha-value>)',
        },
        // Accent
        sage: {
          DEFAULT: 'hsl(var(--sage) / <alpha-value>)', // #8FBC8F
          soft: 'hsl(var(--sage-soft) / <alpha-value>)',
          deep: 'hsl(var(--sage-deep) / <alpha-value>)',
        },
        amber: {
          DEFAULT: 'hsl(var(--amber) / <alpha-value>)', // #F4A261
          soft: 'hsl(var(--amber-soft) / <alpha-value>)',
        },
        border: 'hsl(var(--border) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      boxShadow: {
        // Shadow mềm, không gắt — cảm giác ấm và dịu
        soft: '0 4px 24px -8px rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.25)',
        glow: '0 0 0 1px hsl(var(--sage) / 0.18), 0 8px 32px -12px hsl(var(--sage) / 0.35)',
        'glow-amber': '0 0 0 1px hsl(var(--amber) / 0.18), 0 8px 32px -12px hsl(var(--amber) / 0.35)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '0.6', transform: 'scale(1.06)' },
        },
        'dot-pulse': {
          '0%, 80%, 100%': { opacity: '0.25', transform: 'translateY(0)' },
          '40%': { opacity: '1', transform: 'translateY(-3px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s ease-out both',
        breathe: 'breathe 7s ease-in-out infinite',
        'dot-pulse': 'dot-pulse 1.1s ease-in-out infinite',
        shimmer: 'shimmer 2.4s linear infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
