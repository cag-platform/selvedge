/**
 * The getting-started walkthrough — pure view rules, so "when is a step done"
 * and "when may compose be offered" are testable without a DOM.
 *
 * The checklist is Today's no-digest state: it guides until the first brief
 * exists, then never appears again. Step state is DERIVED from data on every
 * render — there is no first-run flag to get stuck, nothing to dismiss, and
 * nothing to un-stick after an export/import.
 *
 * The one safety rule lives here: composing is offered only once a project
 * exists. Composing on an empty org would produce a real "quiet night —
 * nothing needs you" digest about apps that don't exist — a false all-clear,
 * the product's one unforgivable output.
 */

export type WalkthroughInput = {
  hasProject: boolean;
  /** The name of the first project, for the done-state line. */
  firstProjectName?: string;
  fuelConnected: boolean;
};

export type WalkthroughStep = {
  key: 'project' | 'fuel' | 'brief';
  done: boolean;
  title: string;
  detail: string;
  /** Where the step's action lives, when it's a navigation. */
  to?: '/projects' | '/connections';
  /** Whether the compose action may be offered on the brief step. */
  offerCompose?: boolean;
};

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
        title: 'The brief has its voice',
        detail: 'Your model key is connected.',
        to: '/connections',
      }
    : {
        key: 'fuel',
        done: false,
        title: 'Give the brief its voice',
        detail: 'Connect your model key. Optional — the brief still works without it, in plainer words.',
        to: '/connections',
      };

  const brief: WalkthroughStep = input.hasProject
    ? {
        key: 'brief',
        done: false,
        title: 'Your first brief',
        detail: 'It writes itself at your local 7:00am — or now, if you’d like.',
        offerCompose: true,
      }
    : {
        key: 'brief',
        done: false,
        title: 'Your first brief',
        detail: 'Writes itself at your local 7:00am, once there’s something to watch.',
        offerCompose: false,
      };

  return [project, fuel, brief];
}
