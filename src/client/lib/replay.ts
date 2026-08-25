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
  const parts = [`${record.tools.length} step${record.tools.length === 1 ? '' : 's'}`];
  if (failed > 0) parts.push(`${failed} problem${failed === 1 ? '' : 's'}`);
  if (record.truncated) parts.push('record truncated');
  return parts.join(' · ');
}

/**
 * One outcome-first sentence for the simple register. It is derived from the
 * same durable run record as the technical view, so changing register is an
 * instant presentation choice rather than a second, lossy narration pass.
 */
export function simpleActivitySummary(
  record: RunRecordView | null,
  run: { status?: string | null; changed_paths?: string[] | null } | null,
): string {
  const changed = run?.changed_paths?.length ?? 0;
  const failed = record?.tools.some((tool) => tool.ok === false) || run?.status === 'failed';
  const stopped = run?.status === 'cancelled' || run?.status === 'stopped';
  const running = run?.status === 'running';
  if (stopped) return changed > 0 ? 'I stopped here. The changes already made are still in the project.' : 'I stopped this work. Nothing was published.';
  if (running) return 'I’m working through the requested change.';
  if (failed && changed > 0) return `I updated ${changed} file${changed === 1 ? '' : 's'}, but a project check found a problem.`;
  if (failed) return 'A project check found a problem. The technical record has the exact error.';
  if (changed > 0 && run?.status === 'succeeded') return `I updated ${changed} file${changed === 1 ? '' : 's'} and checked the work.`;
  if (changed > 0) return `I updated ${changed} file${changed === 1 ? '' : 's'}. The technical record has the exact steps.`;
  if ((record?.tools.length ?? 0) > 0) return 'I reviewed the project and worked through the requested change.';
  return 'I’m working through the requested change.';
}

/** A compact technical surface; the raw steps stay in the disclosure below. */
export function technicalActivitySummary(
  record: RunRecordView | null,
  run: { status?: string | null; changed_paths?: string[] | null } | null,
): string {
  const parts: string[] = [];
  if (record) parts.push(summarizeRecord(record));
  const changed = run?.changed_paths?.length ?? 0;
  if (changed > 0) parts.push(`${changed} file${changed === 1 ? '' : 's'} changed`);
  if (run?.status) parts.push(run.status);
  return parts.join(' · ') || 'activity in progress';
}

export type ActView = { at: string; kind: string; detail: string; meta?: Record<string, unknown> };

/** A card act as the drill-down shows it — with its embedded tool count when the meta carries one. */
export function describeAct(act: ActView): string {
  const tools = Array.isArray((act.meta as { tools?: unknown[] } | undefined)?.tools)
    ? ((act.meta as { tools: unknown[] }).tools.length as number)
    : 0;
  const suffix = tools > 0 ? ` · ${tools} step${tools === 1 ? '' : 's'}` : '';
  return `${act.kind} — ${act.detail}${suffix}`;
}
