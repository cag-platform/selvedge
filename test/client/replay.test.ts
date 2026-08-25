import { describe, it, expect } from 'vitest';
import {
  describeToolEvent,
  summarizeRecord,
  describeAct,
  simpleActivitySummary,
  technicalActivitySummary,
} from '../../src/client/lib/replay.js';

describe('replay — the technical register, honest about outcomes', () => {
  it('a step with no known outcome claims none — absence is not success', () => {
    expect(describeToolEvent({ id: 't1', name: 'Read', detail: 'Reading src/App.tsx' })).toBe('Reading src/App.tsx');
  });

  it('ok and failed are both said plainly, with the failure reason when known', () => {
    expect(describeToolEvent({ id: 't1', name: 'Bash', detail: 'Running: npm test', ok: true })).toBe('Running: npm test · ok');
    expect(describeToolEvent({ id: 't2', name: 'Bash', detail: 'Running: npm test', ok: false, note: 'FAIL 2 tests' })).toBe(
      'Running: npm test · failed — FAIL 2 tests',
    );
  });

  it('the summary counts problems and admits truncation', () => {
    const tools = [
      { id: '1', name: 'Edit', detail: 'x', ok: true },
      { id: '2', name: 'Bash', detail: 'y', ok: false },
      { id: '3', name: 'Read', detail: 'z' },
    ];
    expect(summarizeRecord({ run_id: 'r', tools, truncated: false })).toBe('3 steps · 1 problem');
    expect(summarizeRecord({ run_id: 'r', tools, truncated: true })).toBe('3 steps · 1 problem · record truncated');
    expect(summarizeRecord({ run_id: 'r', tools: [], truncated: false })).toBe('0 steps');
  });

  it('presents the same activity in full and simple registers without losing the record', () => {
    const record = {
      run_id: 'r',
      tools: [{ id: '1', name: 'Edit', detail: 'Editing src/App.tsx', ok: true }],
      truncated: false,
    };
    const run = { status: 'succeeded', changed_paths: ['src/App.tsx'] };
    expect(simpleActivitySummary(record, run)).toBe('I updated 1 file and checked the work.');
    expect(technicalActivitySummary(record, run)).toBe('1 step · 1 file changed · succeeded');
  });

  it('simple activity admits failure and points to the retained exact error', () => {
    const record = {
      run_id: 'r',
      tools: [{ id: '1', name: 'Bash', detail: 'Running tests', ok: false }],
      truncated: false,
    };
    expect(simpleActivitySummary(record, { status: 'failed', changed_paths: null })).toContain('technical record');
  });

  it('simple activity does not describe running, unknown, or stopped work as checked', () => {
    expect(simpleActivitySummary(null, { status: 'running', changed_paths: null })).toContain('working');
    expect(simpleActivitySummary(null, { status: 'unknown', changed_paths: ['src/App.tsx'] })).toContain('exact steps');
    expect(simpleActivitySummary(null, { status: 'cancelled', changed_paths: ['src/App.tsx'] })).toContain('still in the project');
  });

  it('an act with embedded tools shows the step count; one without shows none', () => {
    expect(describeAct({ at: 't', kind: 'worked', detail: 'Changed the form', meta: { tools: [{}, {}] } })).toBe(
      'worked — Changed the form · 2 steps',
    );
    expect(describeAct({ at: 't', kind: 'proposed', detail: 'A new card' })).toBe('proposed — A new card');
  });
});
