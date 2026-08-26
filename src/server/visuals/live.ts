const active = new Map<string, Set<AbortController>>();

const keyOf = (orgId: string, threadId: string) => `${orgId}:${threadId}`;

export function beginVisualJob(orgId: string, threadId: string): { signal: AbortSignal; done: () => void } {
  const key = keyOf(orgId, threadId);
  const controller = new AbortController();
  const jobs = active.get(key) ?? new Set<AbortController>();
  jobs.add(controller);
  active.set(key, jobs);
  return {
    signal: controller.signal,
    done: () => {
      jobs.delete(controller);
      if (!jobs.size) active.delete(key);
    },
  };
}

export function cancelVisualJobs(orgId: string, threadId: string): number {
  const jobs = active.get(keyOf(orgId, threadId));
  if (!jobs) return 0;
  for (const controller of jobs) controller.abort(new Error('Stopped by owner'));
  return jobs.size;
}
