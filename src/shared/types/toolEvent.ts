/**
 * One thing the agent did — the flight recorder's unit of evidence, shared
 * between the server (which parses it out of the CLI's stream-json) and the
 * client (which renders it in the run's full record).
 *
 * BOUNDED BY CONSTRUCTION. A run's record must be storable in one jsonb value
 * and readable in one breath: inputs are trimmed per-field, outcomes to a
 * short note, and a run keeps at most MAX_TOOL_EVENTS events (the container
 * carries a `truncated` flag so a cut record never masquerades as complete).
 * The raw stream-json is deliberately NOT persisted — unbounded, and the
 * sandbox copy dies within minutes anyway. This is the durable evidence.
 */

export type ToolEvent = {
  /** The CLI's tool_use id — pairs the call with its result. */
  id: string;
  name: string;
  /** The owner-readable line ("Editing src/App.tsx") — same prose as the live feed. */
  detail: string;
  /** Bounded extract of the interesting inputs (file_path, command, pattern…). */
  input?: Record<string, string>;
  /** From the paired tool_result: did it work? Absent when no result was seen. */
  ok?: boolean;
  /** Bounded tail of a FAILED result's output — why it failed, in the tool's words. */
  note?: string;
};

/** The activity row's meta payload: the whole run's record, joined to its run. */
export type RunRecord = {
  run_id: string;
  tools: ToolEvent[];
  truncated: boolean;
};

export const MAX_TOOL_EVENTS = 200;
export const MAX_INPUT_CHARS = 2000;
export const MAX_NOTE_CHARS = 500;
