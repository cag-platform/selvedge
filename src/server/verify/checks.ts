import { runCheck as probe, type HealthCheckSpec } from '../monitor/probe.js';
import type { CheckKind, CheckResult } from './verdict.js';

/**
 * The check-generation contract (BUILD-BRIEF Phase 4). Verification needs checks,
 * and most of these apps have no test suite — so checks are generated, not
 * found. This module defines the shape of a generated check (a CheckSpec), a
 * deterministic template path that produces sensible ones from what the pack
 * already knows, and a runner that turns specs into the CheckResults the verdict
 * consumes.
 *
 * The honesty seam is `manual`: a check the template can't run itself (an
 * acceptance assertion that needs the evaluating model to judge) is emitted as
 * `manual` and RUNS as `could_not_run` — never silently a pass. So the template
 * path degrades exactly the way the verdict expects: smoke + regression can be
 * confirmed deterministically, acceptance can't without the model, and a change
 * with no confirmed acceptance lands at `probably`, not `verified`. The model
 * path later replaces the acceptance generation and adds command execution; it
 * plugs into the same spec + runner contract.
 */

export type CheckSpec = {
  kind: CheckKind;
  /** A plain name for the owner-facing explanation. */
  name: string;
  how:
    | { via: 'http'; url: string; expectStatus?: number | null; keyword?: string | null }
    | { via: 'command'; command: string }
    | { via: 'manual'; note: string };
};

export type GenerateInput = {
  /** The app's live URL, for smoke/regression probes. */
  liveUrl?: string | null;
  /** A phrase known to render on the healthy page, so a regression is more than a 200. */
  regressionKeyword?: string | null;
  /** The change the owner asked for, for the acceptance check (model judges it; the template can't). */
  requestText?: string | null;
};

/** Trim a request to a short, plain check name. */
function shortName(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= 60 ? t : `${t.slice(0, 57)}…`;
}

/**
 * The deterministic template: a smoke check if we know where the app lives, a
 * regression check if we also know a phrase that should still render, and an
 * acceptance check as `manual` (the model confirms intent; the template states
 * it plainly and lets it run as could_not_run). Produces no check it can't
 * honestly stand behind — an app with no live URL yields no smoke check, and the
 * verdict then lands at inconclusive, which is correct.
 */
export function generateChecks(input: GenerateInput): CheckSpec[] {
  const specs: CheckSpec[] = [];

  if (input.liveUrl) {
    specs.push({ kind: 'smoke', name: 'the app still responds', how: { via: 'http', url: input.liveUrl, expectStatus: null } });
    if (input.regressionKeyword) {
      specs.push({
        kind: 'regression',
        name: `the page still shows "${input.regressionKeyword}"`,
        how: { via: 'http', url: input.liveUrl, keyword: input.regressionKeyword },
      });
    }
  }

  if (input.requestText && input.requestText.trim() !== '') {
    specs.push({
      kind: 'acceptance',
      name: shortName(input.requestText),
      how: { via: 'manual', note: `Confirm the change did what was asked: ${input.requestText.trim()}` },
    });
  }

  return specs;
}

export type RunCheckDeps = {
  /** Run an HTTP check. Defaults to the monitor's probe. */
  http?: (c: { url: string; expectStatus?: number | null; keyword?: string | null }) => Promise<{ ok: boolean; detail: string | null }>;
  /** Run a command in the sandbox. Injected — absent means command checks can't run. */
  exec?: (command: string) => Promise<{ ok: boolean; detail: string | null }>;
};

async function defaultHttp(c: { url: string; expectStatus?: number | null; keyword?: string | null }): Promise<{ ok: boolean; detail: string | null }> {
  const spec: HealthCheckSpec = {
    kind: c.keyword ? 'keyword' : 'http',
    url: c.url,
    expectedStatus: c.expectStatus ?? null,
    keyword: c.keyword ?? null,
  };
  const r = await probe(spec);
  return { ok: r.up, detail: r.detail };
}

/** Run one spec into a result. `manual`, and `command` with no sandbox, are could_not_run — never a pass. */
export async function runCheckSpec(spec: CheckSpec, deps: RunCheckDeps = {}): Promise<CheckResult> {
  const base = { kind: spec.kind, name: spec.name };

  if (spec.how.via === 'manual') {
    return { ...base, outcome: 'could_not_run', detail: spec.how.note };
  }

  if (spec.how.via === 'http') {
    const http = deps.http ?? defaultHttp;
    try {
      const r = await http({ url: spec.how.url, expectStatus: spec.how.expectStatus, keyword: spec.how.keyword });
      return { ...base, outcome: r.ok ? 'pass' : 'fail', ...(r.detail ? { detail: r.detail } : {}) };
    } catch {
      return { ...base, outcome: 'could_not_run', detail: "couldn't run this check" };
    }
  }

  // command
  if (!deps.exec) return { ...base, outcome: 'could_not_run', detail: 'no sandbox to run this in' };
  try {
    const r = await deps.exec(spec.how.command);
    return { ...base, outcome: r.ok ? 'pass' : 'fail', ...(r.detail ? { detail: r.detail } : {}) };
  } catch {
    return { ...base, outcome: 'could_not_run', detail: 'the check could not run' };
  }
}

/** Run a set of specs. Order-independent; each result stands alone. */
export async function runGeneratedChecks(specs: CheckSpec[], deps: RunCheckDeps = {}): Promise<CheckResult[]> {
  return Promise.all(specs.map((s) => runCheckSpec(s, deps)));
}

/** The template path end to end: generate from what the pack knows, then run. A ready `runChecks` body. */
export async function templateRunChecks(input: GenerateInput, deps: RunCheckDeps = {}): Promise<CheckResult[]> {
  return runGeneratedChecks(generateChecks(input), deps);
}
