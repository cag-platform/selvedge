import type { HandoffThread } from '../../src/server/handoff/compose.js';
import type { ContextPack } from '../../src/shared/types/pack.js';
import { makeTestPack } from './testPack.js';

/**
 * A thread with real history — the case a handoff exists for. Eight rounds of
 * work on a live shop: asks, replies, tool activity, a ship, an undo, a failed
 * turn. Deliberately verbose, because the payload's whole claim is that it can
 * stand in for something this long.
 */

export function loomPack(): ContextPack {
  return makeTestPack({
    identity: {
      project_id: 'loom',
      name: 'Loom',
      owner_description: 'A made-to-measure curtain shop. People pick a fabric, give their window measurements, and order.',
      audience: 'People furnishing a house, mostly on phones, mostly in the evening.',
      links: { live_url: 'https://loom.example', repo_url: 'https://github.com/acme/loom' },
    },
    stakes: {
      tier: 'live_critical',
      has_external_users: true,
      touches_money: true,
      user_scale: 'hundreds',
      downtime_translation: 'Nobody can order curtains, and the phone starts ringing.',
    },
    topology: {
      sources: [
        { connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' },
        { connector: 'railway', resource_id: 'proj/env/svc', role: 'production_host' },
      ],
      stack_summary: 'Next.js on Railway, Postgres on Neon, Stripe for payments.',
      capability_gaps: [{ gap: 'error_reporting', summary: 'nothing reports front-end errors yet, so a broken button is invisible' }],
    },
    baselines: {
      deploy_cadence: 'weekly',
      known_flaky: [{ pattern: 'checkout e2e', note: 'the checkout end-to-end test fails about one run in five for timing reasons' }],
    },
  });
}

/** A real agent reply is a paragraph or three, not a sentence — the fixture has to be as long-winded as the thing it stands for. */
const REPLY = [
  'Done — the measurement step now asks for the drop before the width, with the units spelled out next to each box, and it remembers what you typed if you go back a step.',
  'The reason people were putting the width in the drop box is that the two fields looked identical and the drop was second; now the drop is first, labelled "top to bottom", and there is a small diagram beside it.',
  'I moved the validation into one place so the cart and the checkout use exactly the same rules — before this they disagreed, which is why a basket could pass one and fail the other — and I added a test for the empty-cart case, which was the one nobody had covered.',
  'While I was in there I noticed the fabric images were being loaded at full size on phones, several megabytes each, so they are resized now and the page settles much faster on a slow connection.',
  'I have not touched anything to do with payment; that whole area is untouched and still behaves the way it did this morning.',
].join(' ');

/** And a real turn's activity feed is the last thirty lines of tool work the sandbox wrote (build/agent.ts keeps exactly that many), most of it repeated. */
const ACTIVITY = [
  'Searching for "measurement" across the project',
  'Reading src/checkout/Cart.tsx',
  'Reading src/checkout/measurements.ts',
  'Reading src/lib/validation.ts',
  'Editing src/checkout/measurements.ts',
  'Editing src/checkout/Cart.tsx',
  'Running: npm test',
  'Reading src/checkout/__tests__/cart.test.tsx',
  'Editing src/checkout/__tests__/cart.test.tsx',
  'Running: npm test',
  'Editing src/lib/validation.ts',
  'Running: npm test',
  'Editing src/checkout/Cart.tsx',
  'Running: npm test',
  'Reading src/components/FabricImage.tsx',
  'Editing src/components/FabricImage.tsx',
  'Running: npm run build',
  'Running: npm test',
  'Editing src/checkout/Cart.tsx',
  'Running: npm run build',
  'Reading src/checkout/measurements.ts',
  'Editing src/checkout/measurements.ts',
  'Running: npm test',
  'Reading src/app/cart/page.tsx',
  'Editing src/app/cart/page.tsx',
  'Running: npm test',
  'Editing src/lib/validation.ts',
  'Running: npm test',
  'Running: npm run build',
  'Reading src/checkout/Cart.tsx',
].join('\n');

const ASKS = [
  'The measurement step confuses people — they put the width in the drop box. Can you make it clearer?',
  'A customer said the cart emptied itself when she went back to change a fabric. Can you look?',
  'The fabric photos take ages to load on my phone. Anything you can do?',
  'Can we let people save a basket and come back to it later?',
  'The checkout button is a bit small on iPhones.',
  'Someone ordered 3m of a fabric we only stock in 2.4m. Can the form stop that?',
  'Put the delivery estimate next to the price, not at the bottom.',
  'Now make the whole checkout work in one page instead of three.',
];

/**
 * @param rounds how many ask/reply/activity rounds the thread holds
 * @param trailing 'ask' leaves the owner's newest ask unanswered (the mid-task
 *   switch); 'reply' ends on the agent, which is a switch between pieces of work.
 */
export function loomThread(rounds = 8, trailing: 'ask' | 'reply' = 'ask'): HandoffThread {
  const messages: HandoffThread['messages'] = [];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'owner', content: ASKS[i % ASKS.length]! });
    if (i === rounds - 1 && trailing === 'ask') break;
    messages.push({ role: 'activity', content: ACTIVITY });
    messages.push({ role: 'agent', content: REPLY });
  }
  return {
    id: '01J8Z5M9QK7T2R4N6P0V3W1XYZ',
    title: 'Checkout rework',
    kind: 'workshop',
    agent: 'claude-code',
    stagedChangesReady: true,
    messages,
    runs: [
      { kind: 'turn', status: 'succeeded', costCents: 18, changedPaths: ['src/checkout/Cart.tsx', 'src/checkout/measurements.ts'] },
      { kind: 'turn', status: 'succeeded', costCents: 24, changedPaths: ['src/lib/validation.ts'] },
      { kind: 'ship', status: 'succeeded', commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', changedPaths: ['src/checkout/Cart.tsx'] },
      { kind: 'undo', status: 'succeeded' },
      { kind: 'turn', status: 'succeeded', costCents: 31, changedPaths: ['src/components/FabricImage.tsx'] },
    ],
  };
}
