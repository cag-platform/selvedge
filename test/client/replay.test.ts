import { describe, it, expect } from 'vitest';
import { describeToolEvent, summarizeRecord, describeAct } from '../../src/client/lib/replay.js';

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
    expect(summarizeRecord({ run_id: 'r', tools, truncated: false })).toBe('3 steps · 1 hit problems');
    expect(summarizeRecord({ run_id: 'r', tools, truncated: true })).toBe('3 steps · 1 hit problems · record truncated');
    expect(summarizeRecord({ run_id: 'r', tools: [], truncated: false })).toBe('0 steps');
  });

  it('an act with embedded tools shows the step count; one without shows none', () => {
    expect(describeAct({ at: 't', kind: 'worked', detail: 'Changed the form', meta: { tools: [{}, {}] } })).toBe(
      'worked — Changed the form · 2 steps',
    );
    expect(describeAct({ at: 't', kind: 'proposed', detail: 'A new card' })).toBe('proposed — A new card');
  });
});
