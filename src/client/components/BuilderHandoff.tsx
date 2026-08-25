import { agentById } from '../../shared/agents.js';
import type { TechnicalDetail } from '../../shared/technicalDetail.js';

type SwitchRecord = {
  from: string;
  to: string;
  tokens: number | null;
  costUsd: number | null;
};

function switchRecord(meta: unknown): SwitchRecord | null {
  const value = (meta as { switch?: Record<string, unknown> } | null)?.switch;
  if (!value || typeof value.from !== 'string' || typeof value.to !== 'string') return null;
  return {
    from: value.from,
    to: value.to,
    tokens: typeof value.tokens === 'number' && Number.isFinite(value.tokens) ? value.tokens : null,
    costUsd: typeof value.cost_usd === 'number' && Number.isFinite(value.cost_usd) ? value.cost_usd : null,
  };
}

function agentName(id: string): string {
  return agentById(id)?.name ?? id;
}

function tokenLine(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;
}

function costLine(usd: number): string {
  if (usd <= 0) return 'no charge';
  if (usd < 0.0005) return 'less than a tenth of a cent';
  if (usd < 0.01) return `about $${usd.toFixed(3)}`;
  return `about $${usd.toFixed(2)}`;
}

/**
 * A builder handoff is a change in who owns the work, not background activity.
 * Keep it as a divider in the transcript, but give the two builders and the
 * carried context enough hierarchy that the moment cannot disappear into a
 * technical log line.
 */
export function BuilderHandoff({
  content,
  meta,
  detail,
}: {
  content: string;
  meta: unknown;
  detail: TechnicalDetail;
}) {
  const switched = switchRecord(meta);
  // `switch` is also the historical role for a few system/context notes. Only
  // the structured record proves that this row is a builder handoff.
  if (!switched) return <p className="py-work-tight font-mono text-tech text-ink-quiet">{content}</p>;

  const from = agentName(switched.from);
  const to = agentName(switched.to);
  const receipt = [switched.tokens === null ? null : tokenLine(switched.tokens), switched.costUsd === null ? null : costLine(switched.costUsd)]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      role="group"
      aria-label={`Builder changed from ${from} to ${to}. Project context carried over.`}
      className="py-work-tight"
    >
      <div className="flex items-center gap-work-tight" aria-hidden="true">
        <span className="h-px min-w-6 flex-1 bg-hairline" />
        <p className="flex shrink-0 items-center gap-work-tight text-label font-semibold uppercase tracking-widest text-ink-dim">
          <span>{from.toUpperCase()}</span>
          <span className="text-action-bright">→</span>
          <span>{to.toUpperCase()}</span>
        </p>
        <span className="h-px min-w-6 flex-1 bg-hairline" />
      </div>
      <p className="mt-1 text-center text-meta text-ink-dim">Project context carried over</p>
      {detail === 'full' && receipt && (
        <p className="mt-1 text-center font-mono text-tech text-ink-quiet">Handoff · {receipt}</p>
      )}
    </div>
  );
}
