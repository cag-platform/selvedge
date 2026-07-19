import { describe, it, expect } from 'vitest';
import { buildSections, renderDigestText } from '../../src/server/digest/render.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NarrationWithPack } from '../../src/server/digest/order.js';

function item(overrides: Partial<NarrationWithPack> = {}): NarrationWithPack {
  return {
    id: 'n1',
    orgId: 'org_1',
    projectId: 'loom',
    eventId: 'e1',
    eventType: 'build.failed',
    occurredAt: new Date('2026-07-19T10:00:00Z'),
    path: 'TEMPLATE',
    intendedPath: 'TEMPLATE',
    delivery: 'DIGEST',
    kind: 'attention',
    fragment: 'a build failed',
    technicalDetail: null,
    verdict: null,
    storm: false,
    meta: null,
    createdAt: new Date(),
    pack: makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }),
    ...overrides,
  };
}

describe('digest/render', () => {
  it('renders a quiet-day headline when nothing happened', () => {
    const sections = buildSections([], [], [], '', []);
    expect(sections.headline).toMatch(/quiet night/i);
    const text = renderDigestText(sections);
    expect(text).toContain('quiet night');
  });

  it('renders an all-healthy headline with zero attention items but some movement', () => {
    const sections = buildSections([], [item({ kind: 'moved', fragment: 'shipped a thing' })], [], '', []);
    expect(sections.headline).toMatch(/healthy this morning/i);
  });

  it('renders an N-items headline for 1-3 attention items and a TODAY suggestion for exactly one', () => {
    const sections = buildSections([item()], [], [], '', []);
    expect(sections.headline).toBe('1 thing worth a look this morning.');
    expect(sections.today).toMatch(/If you only touch one thing today/);
  });

  it('omits TODAY when there is more than one attention item', () => {
    const sections = buildSections([item({ id: 'n1' }), item({ id: 'n2' })], [], [], '', []);
    expect(sections.today).toBeNull();
  });

  it('enters storm mode above 3 attention items, capping the list and noting the remainder', () => {
    const items = Array.from({ length: 6 }, (_, i) => item({ id: `n${i}` }));
    const sections = buildSections(items, [], [], '', []);
    expect(sections.storm).toBe(true);
    expect(sections.attention).toHaveLength(3);
    expect(sections.headline).toMatch(/Rough night — 6 things need attention/);
    const text = renderDigestText(sections);
    expect(text).toContain('3 more items');
  });

  it('closes a thread from yesterday when its project has no attention item today', () => {
    const sections = buildSections(
      [item({ projectId: 'other' })],
      [],
      [],
      '',
      [{ project_id: 'loom', summary: 'the migration failed', narration_id: 'old' }],
    );
    expect(sections.closedThreads).toEqual(['The issue from yesterday (the migration failed) is resolved.']);
  });

  it('does not close a thread whose project still has an open attention item', () => {
    const sections = buildSections(
      [item({ projectId: 'loom' })],
      [],
      [],
      '',
      [{ project_id: 'loom', summary: 'the migration failed', narration_id: 'old' }],
    );
    expect(sections.closedThreads).toEqual([]);
  });

  it('caps moved items at 5 and standing items at 2', () => {
    const moved = Array.from({ length: 8 }, (_, i) => item({ id: `m${i}`, kind: 'moved' }));
    const standing = ['a', 'b', 'c', 'd'];
    const sections = buildSections([], moved, standing, '', []);
    expect(sections.moved).toHaveLength(5);
    expect(sections.standing).toHaveLength(2);
  });

  it('includes the quiet line in the rendered text when present', () => {
    const sections = buildSections([], [], [], 'Mirror was quiet and healthy.', []);
    expect(renderDigestText(sections)).toContain('Mirror was quiet and healthy.');
  });

  it('labels an org-level (no pack) attention item as Silta', () => {
    const sections = buildSections([item({ pack: null, projectId: null })], [], [], '', []);
    expect(renderDigestText(sections)).toContain('Silta:');
  });
});
