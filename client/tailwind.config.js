const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        raised: token('raised'),
        overlay: token('overlay'),
        fg: token('fg'),
        muted: token('muted'),
        faint: token('faint'),
        line: 'rgb(var(--line) / 0.09)',
        'line-strong': 'rgb(var(--line) / 0.17)',
        accent: token('accent'),
        accent2: token('accent2'),
        mint: token('mint'),
        peach: token('peach'),
        rail: token('rail'),
        ok: token('ok'),
        warn: token('warn'),
        bad: token('bad'),
        info: token('info'),
        crew: {
          planner: token('crew-planner'),
          engineer: token('crew-engineer'),
          qa: token('crew-qa'),
          reviewer: token('crew-reviewer'),
          release: token('crew-release'),
        },
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Geist Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['"Iowan Old Style"', '"Palatino Linotype"', 'Palatino', 'Georgia', 'serif'],
        mono: ['"Geist Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.4rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.25rem', { lineHeight: '1.6rem', letterSpacing: '-0.015em' }],
        '2xl': ['1.625rem', { lineHeight: '2rem', letterSpacing: '-0.025em' }],
        '3xl': ['2.125rem', { lineHeight: '2.4rem', letterSpacing: '-0.03em' }],
      },
      borderRadius: { panel: '22px', hero: '30px' },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        pop: 'var(--shadow-pop)',
        lift: 'var(--shadow-lift)',
        glow: '0 0 0 1px rgb(var(--mint) / 0.6), 0 10px 30px -12px rgb(var(--mint) / 0.7)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        sweep: { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
        pulseRing: { '0%': { transform: 'scale(1)', opacity: '0.7' }, '100%': { transform: 'scale(2.4)', opacity: '0' } },
        relay: { '0%': { transform: 'translateX(-30%)' }, '100%': { transform: 'translateX(130%)' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
        sweep: 'sweep 2.4s linear infinite',
        'pulse-ring': 'pulseRing 1.8s cubic-bezier(0.2,0.6,0.3,1) infinite',
        relay: 'relay 2.4s cubic-bezier(0.4,0,0.2,1) infinite',
      },
    },
  },
  plugins: [],
};
