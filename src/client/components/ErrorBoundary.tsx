import { Component, type ReactNode } from 'react';
import { SelvedgeLockup } from './Logo.js';

/**
 * THE LAST LINE OF DEFENCE AGAINST A WHITE SCREEN.
 *
 * A render error anywhere in a page used to unmount the entire app — nav and
 * all — leaving a blank page with no clue (the Admin field-mismatch bug did
 * exactly that). This turns it into the same kind of surface as a designed
 * empty state: what happened, what is safe, and one thing to do.
 *
 * WHY IT REMOUNTS RATHER THAN RELOADS. `location.reload()` throws away
 * everything — the route you were on, the thread you had open, the sentence
 * half-typed in a composer somewhere else — to fix one broken pane. Clearing
 * the error and re-rendering the children is almost always enough, because
 * most crashes here are one bad shape from one response, and the next fetch
 * gets a good one. A full reload stays available for when it isn't, offered
 * only after the cheap fix has been tried and failed.
 *
 * WHAT IT SAYS AND DOESN'T. The reassurance is specific and true: the work is
 * on the server, not in this tab, so nothing is lost by this. The technical
 * trace is present and closed, because the person who needs it is filing a bug
 * report and the person who doesn't should not have to look at a stack.
 */
type State = { error: Error | null; retried: boolean };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, retried: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, retried: false };
  }

  override componentDidCatch(error: Error): void {
    console.error('pane crashed:', error);
  }

  private retry = (): void => {
    // Remount the children. If the same crash comes straight back, the next
    // render lands here with `retried` already true and the offer changes to
    // the heavier one rather than repeating a fix that didn't work.
    this.setState((s) => ({ error: null, retried: s.error !== null }));
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <SelvedgeLockup tone="chalk" className="h-8 w-auto" />
        <h1 className="mt-6 font-display text-headline text-ink">Something in this pane broke.</h1>
        <p className="mt-2 text-body text-ink-dim">
          Your work is saved on the server — nothing here was lost, and the rest of Selvedge (the watching,
          your projects) is unaffected.{' '}
          {this.state.retried
            ? 'Reloading it once more did not help, so this one needs a full reload.'
            : 'Reloading this pane usually clears it.'}
        </p>

        <button
          onClick={this.state.retried ? () => window.location.reload() : this.retry}
          className="mt-5 rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink transition-opacity duration-settle ease-settle hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright"
        >
          {this.state.retried ? 'Reload the page' : 'Reload this pane'}
        </button>

        {/* Present, closed, and the only technical thing on the screen. It is
            here so a bug report can carry the actual line, not a paraphrase. */}
        <details className="mt-6">
          <summary className="cursor-pointer text-meta text-ink-quiet hover:text-ink-dim">
            the technical detail, for a bug report
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-inset border border-hairline bg-panel-soft px-3 py-2 font-mono text-tech text-ink-quiet">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
        </details>
      </div>
    );
  }
}
