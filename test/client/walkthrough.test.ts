import { describe, it, expect } from 'vitest';
import { walkthroughDone, walkthroughSteps } from '../../src/client/lib/walkthrough.js';

describe('walkthrough — derived steps, and work is never invited into the void', () => {
  it('a brand-new account: nothing done, nowhere to start', () => {
    const steps = walkthroughSteps({ hasProject: false, fuelConnected: false });
    expect(steps.map((s) => s.done)).toEqual([false, false, false]);
    expect(steps[2]!.to).toBeUndefined();
  });

  it('WORK IS NEVER INVITED WITHOUT A PROJECT — the false-all-clear guard', () => {
    // The rule outlived the page it was written for. It used to stop a brief
    // being composed about apps that don't exist; it now stops the checklist
    // pointing at a workbench with nothing to work on.
    for (const fuelConnected of [false, true]) {
      const steps = walkthroughSteps({ hasProject: false, fuelConnected });
      expect(steps.find((s) => s.key === 'work')!.to).toBeUndefined();
    }
  });

  it('a project completes step one and opens the way to the workbench', () => {
    const steps = walkthroughSteps({ hasProject: true, firstProjectName: 'Loom', fuelConnected: false });
    expect(steps[0]!.done).toBe(true);
    expect(steps[0]!.title).toBe('Watching Loom');
    expect(steps[2]!.to).toBe('/inbox');
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

  it('the work step is never marked done — it is an invitation, not a box to tick', () => {
    for (const hasProject of [false, true]) {
      for (const fuelConnected of [false, true]) {
        const steps = walkthroughSteps({ hasProject, fuelConnected });
        expect(steps.find((s) => s.key === 'work')!.done).toBe(false);
      }
    }
  });

  it('steps always come in the same order: project, fuel, work', () => {
    const steps = walkthroughSteps({ hasProject: true, fuelConnected: true });
    expect(steps.map((s) => s.key)).toEqual(['project', 'fuel', 'work']);
  });

  /**
   * The checklist has to be able to go away. Its last step is never done, so
   * "all steps done" would leave it on the page forever.
   */
  it('the checklist finishes when there is something to watch and something to think with', () => {
    expect(walkthroughDone({ hasProject: true, fuelConnected: true })).toBe(true);
    expect(walkthroughDone({ hasProject: true, fuelConnected: false })).toBe(false);
    expect(walkthroughDone({ hasProject: false, fuelConnected: true })).toBe(false);
  });
});
