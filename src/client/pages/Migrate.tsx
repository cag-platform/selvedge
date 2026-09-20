import { useState } from 'react';
import { ImportReplit } from '../components/ImportReplit.js';
import { Pane } from '../components/ui.js';
import { ImportGithub } from '../components/ImportGithub.js';

/**
 * BRING A PROJECT HOME — two doors, not eight.
 *
 * The old page listed every place an app could live as its own card with its
 * own guide, which dressed one instruction up as six: everything except a
 * Replit export arrives through a GitHub repository. So the page now says
 * exactly that. The builder-specific names still exist — behind one
 * disclosure, as a provenance tag — because "Migration agent · from Cursor"
 * in the intake thread is worth keeping, but they are no longer a decision
 * the visitor must make before anything works.
 */

type GithubSource = 'github' | 'codex' | 'claude-code' | 'cursor' | 'lovable';

const PROVENANCE: Array<{ id: GithubSource; name: string }> = [
  { id: 'cursor', name: 'Cursor' },
  { id: 'lovable', name: 'Lovable' },
  { id: 'codex', name: 'Codex' },
  { id: 'claude-code', name: 'Claude Code' },
];

export function Migrate() {
  const [path, setPath] = useState<'github' | 'replit'>('github');
  const [source, setSource] = useState<GithubSource>('github');

  const tile = (active: boolean) =>
    `rounded-card border px-4 py-3 text-left ${active ? 'border-action bg-sage' : 'border-hairline bg-panel hover:border-action/50'}`;

  return (
    <div className="animate-settle mx-auto max-w-4xl px-5 pb-24 pt-12 sm:px-8 sm:pt-16">
      <header className="max-w-3xl">
        <p className="section-label">Bring your project home</p>
        <h1 className="mt-4 font-display text-[clamp(2.7rem,6vw,4.6rem)] leading-none tracking-[-.045em] text-ink">Where is your app today?</h1>
      </header>

      <div className="mt-8 grid gap-2 sm:grid-cols-2" role="tablist" aria-label="Where the project lives now">
        <button type="button" role="tab" aria-selected={path === 'github'} onClick={() => setPath('github')} className={tile(path === 'github')}>
          <strong className="block text-body text-ink">A GitHub repository</strong>
          <span className="text-meta text-ink-dim">Also anything that can push to one: Bolt, Cursor, Lovable, Base44, and every coding agent.</span>
        </button>
        <button type="button" role="tab" aria-selected={path === 'replit'} onClick={() => setPath('replit')} className={tile(path === 'replit')}>
          <strong className="block text-body text-ink">A Replit app</strong>
          <span className="text-meta text-ink-dim">Upload the export Replit gives you. Selvedge does the rest.</span>
        </button>
      </div>

      <Pane className="mt-6 p-5 sm:p-7">
        <p className="section-label">Migration agent{path === 'github' && source !== 'github' ? ` · from ${PROVENANCE.find((p) => p.id === source)?.name}` : ''}</p>
        <h2 className="mt-2 font-display text-3xl text-ink">I’ll bring the working project over.</h2>
        <p className="mt-2 max-w-2xl text-body text-ink-dim">
          Your original stays live and untouched. Selvedge copies the project, opens a workspace, proves it runs, and only then is
          anything yours to approve.
        </p>

        {path === 'replit' && <div className="mt-6"><ImportReplit /></div>}

        {path === 'github' && (
          <>
            <div className="mt-6"><ImportGithub source={source} /></div>
            <details className="mt-5 rounded-inset border border-hairline bg-panel-soft p-4">
              <summary className="cursor-pointer text-body text-ink">Coming from Bolt, Cursor, Lovable, Base44, or a coding agent?</summary>
              <p className="mt-2 text-body text-ink-dim">
                Export or sync the project to GitHub first — every builder has this in its share or settings menu — then connect the
                repository above. If you tell me where it came from, the migration keeps that context:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {PROVENANCE.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={source === item.id}
                    onClick={() => setSource(source === item.id ? 'github' : item.id)}
                    className={`rounded-full border px-3 py-1.5 text-meta font-medium ${source === item.id ? 'border-action bg-action text-white' : 'border-hairline bg-panel text-ink hover:border-action/50'}`}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </details>
          </>
        )}

        <p className="mt-6 border-t border-hairline pt-4 text-meta text-ink-quiet">
          After handoff, this continues inside the project conversation. Selvedge stops only for access, approval, or a decision it
          cannot safely make for you.
        </p>
      </Pane>
    </div>
  );
}
