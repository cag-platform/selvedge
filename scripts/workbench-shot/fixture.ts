/**
 * The screenshot's world: six projects and thirty threads, the scale the
 * design notes' third acceptance check names. Exactly one project needs the
 * owner, because that is the whole point of the check — red appears only when
 * something genuinely needs you.
 */
const PROJECT_NAMES = ['Loom', 'Ravel', 'Warp & Weft', 'Bobbin', 'Selvage Shop', 'Heddle'];
const TITLES = [
  'Checkout rework',
  'Why is the basket emptying?',
  'Fabric photos on phones',
  'Saved baskets',
  'Delivery estimate placement',
  'Should we do subscriptions?',
  'One-page checkout',
];
const STATUSES = ['needs', 'working', 'healthy', 'healthy', 'unknown', 'healthy'] as const;
const HEALTH = [
  'Orders are failing at checkout — two runs in a row.',
  'A change is landing now.',
  'Everything users touch is healthy.',
  'Everything users touch is healthy.',
  "I can't see this one at the moment.",
  'Everything users touch is healthy.',
];

export function inboxFixture() {
  const projects = PROJECT_NAMES.map((name, p) => ({
    id: `p${p}`,
    name,
    status: STATUSES[p],
    health: HEALTH[p],
    threads: Array.from({ length: 5 }, (_, t) => ({
      id: `p${p}t${t}`,
      kind: t % 3 === 2 ? 'general' : 'workshop',
      title: TITLES[(p + t) % TITLES.length],
      agent: t % 3 === 2 ? 'claude' : t % 4 === 1 ? 'codex' : 'claude-code',
      chip: t % 3 === 2 ? 'CL' : t % 4 === 1 ? 'CX' : 'CC',
      working: p === 1 && t === 0,
      last_at: new Date(Date.UTC(2026, 7, 20 - p, 12 - t)).toISOString(),
    })),
  }));
  return {
    projects,
    brief: { date: '2026-08-20', headline: 'One thing worth a look this morning.' },
    unsorted_count: 2,
    engine_on: true,
  };
}

export function threadFixture() {
  return {
    thread: { id: 'p0t0', kind: 'workshop', title: 'Checkout rework', agent: 'codex', model: 'gpt-5.6-terra', created_at: '2026-08-01T09:00:00Z', archived: false },
    project: { id: 'p0', name: 'Loom' },
    live_url: 'https://loom.example',
    engine_on: true,
    working: false,
    staged_changes_ready: true,
    sandbox: 'attached',
    handoff_waiting: false,
    cost_cents: 173,
    messages: [
      { id: 'm1', role: 'owner', content: 'A customer said the basket emptied itself when she went back to change a fabric. Can you look?', at: '2026-08-20T09:00:00Z', attachments: [] },
      {
        id: 'm2',
        role: 'activity',
        content: 'Reading src/checkout/Cart.tsx\nEditing src/checkout/Cart.tsx\nRunning: npm test',
        at: '2026-08-20T09:02:00Z',
        attachments: [],
        run_id: 'r1',
        meta: { run_id: 'r1', truncated: false, tools: [{ id: 't1', name: 'Edit', detail: 'Editing src/checkout/Cart.tsx', ok: true }] },
      },
      { id: 'm3', role: 'agent', content: 'The cart and the checkout were validating baskets differently, so going back could clear it. They now use one set of rules, and I added a test for the empty-basket case.', at: '2026-08-20T09:08:00Z', attachments: [] },
      {
        id: 'm4',
        role: 'switch',
        content: '⇄ continued with Codex — handoff 1.8k tokens, about $0.004',
        at: '2026-08-20T09:20:00Z',
        attachments: [],
        meta: { switch: { from: 'claude-code', to: 'codex', tokens: 1834, cost_usd: 0.0037 } },
      },
      { id: 'm5', role: 'owner', content: 'Now make the whole checkout work in one page instead of three.', at: '2026-08-20T09:21:00Z', attachments: [] },
    ],
    runs: [
      { id: 'r1', status: 'succeeded', cost_cents: 24, commit: null, kind: 'turn', at: '2026-08-20T09:08:00Z', agent: 'claude-code', model: 'sonnet', changed_paths: ['src/checkout/Cart.tsx'] },
      { id: 'r0', status: 'succeeded', cost_cents: 0, commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', kind: 'ship', at: '2026-08-19T17:00:00Z', agent: 'claude-code', model: null, changed_paths: ['src/checkout/Cart.tsx'] },
    ],
  };
}

export const cardsFixture = { cards: [] };
