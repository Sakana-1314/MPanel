import type { Config } from 'tailwindcss';

/** 语义色以 CSS 变量承载，支持深色（默认）/浅色双主题。 */
function token(variable: string): string {
  return `rgb(var(${variable}) / <alpha-value>)`;
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        app: {
          bg: token('--app-bg'),
          surface: token('--app-surface'),
          elevated: token('--app-elevated'),
          border: token('--app-border'),
          text: token('--app-text'),
          muted: token('--app-muted'),
          accent: token('--app-accent'),
          'accent-strong': token('--app-accent-strong'),
          'accent-soft': token('--app-accent-soft'),
          success: token('--app-success'),
          warning: token('--app-warning'),
          danger: token('--app-danger'),
          info: token('--app-info'),
        },
        // 兼容脚手架早期页面使用的 panel-* 语义名。
        panel: {
          bg: token('--app-bg'),
          surface: token('--app-surface'),
          border: token('--app-border'),
          accent: token('--app-accent'),
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      boxShadow: {
        panel: '0 18px 50px -24px rgb(0 0 0 / 0.55)',
        pop: '0 12px 32px -12px rgb(0 0 0 / 0.55)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-in-bottom': {
          from: { transform: 'translateY(12px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'scale-in': {
          from: { transform: 'scale(0.97)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-in-right': 'slide-in-right 160ms ease-out',
        'slide-in-bottom': 'slide-in-bottom 160ms ease-out',
        'scale-in': 'scale-in 120ms ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
