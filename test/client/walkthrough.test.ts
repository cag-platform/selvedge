import { describe, it, expect } from 'vitest';
import { walkthroughSteps } from '../../src/client/lib/walkthrough.js';

describe('walkthrough — derived steps, and compose is never offered into the void', () => {
  it('a brand-new account: nothing done, compose locked', () => {
    const steps = walkthroughSteps({ hasProject: false, fuelConnected: false });
    expect(steps.map((s) => s.done)).toEqual([false, false, false]);
    expect(steps[2]!.offerCompose).toBe(false);
  });

  it('COMPOSE IS NEVER OFFERED WITHOUT A PROJECT — the false-all-clear guard', () => {
    // Composing on an empty org mints a real "quiet night" digest about apps
    // that don't exist. Whatever else is true, this stays locked.
    for (const fuelConnected of [false, true]) {
      const steps = walkthroughSteps({ hasProject: false, fuelConnected });
      expect(steps.find((s) => s.key === 'brief')!.offerCompose).toBe(false);
    }
  });

  it('a project completes step one and unlocks compose', () => {
    const steps = walkthroughSteps({ hasProject: true, firstProjectName: 'Loom', fuelConnected: false });
    expect(steps[0]!.done).toBe(true);
    expect(steps[0]!.title).toBe('Watching Loom');
    expect(steps[2]!.offerCompose).toBe(true);
  });

  it('fuel completes step two, independently of the project step', () => {
    const steps = walkthroughSteps({ hasProject: false, fuelConnected: true });
    expect(steps[1]!.done).toBe(true);
    expect(steps[0]!.done).toBe(false);
  });

  it('the fuel step says it is optional — plainer words, never a nag', () => {
    const steps = walkthroughSteps({ hasProject: true, fuelConnected: false });
    expect(steps[1]!.detail).toMatch(/optional/i);
  });

  it('the brief step is never marked done — a digest existing removes the whole checklist instead', () => {
    for (const hasProject of [false, true]) {
      for (const fuelConnected of [false, true]) {
        const steps = walkthroughSteps({ hasProject, fuelConnected });
        expect(steps.find((s) => s.key === 'brief')!.done).toBe(false);
      }
    }
  });

  it('steps always come in the same order: project, fuel, brief', () => {
    const steps = walkthroughSteps({ hasProject: true, fuelConnected: true });
    expect(steps.map((s) => s.key)).toEqual(['project', 'fuel', 'brief']);
  });
});
