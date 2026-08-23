import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { btnPrimary, EmptyState } from './ui.js';

/**
 * YOUR MACHINES — where the loop is switched on.
 *
 * A key per machine, shown exactly once. The copy has one job beyond the
 * mechanics: to be precise about what the companion sends, because "a daemon
 * that watches your coding sessions" is a sentence that deserves suspicion and
 * the honest answer is the reason it's safe to say yes to.
 */

type Key = { id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

export function CompanionKeys() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ keys: Key[] }>('/api/companion-keys')
      .then((r) => setKeys(r.keys))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const made = await api.post<{ token: string }>('/api/companion-keys', { name: name.trim() || 'a machine' });
      setIssued(made.token);
      setName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't go through");
    }
  }

  async function revoke(id: string) {
    await api.del(`/api/companion-keys/${id}`).catch(() => undefined);
    load();
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-headline font-medium text-ink">Your machines</h2>
        <p className="mt-1 max-w-xl text-body text-ink-dim">
          Selvedge can read the coding sessions you run in your own terminal, and hand your project’s context back to any
          agent you use. Both go through one small program on your machine, with a key you make here.
        </p>
      </div>

      <details className="rounded-card border border-hairline bg-panel-soft px-4 py-3">
        <summary className="cursor-pointer text-body text-ink">What actually leaves your machine</summary>
        <div className="mt-2 space-y-2 text-body text-ink-dim">
          <p>
            For each finished session: which tool ran it and its id, when it ran, the folder and repo, the first thing you
            asked for, the file paths it touched, the tool names it ran and how often, how it ended, the commit that landed
            while it was open, and what the tool said it cost.
          </p>
          <p className="text-ink">
            Never: the conversation, your code, or any diff. Run <span className="font-mono text-tech">selvedge watch --dry-run</span> and it prints
            exactly what it would send, so you can check rather than take our word.
          </p>
        </div>
      </details>

      {issued && (
        <div className="space-y-2 rounded-card border border-hairline border-l-2 border-l-action-bright bg-panel px-4 py-3">
          <p className="text-body text-ink">Copy this now — it’s shown only once.</p>
          <p className="select-all break-all font-mono text-tech text-ink">{issued}</p>
          <div className="space-y-1 font-mono text-tech text-ink-quiet">
            <p>npm install -g selvedge</p>
            <p>selvedge login --token {issued.slice(0, 8)}…</p>
            <p>selvedge watch</p>
          </div>
          <p className="text-meta text-ink-quiet">
            To give your agents this project's context, mount the same program as an MCP server:{' '}
            <span className="font-mono text-tech">claude mcp add selvedge-context -- selvedge context</span>
          </p>
        </div>
      )}

      <form onSubmit={mint} className="flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="what to call this machine"
          className="min-w-[14rem] flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        />
        <button type="submit" className={btnPrimary}>
          Make a key
        </button>
        {error && <span className="text-meta text-thread">{error}</span>}
      </form>

      {keys && keys.length === 0 && (
        <EmptyState>
          The companion hasn&rsquo;t seen a session yet. Install with{' '}
          <span className="font-mono text-tech">npx selvedge</span> &mdash; summaries appear here, code never leaves
          your machine.
        </EmptyState>
      )}

      {keys && keys.length > 0 && (
        <ul className="divide-y divide-hairline rounded-card border border-hairline bg-panel">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-body text-ink">
                  {key.name}
                  {key.revoked_at && <span className="ml-2 text-meta text-ink-quiet">stopped working</span>}
                </p>
                <p className="text-meta text-ink-quiet">
                  {key.last_used_at ? `last used ${new Date(key.last_used_at).toLocaleString()}` : 'never used'}
                </p>
              </div>
              {!key.revoked_at && (
                <button onClick={() => void revoke(key.id)} className="text-meta text-ink-quiet hover:text-thread">
                  Stop this key
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
