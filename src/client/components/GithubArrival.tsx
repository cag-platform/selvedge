import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * THE GREETING FOR SOMEBODY WHO ARRIVED THROUGH GITHUB.
 *
 * Signing in with GitHub proves where this person builds — so the first
 * screen shouldn't hand them a blank form as if it learned nothing. This card
 * greets them as their GitHub self, shows the repos they push to (the freshest
 * first, as evidence that Selvedge is looking at the right person), and leads
 * into the one step that turns repos into watched projects: installing the
 * GitHub App, where GitHub's own page lists everything — private repos
 * included — and each picked repo becomes a project automatically.
 *
 * IT KNOWS WHEN NOT TO EXIST. Email/Google sign-ins get nothing (the server
 * says `connected: false` and that is a normal answer, not a failure); an
 * account whose App install already sees repos gets nothing (the New-project
 * picker is the right surface once installing is done); and a GitHub outage
 * gets nothing rather than a broken half-card — the page it sits on works
 * whole without it.
 *
 * THE LIST IS PUBLIC REPOS, AND THE COPY SAYS SO. The sign-in token is
 * identity-only, on purpose; a private-repo listing before install would need
 * account-wide `repo` scope, which is the bluntness the App exists to avoid.
 * Saying "private ones appear on the install page" turns the limitation into
 * the instruction.
 */

type Arrival =
  | { connected: false }
  | { connected: true; login: string; repos: Array<{ full_name: string; private: boolean; pushed_at: string | null }> };

const SHOWN = 6;

export function GithubArrival() {
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .get<Arrival>('/api/connectors/github/personal')
      .then(setArrival)
      .catch(() => setArrival({ connected: false }));
    api
      .get<Array<{ full_name: string }>>('/api/connectors/github/repos')
      .then((rows) => setInstalled(rows.length > 0))
      .catch(() => setInstalled(false));
  }, []);

  if (!arrival || !arrival.connected || installed !== false) return null;

  const freshest = arrival.repos.slice(0, SHOWN);

  return (
    <div className="mb-6 space-y-3 rounded-card border border-hairline bg-panel p-5">
      <p className="text-body-lg text-ink">
        You signed in as <span className="font-medium">{arrival.login}</span>, so your apps are one step away.
      </p>
      {freshest.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {freshest.map((repo) => (
            <span key={repo.full_name} className="font-mono text-tech text-meta text-ink-dim">
              {repo.full_name}
            </span>
          ))}
          {arrival.repos.length > SHOWN && (
            <span className="text-meta text-ink-quiet">and {arrival.repos.length - SHOWN} more</span>
          )}
        </div>
      )}
      <p className="text-meta text-ink-dim">
        Install the Selvedge GitHub App and pick the repos to bring in. Each one becomes a project with its own workshop
        and record. GitHub&rsquo;s install page lists everything, private repos included.
      </p>
      <a
        href="/api/connectors/github/install"
        className="inline-block rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
      >
        Choose repos to bring in
      </a>
    </div>
  );
}
