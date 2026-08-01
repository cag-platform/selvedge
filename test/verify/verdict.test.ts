import { describe, it, expect } from 'vitest';
import { computeVerdict, verdictReport, type CheckResult } from '../../src/server/verify/verdict.js';

const smoke = (o: CheckResult['outcome']): CheckResult => ({ kind: 'smoke', name: 'app responds', outcome: o });
const regression = (o: CheckResult['outcome']): CheckResult => ({ kind: 'regression', name: 'checkout still works', outcome: o });
const acceptance = (o: CheckResult['outcome']): CheckResult => ({ kind: 'acceptance', name: 'gift note is optional', outcome: o });

describe('computeVerdict — inflates nothing, lands on "I can\'t tell" when it must', () => {
  it('no checks at all → inconclusive, never verified', () => {
    expect(computeVerdict([])).toBe('inconclusive');
  });

  it('everything passed including acceptance → verified', () => {
    expect(computeVerdict([smoke('pass'), regression('pass'), acceptance('pass')])).toBe('verified');
  });

  it('runs and nothing broke, but the change intent was not confirmed → probably', () => {
    // Net-new work with no acceptance check that could run.
    expect(computeVerdict([smoke('pass'), regression('pass')])).toBe('probably');
    expect(computeVerdict([smoke('pass'), regression('pass'), acceptance('could_not_run')])).toBe('probably');
  });

  it('any failure → didnt_work, and a regression counts as a failure', () => {
    expect(computeVerdict([smoke('pass'), acceptance('fail')])).toBe('didnt_work');
    expect(computeVerdict([smoke('pass'), regression('fail'), acceptance('pass')])).toBe('didnt_work');
    expect(computeVerdict([smoke('fail')])).toBe('didnt_work');
  });

  it('a passing acceptance never overrides a regression failure', () => {
    // The dangerous inflation to guard against: "it does what was asked" while
    // having broken something else. That is didnt_work, not verified.
    expect(computeVerdict([smoke('pass'), regression('fail'), acceptance('pass')])).toBe('didnt_work');
  });

  it('cannot claim above "I can\'t tell" without proof the app still runs', () => {
    // Acceptance "passed" but smoke could not run — we can't even confirm it responds.
    expect(computeVerdict([smoke('could_not_run'), acceptance('pass')])).toBe('inconclusive');
    // No smoke check at all, only a regression pass → still inconclusive.
    expect(computeVerdict([regression('pass')])).toBe('inconclusive');
  });

  it('could_not_run is never silently a pass', () => {
    expect(computeVerdict([smoke('could_not_run'), regression('could_not_run')])).toBe('inconclusive');
  });
});

describe('verdictReport — the plain summary matches the verdict exactly', () => {
  it('every verdict has an honest, matching sentence', () => {
    expect(verdictReport([smoke('pass'), acceptance('pass')]).summary).toMatch(/verified/i);
    expect(verdictReport([smoke('pass')]).summary).toMatch(/probably/i);
    expect(verdictReport([]).summary).toMatch(/can't tell/i);
    expect(verdictReport([smoke('fail')]).summary).toMatch(/didn't work/i);
  });

  it('carries the checks behind it for the technical register', () => {
    const report = verdictReport([smoke('pass'), acceptance('fail')]);
    expect(report.verdict).toBe('didnt_work');
    expect(report.results).toHaveLength(2);
  });
});
