/**
 * The getting-started walkthrough — pure view rules, so "when is a step done"
 * and "when may compose be offered" are testable without a DOM.
 *
 * It guides a new org until the watching is actually on, then never appears
 * again. Step state is DERIVED from data on every render — there is no
 * first-run flag to get stuck, nothing to dismiss, and nothing to un-stick
 * after an export/import.
 *
 * The one safety rule lives here, and it outlived the page it was written for.
 * It used to guard composing a brief: composing on an empty org would produce
 * a real "quiet night — nothing needs you" note about apps that don't exist, a
 * false all-clear, the product's one unforgivable output. The brief is retired
 * and the rule is unchanged in substance — nothing invites you to start work
 * on an org with nothing to work on.
 */

export type WalkthroughInput = {
  hasProject: boolean;
  /** The name of the first project, for the done-state line. */
  firstProjectName?: string;
  fuelConnected: boolean;
};

export type WalkthroughStep = {
  key: 'project' | 'fuel' | 'work';
  done: boolean;
  title: string;
  detail: string;
  /** Where the step's action lives, when it's a navigation. */
  to?: '/projects' | '/admin/connections' | '/inbox';
};

/**
 * When the checklist stops being shown at all. The last step is an invitation
 * rather than a task, so "every step done" would never be true and the
 * checklist would sit there forever — the setup is finished once there is
 * something to watch and something to think with.
 */
export function walkthroughDone(input: WalkthroughInput): boolean {
  return input.hasProject && input.fuelConnected;
}

export function walkthroughSteps(input: WalkthroughInput): WalkthroughStep[] {
  const project: WalkthroughStep = input.hasProject
    ? {
        key: 'project',
        done: true,
        title: input.firstProjectName ? `Watching ${input.firstProjectName}` : 'Your app is connected',
        detail: 'Add more any time from Projects.',
        to: '/projects',
      }
    : {
        key: 'project',
        done: false,
        title: 'Add your first app',
        detail: 'Bring an app you already own — or start a new one.',
        to: '/projects',
      };

  const fuel: WalkthroughStep = input.fuelConnected
    ? {
        key: 'fuel',
        done: true,
        title: 'The agents have their fuel',
        detail: 'Your model key is connected.',
        to: '/admin/connections',
      }
    : {
        key: 'fuel',
        done: false,
        title: 'Give the agents their fuel',
        detail: 'Connect your model key. Optional — the watching still works without it, in plainer words.',
        to: '/admin/connections',
      };

  // Never marked done: starting work is an invitation, not a box to tick.
  // Its ACTION is withheld until there is something to work on — the same
  // guard that used to stop a brief being composed about nothing.
  const work: WalkthroughStep = input.hasProject
    ? {
        key: 'work',
        done: false,
        title: 'Say what you want',
        detail: 'Open the workbench and ask in plain words. Any agent, one conversation.',
        to: '/inbox',
      }
    : {
        key: 'work',
        done: false,
        title: 'Say what you want',
        detail: 'Once there’s an app to work on, the workbench is where you ask.',
      };

  return [project, fuel, work];
}
