import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ImportReplit } from '../components/ImportReplit.js';
import { Pane } from '../components/ui.js';
import type { MigrationSource } from '../../shared/types/migration.js';

const sources: Array<{ id: MigrationSource; name: string; state: 'ready' | 'connect' | 'planned'; note: string }> = [
  { id: 'replit', name: 'Replit', state: 'ready', note: 'Bring the app export. Selvedge inspects it, creates the repo and project map, and opens the workspace.' },
  { id: 'github', name: 'GitHub', state: 'connect', note: 'Connect an existing repository. Selvedge already understands repos as owner-controlled project sources.' },
  { id: 'lovable', name: 'Lovable', state: 'planned', note: 'The direct source adapter is next. We will not claim access Selvedge does not have yet.' },
  { id: 'bolt', name: 'Bolt', state: 'planned', note: 'The direct source adapter is next. Your current production environment remains untouched.' },
  { id: 'base44', name: 'Base44', state: 'planned', note: 'The direct source adapter is next. Your current production environment remains untouched.' },
];

export function Migrate() {
  const [source, setSource] = useState<MigrationSource>('replit');
  const chosen = sources.find((item) => item.id === source)!;
  return <div className="animate-settle mx-auto max-w-5xl px-5 pb-24 pt-12 sm:px-8 sm:pt-16">
    <header className="max-w-3xl"><p className="section-label">Bring your project home</p><h1 className="mt-4 font-display text-[clamp(2.7rem,6vw,4.6rem)] leading-none tracking-[-.045em] text-ink">Where is your app today?</h1><p className="mt-5 text-lede text-ink-dim">Choose the source once. Selvedge builds the inventory, preserves the original, and takes you to a working copy.</p></header>
    <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{sources.map((item) => <button type="button" key={item.id} onClick={() => setSource(item.id)} aria-pressed={source === item.id} className={`rounded-card border p-4 text-left ${source === item.id ? 'border-action bg-sage' : 'border-hairline bg-panel hover:border-action/50'}`}><strong className="block text-body text-ink">{item.name}</strong><span className="mt-2 block font-mono text-tech text-ink-quiet">{item.state === 'ready' ? 'AVAILABLE' : item.state === 'connect' ? 'CONNECT' : 'ADAPTER PLANNED'}</span></button>)}</div>
    <Pane className="mt-6 p-5 sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="section-label">Leaving {chosen.name}</p><h2 className="mt-2 font-display text-3xl text-ink">Selvedge does the inventory.</h2><p className="mt-2 max-w-2xl text-body text-ink-dim">{chosen.note}</p></div><span className="rounded-full bg-panel-soft px-3 py-1.5 font-mono text-tech text-ink-dim">Original stays live</span></div>
      {source === 'replit' && <div className="mt-6"><ImportReplit /></div>}
      {source === 'github' && <div className="mt-6"><Link to="/projects" className="rounded-full bg-action px-5 py-2.5 text-body font-medium text-white">Connect or choose a repository →</Link></div>}
      {chosen.state === 'planned' && <div className="mt-6 rounded-inset border border-hairline bg-panel-soft p-4"><p className="text-body text-ink">This adapter is not connected yet.</p><p className="mt-1 text-meta text-ink-dim">For now, export the project into GitHub and bring that repository into Selvedge. We are keeping this boundary explicit instead of presenting a manual checklist as an autonomous migration.</p><Link to="/projects" className="mt-3 inline-block text-body text-action-bright hover:underline">Bring the GitHub repository →</Link></div>}
    </Pane>
    <ol className="mt-8 grid gap-3 md:grid-cols-3"><li className="rounded-card bg-panel p-5"><span className="font-mono text-tech text-action-bright">01</span><strong className="mt-3 block text-body text-ink">Selvedge inspects</strong><p className="mt-1 text-meta text-ink-dim">Code, runtime, data, auth, storage, jobs, integrations, secrets, domains and hosting.</p></li><li className="rounded-card bg-panel p-5"><span className="font-mono text-tech text-action-bright">02</span><strong className="mt-3 block text-body text-ink">Agents build the copy</strong><p className="mt-1 text-meta text-ink-dim">The workspace is isolated. The current production app is not modified.</p></li><li className="rounded-card bg-panel p-5"><span className="font-mono text-tech text-action-bright">03</span><strong className="mt-3 block text-body text-ink">You review the result</strong><p className="mt-1 text-meta text-ink-dim">Preview and observed evidence come before any production cutover.</p></li></ol>
  </div>;
}
