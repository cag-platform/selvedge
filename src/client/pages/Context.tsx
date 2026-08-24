import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Pane } from '../components/ui.js';
import { ImportHistory } from '../components/ImportHistory.js';
import { FileOldChats } from '../components/FileOldChats.js';

type StackMemory = { apps: number; watched_days: number; things_learned: number; summary: string };

/**
 * EVERYTHING SELVEDGE KNOWS, AND THE DOOR OUT.
 *
 * What it has learned by watching, the export that lets you take it, the
 * import that brings a history in from somewhere else, and the filing of what
 * came in. One thing, in four parts, and it was sitting on the Projects page
 * above the projects.
 *
 * That was the wrong home twice over. None of it is work — it is what you set
 * up, do once, or reach for when leaving — and it pushed the actual projects
 * below the fold on an account with a real history behind it. Admin is where
 * the things you arrange once already live.
 *
 * THE EXPORT STAYS AS PROMINENT AS THE REST, deliberately. Being able to leave
 * is what makes it reasonable to stay, and an export buried a level deeper
 * than the thing it undoes is an export that is technically offered. It leads
 * this page rather than closing it.
 */
export function Context() {
  const [mem, setMem] = useState<StackMemory | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .get<StackMemory>('/api/memory')
      .then(setMem)
      .catch(() => setFailed(true));
  }, []);

  const exportContext = async () => {
    const bundle = await api.get<unknown>('/api/export');
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'selvedge-context.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <Pane className="p-5">
        <h2 className="text-headline font-display text-ink">What Selvedge knows</h2>
        {/* Three states, and they are genuinely different. A summary, nothing
            watched long enough to have one, or a request that did not come
            back — the last of which must not be dressed as the second. */}
        {mem && mem.apps > 0 ? (
          <p className="mt-2 text-body text-ink-dim">{mem.summary}</p>
        ) : failed ? (
          <p className="mt-2 text-body text-ink-quiet">I couldn&rsquo;t read the memory just now.</p>
        ) : (
          <p className="mt-2 text-body text-ink-quiet">Nothing has been watched long enough to have a memory yet.</p>
        )}

        {/* Offered whatever the memory says: an account with nothing learned
            still has projects, conversations and decisions worth taking. */}
        <button
          onClick={() => void exportContext()}
          className="mt-3 block text-body text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          Export my context &rarr;
        </button>
      </Pane>

      <Pane className="p-5">
        <h2 className="text-headline font-display text-ink">Bring a history in</h2>
        {/* The mirror of the export, and the same argument: what you said
            elsewhere is yours, so it can come in as easily as it can go out. */}
        <ImportHistory />
      </Pane>

      {/* And once it is in, the step that used to be missing: joining a
          conversation about a project to the project. Renders nothing at all
          when there is no imported history, so this pane is absent rather than
          empty on an account that has never imported. */}
      <FileOldChats />
    </div>
  );
}
