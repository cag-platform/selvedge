import type { ThreadMessage } from './inbox.js';

/**
 * A consultation is parallel thinking inside an otherwise chronological
 * transcript. We only turn it into a comparison when the stored record proves
 * all four parts are one unit:
 *
 *   owner prompt -> structured two-agent consultation marker -> two signed replies
 *
 * Anything less stays in the normal message stream. In particular, two
 * adjacent signed answers are not enough: they could be ordinary turns from a
 * conversation that changed hands.
 */
export type PairedConsultationItem = {
  kind: 'comparison';
  prompt: ThreadMessage;
  marker: ThreadMessage;
  agents: readonly [string, string];
  answers: readonly [ThreadMessage, ThreadMessage];
};

export type ThreadRenderItem =
  | { kind: 'message'; message: ThreadMessage }
  | PairedConsultationItem;

type ConsultationPair = {
  id: string;
  promptId: string;
  agents: readonly [string, string];
};

function consultedPair(message: ThreadMessage | undefined): ConsultationPair | null {
  if (!message || message.role !== 'switch') return null;
  const meta = message.meta as {
    consulted?: unknown;
    skipped?: unknown;
    consultation_id?: unknown;
    consultation?: { id?: unknown; prompt_id?: unknown; agents?: unknown };
  } | null | undefined;
  const record = meta?.consultation;
  const agents = record?.agents;
  if (!record || !Array.isArray(agents) || agents.length !== 2) return null;

  const [first, second] = agents;
  if (typeof first !== 'string' || first === '' || typeof second !== 'string' || second === '' || first === second) return null;
  if (typeof record.id !== 'string' || record.id === '' || typeof record.prompt_id !== 'string' || record.prompt_id === '') return null;
  if (meta?.consultation_id !== record.id || message.consultation_id !== record.id) return null;

  // The readable legacy field and the correlation record must describe the
  // same pair. A partial write is evidence to stay sequential, not to guess.
  if (!Array.isArray(meta.consulted) || meta.consulted.length !== 2 || meta.consulted[0] !== first || meta.consulted[1] !== second) return null;

  // Conservative by design. A capped request involved more than this pair,
  // even if only two happened to answer, so it belongs in the transcript.
  if (Array.isArray(meta?.skipped) && meta.skipped.length > 0) return null;
  return { id: record.id, promptId: record.prompt_id, agents: [first, second] };
}

function orderedAnswers(
  consultation: ConsultationPair,
  first: ThreadMessage | undefined,
  second: ThreadMessage | undefined,
): readonly [ThreadMessage, ThreadMessage] | null {
  if (!first || first.role !== 'agent' || !second || second.role !== 'agent') return null;
  if (typeof first.answered_by !== 'string' || typeof second.answered_by !== 'string') return null;
  if (first.answered_by === second.answered_by) return null;
  if (
    first.consultation_id !== consultation.id
    || second.consultation_id !== consultation.id
    || first.in_reply_to !== consultation.promptId
    || second.in_reply_to !== consultation.promptId
  ) return null;

  const answers = new Map([
    [first.answered_by, first],
    [second.answered_by, second],
  ]);
  const left = answers.get(consultation.agents[0]);
  const right = answers.get(consultation.agents[1]);
  return left && right ? [left, right] : null;
}

/**
 * Shape only complete, contiguous two-agent consultations for presentation.
 * The answers are ordered by the agents in the consultation marker rather
 * than network arrival, so the left/right comparison stays stable on polls.
 */
export function groupPairedConsultations(messages: readonly ThreadMessage[]): ThreadRenderItem[] {
  const items: ThreadRenderItem[] = [];

  for (let index = 0; index < messages.length;) {
    const prompt = messages[index]!;
    const marker = messages[index + 1];
    const consultation = prompt.role === 'owner' ? consultedPair(marker) : null;
    const correlatedPrompt = consultation
      && prompt.id === consultation.promptId
      && prompt.consultation_id === consultation.id;
    let answerIndex = index + 2;
    // A resolved #reference is another switch row, but it belongs to this
    // exact consultation and should not prevent the two replies being compared.
    while (
      correlatedPrompt
      && messages[answerIndex]?.role === 'switch'
      && messages[answerIndex]?.consultation_id === consultation.id
      && messages[answerIndex]?.in_reply_to === consultation.promptId
    ) answerIndex += 1;
    const answers = consultation && correlatedPrompt
      ? orderedAnswers(consultation, messages[answerIndex], messages[answerIndex + 1])
      : null;
    const allCorrelatedAnswers = consultation
      ? messages.filter((message) => message.role === 'agent' && message.consultation_id === consultation.id)
      : [];

    if (marker && consultation && answers && allCorrelatedAnswers.length === 2) {
      // The prompt and marker remain in chronological order. Only the two
      // parallel answers become one visual comparison.
      items.push({ kind: 'message', message: prompt });
      items.push({ kind: 'message', message: marker });
      for (let noteIndex = index + 2; noteIndex < answerIndex; noteIndex += 1) {
        items.push({ kind: 'message', message: messages[noteIndex]! });
      }
      items.push({ kind: 'comparison', prompt, marker, agents: consultation.agents, answers });
      index = answerIndex + 2;
      continue;
    }

    items.push({ kind: 'message', message: prompt });
    index += 1;
  }

  return items;
}
