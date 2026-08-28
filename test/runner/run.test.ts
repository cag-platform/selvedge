import { describe, it, expect } from 'vitest';
import { runCard } from '../../src/server/runner/run.js';
import { advance, type CardAction } from '../../src/server/cards/machine.js';
import { proposeCard } from '../../src/server/cards/propose.js';
import type { Card, ChangeSignals } from '../../src/server/cards/types.js';
import type { AgentStepResult, RunnerDeps } from '../../src/server/runner/types.js';

const T = '2026-07-31T12:00:00Z';

function makeCard(o: { signals?: ChangeSignals; capCents?: number; checkpointAtFractions?: number[] } = {}): Card {
  const card = proposeCard({
    id: 'card_1',
    orgId: 'org_1',
    projectId: 'loom',
    trigger: 'request',
    title: 'x',
    proposal: 'x',
    signals: o.signals ?? {},
    estimate: { lowCents: 100, highCents: 500 },
    capCents: o.capCents ?? 100000,
    checkpointAtFractions: o.checkpointAtFractions,
    now: T,
  });
  // Runner starts from an approved (or working) card.
  const approved = advance(card, { type: 'approve', at: T });
  if (!approved.ok) throw new Error('setup: approve failed');
  return approved.card;
}

/**
 * A harness that drives the REAL card machine over an in-memory card (no DB),
 * so the runner is tested against the true cap/checkpoint logic. `steps` scripts
 * the agent; `agentCalls` counts how many iterations actually ran — the key
 * evidence that the runner halts.
 */
function harness(card: Card, steps: AgentStepResult[] | ((step: number) => AgentStepResult), opts: { maxSteps?: number } = {}) {
  let current = card;
  const workspaces: string[] = [];
  const destroyed: string[] = [];
  let agentCalls = 0;

  const deps: RunnerDeps = {
    now: () => new Date(T),
    maxSteps: opts.maxSteps,
    apply: async (action: CardAction) => {
      const r = advance(current, action);
      if (r.ok) current = r.card;
      return r.ok ? { ok: true, card: r.card } : { ok: false, error: r.error };
    },
    workspaceRuntime: {
      createWorkspace: async () => {
        const h = { id: `ws_${workspaces.length + 1}`, state: 'ready' as const };
        workspaces.push(h.id);
        return h;
      },
      destroyWorkspace: async (h) => void destroyed.push(h.id),
    },
    agentStep: async ({ step }) => {
      agentCalls++;
      return typeof steps === 'function' ? steps(step) : (steps[step - 1] ?? { spentCents: 1, done: false });
    },
  };

  return { deps, workspaces, destroyed, get agentCalls() { return agentCalls; }, getCard: () => current };
}

describe('runCard — the work phase, obeying the machine', () => {
  it('happy path: runs steps, finishes, and hands off to verify', async () => {
    const h = harness(makeCard(), [
      { spentCents: 100, done: false, note: 'edited checkout' },
      { spentCents: 150, done: true, note: 'ran tests' },
    ]);
    const res = await runCard(h.deps, h.getCard());
    expect(res.outcome).toBe('ready_to_verify');
    expect(res.card.state).toBe('verifying');
    expect(res.card.spentCents).toBe(250);
    expect(h.destroyed).toEqual(h.workspaces); // workspace released
  });

  it('obeys the cap: a spend that hits the cap halts, and NO further step runs', async () => {
    const h = harness(makeCard({ capCents: 1000 }), () => ({ spentCents: 1200, done: false }));
    const res = await runCard(h.deps, h.getCard());
    expect(res.outcome).toBe('stopped');
    expect(res.card.state).toBe('stopped');
    expect(h.agentCalls).toBe(1); // the loop did not run "one more" step past the cap
    expect(h.destroyed.length).toBe(1); // still torn down
  });

  it('pauses at a staged checkpoint and halts, awaiting the owner', async () => {
    const h = harness(makeCard({ capCents: 10000, checkpointAtFractions: [0.4] }), () => ({ spentCents: 4500, done: false }));
    const res = await runCard(h.deps, h.getCard());
    expect(res.outcome).toBe('checkpoint');
    expect(res.card.state).toBe('blocked');
    expect(h.agentCalls).toBe(1);
    expect(h.destroyed.length).toBe(1);
  });

  it('resumes a working card after the owner continues past a checkpoint', async () => {
    // Script by cumulative call: first iteration crosses the checkpoint, the
    // second (after resume) finishes.
    let calls = 0;
    const h = harness(makeCard({ capCents: 10000, checkpointAtFractions: [0.4] }), () => {
      calls++;
      return calls === 1 ? { spentCents: 4500, done: false } : { spentCents: 100, done: true };
    });
    const paused = await runCard(h.deps, h.getCard());
    expect(paused.outcome).toBe('checkpoint');

    // Owner continues THROUGH the same driver: blocked → working.
    const resumed = await h.deps.apply({ type: 'resume', at: T });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const res2 = await runCard(h.deps, resumed.card);
    expect(res2.outcome).toBe('ready_to_verify');
    expect(res2.card.state).toBe('verifying');
  });

  it('a loop-stall fails the card rather than burning to the cap', async () => {
    const h = harness(makeCard({ capCents: 100000 }), () => ({ spentCents: 1, done: false }), { maxSteps: 3 });
    const res = await runCard(h.deps, h.getCard());
    expect(res.outcome).toBe('failed');
    expect(res.card.state).toBe('failed');
    expect(h.agentCalls).toBe(3);
    expect(res.card.acts.at(-1)!.detail).toMatch(/without finishing/i);
    expect(h.destroyed.length).toBe(1);
  });

  it('an agent crash fails the card and still releases the sandbox', async () => {
    const h = harness(makeCard(), () => {
      throw new Error('sandbox OOM');
    });
    const res = await runCard(h.deps, h.getCard());
    expect(res.outcome).toBe('failed');
    expect(res.card.state).toBe('failed');
    expect(res.card.acts.at(-1)!.detail).toMatch(/sandbox OOM/);
    expect(h.destroyed.length).toBe(1);
  });

  it('a zero-cost finishing step verifies without a spurious spend rejection', async () => {
    const h = harness(makeCard(), [{ spentCents: 0, done: true }]);
    const res = await runCard(h.deps, h.getCard());
    expect(res.outcome).toBe('ready_to_verify');
    expect(res.card.spentCents).toBe(0);
  });

  it('refuses to run a card that is not approved — no workspace, no agent', async () => {
    const proposed = proposeCard({
      id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'x', proposal: 'x',
      signals: {}, estimate: { lowCents: 100, highCents: 500 }, capCents: 1000, now: T,
    });
    const h = harness(proposed, () => ({ spentCents: 1, done: true }));
    const res = await runCard(h.deps, proposed);
    expect(res.outcome).toBe('not_runnable');
    expect(h.workspaces.length).toBe(0);
    expect(h.agentCalls).toBe(0);
  });
});
