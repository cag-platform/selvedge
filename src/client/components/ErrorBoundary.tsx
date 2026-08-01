import { Component, type ReactNode } from 'react';

/**
 * The last line of defence against a white screen. A render error anywhere in a
 * page used to unmount the entire app — nav and all — leaving a blank page with
 * no clue (the Admin field-mismatch bug did exactly that). Now it becomes a
 * plain, honest card: what happened, the error text for a bug report, and a
 * reload. The rest of Selvedge (the server, the watching) is unaffected and
 * says so.
 */
type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error('page crashed:', error);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-headline font-display text-ink">This page hit a bug.</h1>
        <p className="mt-2 text-body text-ink-dim">
          Something went wrong displaying this screen — the rest of Selvedge (the watching, your apps) is unaffected.
          Reloading usually clears it; if it keeps happening, send me the line below.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-inset border border-hairline bg-panel-soft px-3 py-2 font-mono text-tech text-ink-quiet">
          {this.state.error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          Reload
        </button>
      </div>
    );
  }
}
