import { describe, it, expect } from 'vitest';
import { route } from '../../src/server/routing/route.js';
import { findRowById } from '../../src/server/routing/table.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('modifier: known_flaky_downgrade', () => {
  it('forces TEMPLATE and demotes delivery one level on a non-SILENT row', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'build.failed' }, pack, { matchedKnownFlaky: true });
    expect(findRowById('B4').tiers.live_critical).toEqual({ path: 'LLM+VERDICT', delivery: 'PUSH' });
    expect(decision.intended_path).toBe('TEMPLATE');
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('known_flaky_downgrade');
  });

  it('is a no-op on an already-SILENT row', () => {
    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    const decision = route({ event_type: 'build.started' }, pack, { matchedKnownFlaky: true });
    expect(decision.path).toBe('SILENT');
    expect(decision.delivery).toBe('NONE');
    expect(decision.modifiers).not.toContain('known_flaky_downgrade');
  });

  it('does not fire when the flag is unset', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'build.failed' }, pack);
    expect(decision.modifiers).not.toContain('known_flaky_downgrade');
  });
});

describe('modifier: dormancy_upgrade', () => {
  it('upgrades C1 from DIGEST to PUSH on a dormant project', () => {
    const pack = makeTestPack({
      stakes: { tier: 'personal', has_external_users: false, touches_money: false },
      baselines: { deploy_cadence: 'dormant' },
    });
    const decision = route({ event_type: 'runtime.health_failing' }, pack);
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).toContain('dormancy_upgrade');
  });

  it('upgrades C4 from DIGEST to PUSH on a dormant project', () => {
    const pack = makeTestPack({
      stakes: { tier: 'sandbox', has_external_users: false, touches_money: false },
      baselines: { deploy_cadence: 'dormant' },
    });
    const decision = route({ event_type: 'data.migration_failed' }, pack);
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).toContain('dormancy_upgrade');
  });

  it('does not touch rows other than C1/C4', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      baselines: { deploy_cadence: 'dormant' },
    });
    const decision = route({ event_type: 'build.succeeded' }, pack);
    expect(decision.modifiers).not.toContain('dormancy_upgrade');
  });

  it('does not fire when the project is not dormant', () => {
    const pack = makeTestPack({
      stakes: { tier: 'personal', has_external_users: false, touches_money: false },
      baselines: { deploy_cadence: 'weekly' },
    });
    const decision = route({ event_type: 'runtime.health_failing' }, pack);
    expect(decision.modifiers).not.toContain('dormancy_upgrade');
  });

  it('is a no-op when delivery is already PUSH', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      baselines: { deploy_cadence: 'dormant' },
    });
    const decision = route({ event_type: 'runtime.health_failing' }, pack, { currentLocalTime: undefined });
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).not.toContain('dormancy_upgrade');
  });
});

describe('modifier: storm_collapsed', () => {
  it('collapses the 6th+ push-worthy event in a 15-minute window to DIGEST', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'deploy.failed_nothing_serving' }, pack, { recentPushWorthyCount: 5 });
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('storm_collapsed');
  });

  it('does not fire at or under the threshold', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'deploy.failed_nothing_serving' }, pack, { recentPushWorthyCount: 4 });
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).not.toContain('storm_collapsed');
  });

  it('does not fire on a non-PUSH row', () => {
    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    const decision = route({ event_type: 'code.commits_landed_default' }, pack, { recentPushWorthyCount: 10 });
    expect(decision.modifiers).not.toContain('storm_collapsed');
  });
});

