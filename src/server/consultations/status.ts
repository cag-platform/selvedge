import type { TaskContextCapsule } from '../../shared/types/contextCapsule.js';

type Message = { id: string; role: string; meta: unknown };

export type ConsultationStatus = {
  id: string;
  prompt_id: string;
  state: 'complete' | 'partial' | 'running';
  answered: string[];
  failed: Array<{ agent: string; code: string | null; retryable: boolean }>;
  waiting: string[];
  evidence: { capsule_id: string | null; changed_files: number; verification_available: boolean; repository_observed: boolean };
  summary: string;
  receipt: { generated_at: string | null; known_facts: number; observed_facts: number; omissions: string[] };
  outcome: string;
};

/** Deterministic status only. It summarizes records; it asks no model for an opinion. */
export function consultationStatuses(messages: readonly Message[]): ConsultationStatus[] {
  return messages.flatMap((marker) => {
    if (marker.role !== 'switch') return [];
    const meta = marker.meta as { consultation?: { id?: unknown; prompt_id?: unknown; agents?: unknown } } | null;
    const record = meta?.consultation;
    if (typeof record?.id !== 'string' || typeof record.prompt_id !== 'string' || !Array.isArray(record.agents)) return [];
    const agents = record.agents.filter((agent): agent is string => typeof agent === 'string');
    const prompt = messages.find((message) => message.id === record.prompt_id);
    const capsule = (prompt?.meta as { context_capsule?: unknown } | null)?.context_capsule as TaskContextCapsule | undefined;
    const answered: string[] = [];
    const failed: ConsultationStatus['failed'] = [];
    const waiting: string[] = [];
    for (const agent of agents) {
      const replies = messages.filter((message) => message.role === 'agent' && (message.meta as { consultation_id?: unknown; answered_by?: unknown } | null)?.consultation_id === record.id
        && (message.meta as { answered_by?: unknown } | null)?.answered_by === agent);
      const latest = replies.at(-1);
      const lane = (latest?.meta as { consultation_lane?: { status?: unknown; failure_code?: unknown; retryable?: unknown } } | null)?.consultation_lane;
      if (lane?.status === 'answered') answered.push(agent);
      else if (lane?.status === 'failed') failed.push({ agent, code: typeof lane.failure_code === 'string' ? lane.failure_code : null, retryable: lane.retryable !== false });
      else if (latest) answered.push(agent); // legacy reply predating explicit lane state
      else waiting.push(agent);
    }
    const state = failed.length ? 'partial' : waiting.length ? 'running' : 'complete';
    const changedFiles = capsule?.observed_now.changed_files.length ?? 0;
    const verification = capsule?.observed_now.latest_verification !== null && capsule?.observed_now.latest_verification !== undefined;
    const repositoryObserved = Boolean(capsule && !capsule.omissions.some((item) => item.item === 'live sandbox worktree'));
    const knownFacts = capsule?.known_already ? Object.values(capsule.known_already).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0) : 0;
    const observedFacts = capsule?.observed_now ? Object.values(capsule.observed_now).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : value ? 1 : 0), 0) : 0;
    const pieces = [
      answered.length ? `${answered.join(', ')} answered` : null,
      failed.length ? `${failed.map((lane) => lane.agent).join(', ')} failed` : null,
      waiting.length ? `${waiting.join(', ')} still running` : null,
      repositoryObserved ? `${changedFiles} changed file${changedFiles === 1 ? '' : 's'} observed` : 'live repository state unavailable',
      verification ? 'verification included' : 'no current verification included',
    ].filter(Boolean);
    const outcome = state === 'complete'
      ? `${answered.length} usable answer${answered.length === 1 ? '' : 's'} returned${repositoryObserved ? ' with live repository evidence' : ' without live repository evidence'}.`
      : state === 'partial'
        ? `${answered.length} usable answer${answered.length === 1 ? '' : 's'} returned; ${failed.length} failed lane${failed.length === 1 ? '' : 's'} remain unresolved. Treat the result as preliminary.`
        : `${answered.length} answer${answered.length === 1 ? '' : 's'} returned so far; ${waiting.length} lane${waiting.length === 1 ? '' : 's'} still running.`;
    return [{ id: record.id, prompt_id: record.prompt_id, state, answered, failed, waiting,
      evidence: { capsule_id: capsule?.capsule_id ?? null, changed_files: changedFiles, verification_available: verification, repository_observed: repositoryObserved },
      receipt: { generated_at: capsule?.generated_at ?? null, known_facts: knownFacts, observed_facts: observedFacts, omissions: capsule?.omissions.map((item) => item.item) ?? ['context capsule unavailable'] },
      summary: pieces.join(' · '), outcome }];
  });
}
