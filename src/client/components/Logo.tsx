/**
 * The Selvedge brand marks, inlined so they inherit theme and stay crisp
 * at any size (source: selvedge-logos kit). The mark is the thesis made
 * literal — woven warp threads with one selvedge-red thread (#D2442E, the
 * --thread token) crossed by the weft at the base. `tone` swaps the cloth
 * color (ink navy on light ground, chalk on dark); the red thread never
 * changes — it's the one rationed color.
 */

const THREAD = '#D2442E';
const INK = '#1A1F36'; // brand navy (deeper than --ink; the logo's own value)
const CHALK = '#F3F0E9';

export type LogoTone = 'ink' | 'chalk';

/** The woven mark alone (square). viewBox 0 0 120 120. */
export function SelvedgeMark({ tone = 'ink', className, title = 'Selvedge' }: { tone?: LogoTone; className?: string; title?: string }) {
  const c = tone === 'chalk' ? CHALK : INK;
  return (
    <svg viewBox="0 0 120 120" className={className} role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      <rect x="19" y="20" width="10" height="66" rx="5" fill={c} />
      <rect x="37" y="20" width="10" height="66" rx="5" fill={c} />
      <rect x="55" y="20" width="10" height="66" rx="5" fill={c} />
      <rect x="73" y="20" width="10" height="66" rx="5" fill={THREAD} />
      <rect x="91" y="20" width="10" height="66" rx="5" fill={c} />
      <rect x="18" y="80" width="84" height="8" rx="4" fill={c} />
      <rect x="18" y="92" width="84" height="8" rx="4" fill={c} />
      <rect x="19" y="84" width="10" height="8" rx="5" fill={c} />
      <rect x="55" y="84" width="10" height="8" rx="5" fill={c} />
      <rect x="91" y="84" width="10" height="8" rx="5" fill={c} />
      <rect x="73" y="84" width="10" height="8" rx="5" fill={THREAD} />
      <rect x="73" y="20" width="10" height="64" rx="5" fill={THREAD} />
    </svg>
  );
}

/** Mark + "Se[l]vedge" wordmark, horizontal. viewBox 0 0 580 150. */
export function SelvedgeLockup({ tone = 'ink', className, title = 'Selvedge' }: { tone?: LogoTone; className?: string; title?: string }) {
  const c = tone === 'chalk' ? CHALK : INK;
  return (
    <svg viewBox="0 0 580 150" className={className} role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(8,14) scale(0.92)">
        <rect x="19" y="20" width="10" height="66" rx="5" fill={c} />
        <rect x="37" y="20" width="10" height="66" rx="5" fill={c} />
        <rect x="55" y="20" width="10" height="66" rx="5" fill={c} />
        <rect x="73" y="20" width="10" height="66" rx="5" fill={THREAD} />
        <rect x="91" y="20" width="10" height="66" rx="5" fill={c} />
        <rect x="18" y="80" width="84" height="8" rx="4" fill={c} />
        <rect x="18" y="92" width="84" height="8" rx="4" fill={c} />
        <rect x="19" y="84" width="10" height="8" rx="5" fill={c} />
        <rect x="55" y="84" width="10" height="8" rx="5" fill={c} />
        <rect x="91" y="84" width="10" height="8" rx="5" fill={c} />
        <rect x="73" y="84" width="10" height="8" rx="5" fill={THREAD} />
        <rect x="73" y="20" width="10" height="64" rx="5" fill={THREAD} />
      </g>
      <text y="97" fontFamily="'Inter Tight','Helvetica Neue',Arial,sans-serif" fontWeight={600} fontSize={72} letterSpacing={-1.5}>
        <tspan x="150" fill={c}>Se</tspan>
        <tspan fill={THREAD}>l</tspan>
        <tspan fill={c}>vedge</tspan>
      </text>
    </svg>
  );
}