describe('modifier: quiet_hours_deferred', () => {
  it('defers a non-⚡ PUSH row inside a same-day quiet window', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything', quiet_hours_local: { start: '09:00', end: '17:00' } } },
    });
    const decision = route({ event_type: 'build.failed' }, pack, { currentLocalTime: '10:30' });
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('quiet_hours_deferred');
  });

  it('defers inside a midnight-wrapping quiet window', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything', quiet_hours_local: { start: '22:00', end: '07:00' } } },
    });
    const decision = route({ event_type: 'build.failed' }, pack, { currentLocalTime: '23:15' });
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('quiet_hours_deferred');
  });

  it('does not defer outside the quiet window', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything', quiet_hours_local: { start: '22:00', end: '07:00' } } },
    });
    const decision = route({ event_type: 'build.failed' }, pack, { currentLocalTime: '12:00' });
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).not.toContain('quiet_hours_deferred');
  });

  it('treats a zero-width window as never-quiet', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything', quiet_hours_local: { start: '09:00', end: '09:00' } } },
    });
    const decision = route({ event_type: 'build.failed' }, pack, { currentLocalTime: '09:00' });
    expect(decision.modifiers).not.toContain('quiet_hours_deferred');
  });

  it('does not defer a ⚡ (quiet_hours_override) row', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything', quiet_hours_local: { start: '00:00', end: '23:59' } } },
    });
    const decision = route({ event_type: 'deploy.failed_nothing_serving' }, pack, { currentLocalTime: '12:00' });
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).not.toContain('quiet_hours_deferred');
  });

  it('is a no-op when the pack has no quiet_hours_local configured', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'build.failed' }, pack, { currentLocalTime: '12:00' });
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).not.toContain('quiet_hours_deferred');
  });

  it('is a no-op when no currentLocalTime is supplied', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { quiet_hours_local: { start: '09:00', end: '17:00' } } },
    });
    const decision = route({ event_type: 'build.failed' }, pack);
    expect(decision.delivery).toBe('PUSH');
  });

  it('is a no-op on a non-PUSH row', () => {
    const pack = makeTestPack({
      stakes: { tier: 'sandbox', has_external_users: false, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { quiet_hours_local: { start: '09:00', end: '17:00' } } },
    });
    const decision = route({ event_type: 'code.pr_opened' }, pack, { currentLocalTime: '10:00' });
    expect(decision.delivery).toBe('DIGEST');
  });
});

describe('modifier: push_threshold cap', () => {
  it('never caps PUSH down to DIGEST — "a never project can\'t push, period"', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'never' } },
    });
    const decision = route({ event_type: 'deploy.failed_nothing_serving' }, pack);
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('push_threshold_never');
  });

  it('critical_only downgrades a non-critical, non-⚡ PUSH row', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'critical_only' } },
    });
    const decision = route({ event_type: 'build.failed' }, pack);
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('push_threshold_critical_only');
  });

  it('critical_only allows a ⚡ row through', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'critical_only' } },
    });
    const decision = route({ event_type: 'deploy.failed_nothing_serving' }, pack);
    expect(decision.delivery).toBe('PUSH');
  });

  it('critical_only allows C1/C4/C6 through even without ⚡', () => {
    const pack = makeTestPack({
      stakes: { tier: 'personal', has_external_users: false, touches_money: false },
      baselines: { deploy_cadence: 'dormant' },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'critical_only' } },
    });
    // dormancy_upgrade takes C4 personal from DIGEST -> PUSH; critical_only must let it through.
    const decision = route({ event_type: 'data.migration_failed' }, pack);
    expect(decision.delivery).toBe('PUSH');
  });

  it('failures caps a non-failure row (C2/D1/D2) even though the table says PUSH', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'failures' } },
    });
    const decision = route({ event_type: 'runtime.recovered' }, pack, { pairedOutagePushed: true });
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('push_threshold_failures_only');
  });

  it('failures leaves a genuine failure row alone', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'failures' } },
    });
    const decision = route({ event_type: 'build.failed' }, pack);
    expect(decision.delivery).toBe('PUSH');
  });

  it('everything applies no cap at all', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything' } },
    });
    const decision = route({ event_type: 'build.failed' }, pack);
    expect(decision.delivery).toBe('PUSH');
  });

  it('defaults to "failures" behavior when push_threshold is unset', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'build.failed' }, pack);
    expect(decision.delivery).toBe('PUSH');
  });

  it('is a no-op on a non-PUSH row', () => {
    const pack = makeTestPack({
      stakes: { tier: 'sandbox', has_external_users: false, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'never' } },
    });
    const decision = route({ event_type: 'code.pr_opened' }, pack);
    expect(decision.delivery).toBe('DIGEST');
  });
});

describe('row rule: C2 recovery requires its paired outage to have pushed', () => {
  it('downgrades to DIGEST when the outage did not push', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'runtime.recovered' }, pack);
    expect(decision.delivery).toBe('DIGEST');
    expect(decision.modifiers).toContain('recovery_requires_paired_push');
  });

  it('pushes when the outage did push', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything' } },
    });
    const decision = route({ event_type: 'runtime.recovered' }, pack, { pairedOutagePushed: true });
    expect(decision.delivery).toBe('PUSH');
    expect(decision.modifiers).not.toContain('recovery_requires_paired_push');
  });
});

describe('table helper: findRowById', () => {
  it('finds a standing (G-group) row by id', () => {
    expect(findRowById('G1').label).toMatch(/capability_gaps/);
  });

  it('throws for an unknown id', () => {
    expect(() => findRowById('Z99')).toThrow(/No routing-table.json row with id/);
  });
});
