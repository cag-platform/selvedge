/**
 * Tailwind mirror of the Selvedge design tokens (src/client/styles/tokens.css
 * is the source of truth — every value here references a CSS custom property,
 * so the tokens file stays the only place a raw value lives).
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/client/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        ink: {
          DEFAULT: 'var(--ink)',
          dim: 'var(--ink-dim)',
          faint: 'var(--ink-faint)',
          quiet: 'var(--ink-quiet)',
        },
        panel: {
          DEFAULT: 'var(--panel)',
          soft: 'var(--panel-soft)',
        },
        hairline: 'var(--hairline)',
        thread: 'var(--thread)',
        brass: 'var(--brass)',
        healthy: 'var(--healthy)',
        action: {
          DEFAULT: 'var(--action)',
          bright: 'var(--action-bright)',
        },
      },
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        label: ['var(--text-label)', { lineHeight: '1.5', letterSpacing: '0.08em' }],
        meta: ['var(--text-meta)', { lineHeight: '1.5' }],
        tech: ['var(--text-tech)', { lineHeight: '1.65' }],
        body: ['var(--text-body)', { lineHeight: '1.6' }],
        'body-lg': ['var(--text-body-lg)', { lineHeight: '1.65' }],
        lede: ['var(--text-lede)', { lineHeight: '1.6' }],
        headline: ['var(--text-headline)', { lineHeight: '1.35' }],
        display: ['var(--text-display)', { lineHeight: '1.3' }],
        section: ['var(--text-section)', { lineHeight: '1.3' }],
        'hero-sub': ['var(--text-hero-sub)', { lineHeight: '1.55' }],
        hero: ['var(--text-hero)', { lineHeight: '1.12' }],
      },
      spacing: {
        read: 'var(--space-read)',
        work: 'var(--space-work)',
        'work-tight': 'var(--space-work-tight)',
        'work-loose': 'var(--space-work-loose)',
      },
      height: {
        'row-work': 'var(--row-work)',
      },
      minHeight: {
        'row-work': 'var(--row-work)',
      },
      width: {
        rail: 'var(--rail-width)',
        context: 'var(--context-width)',
      },
      borderRadius: {
        pane: 'var(--radius-pane)',
        card: 'var(--radius-card)',
        inset: 'var(--radius-inset)',
      },
      transitionTimingFunction: {
        settle: 'var(--settle-ease)',
      },
      transitionDuration: {
        settle: 'var(--settle-duration)',
      },
    },
  },
  plugins: [],
};
