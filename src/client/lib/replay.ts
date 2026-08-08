/**
 * The replay vocabulary — pure view rules for the flight recorder, so how a
 * tool event or a card act reads is testable without a DOM.
 *
 * Register rules (DESIGN-NOTES): this is the technical register — mono type,
 * middot-separated fragments, lowercase, no sentences. Thread/rust is never
 * used here: a failed step is information for the drill-down, not a
 * needs-you signal.
 */

export type ToolEventView = {
  id: string;
  name: string;
  detail: string;
  ok?: boolean;
  note?: string;
};

export type RunRecordView = {
  run_id: string;
  tools: ToolEventView[];
  truncated: boolean;
};

/** One record line: the detail plus an outcome mark only when one is known. */
export function describeToolEvent(e: ToolEventView): string {
  const outcome = e.ok === undefined ? '' : e.ok ? ' · ok' : ` · failed${e.note ? ` — ${e.note}` : ''}`;
  return `${e.detail}${outcome}`;
}

/** The record's one-line summary for the Reveal label's vicinity. */
export function summarizeRecord(record: RunRecordView): string {
  const failed = record.tools.filter((t) => t.ok === false).length;
  const parts = [`${record.tools.length} steps`];
  if (failed > 0) parts.push(`${failed} hit problems`);
  if (record.truncated) parts.push('record truncated');
  return parts.join(' · ');
}

export type ActView = { at: string; kind: string; detail: string; meta?: Record<string, unknown> };

/** A card act as the drill-down shows it — with its embedded tool count when the meta carries one. */
export function describeAct(act: ActView): string {
  const tools = Array.isArray((act.meta as { tools?: unknown[] } | undefined)?.tools)
    ? ((act.meta as { tools: unknown[] }).tools.length as number)
    : 0;
  const suffix = tools > 0 ? ` · ${tools} steps` : '';
  return `${act.kind} — ${act.detail}${suffix}`;
}
