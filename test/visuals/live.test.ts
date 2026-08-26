import { describe, expect, it } from 'vitest';
import { beginVisualJob, cancelVisualJobs } from '../../src/server/visuals/live.js';

describe('active visual jobs', () => {
  it('stops every parallel interpretation on the thread and leaves other tenants alone', () => {
    const first = beginVisualJob('org_1', 'thread_1');
    const second = beginVisualJob('org_1', 'thread_1');
    const other = beginVisualJob('org_2', 'thread_1');

    expect(cancelVisualJobs('org_1', 'thread_1')).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);

    first.done(); second.done(); other.done();
    expect(cancelVisualJobs('org_1', 'thread_1')).toBe(0);
  });
});
