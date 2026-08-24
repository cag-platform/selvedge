import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * WHAT THE PREVIEW RUNS WITH — the box this product spent a while telling
 * people to use before it existed.
 *
 * The whole path was built: a table, the connector vault with the project in
 * the AES-GCM AAD, a write-only read that returns names and never values, and
 * an upload that writes the file into `/tmp` at chmod 600 and sources it. The
 * failure diagnosis even names the variable — "The app needs STRIPE_SECRET_KEY
 * to start" — and then said "add it to this project's preview environment",
 * which was a sentence pointing at nothing. This is the nothing, filled in.
 *
 * THREE RULES, AND THEY ARE WHY IT LOOKS LIKE THIS.
 *
 * 1. VALUES NEVER COME BACK. The server returns key NAMES; there is no request
 *    that returns a secret and no state here that could hold one after a save.
 *    So the box is empty on load even when values are stored, and the list
 *    above it is how you know they are there. That is not a bug to fix later:
 *    a screen that redisplays secrets is a screen that leaks them to whoever is
 *    behind you.
 *
 * 2. IT SAYS WHERE THEY GO. People paste production credentials into boxes
 *    like this. They are entitled to know the file lands in /tmp, not the
 *    repository, and never in the preview URL — stated here rather than in
 *    documentation nobody opens.
 *
 * 3. SAVING REPLACES. A `.env` is a whole file, not a patch, so pasting three
 *    lines when six were stored leaves three. Said out loud, because the
 *    alternative reading is just as reasonable and getting it wrong silently
 *    deletes a working configuration.
 */

type Summary = { keys: string[]; wantsDatabase: boolean; updatedAt: string | null };

export function PreviewEnv({ projectId, onSaved }: { projectId: string; onSaved?: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    api
      .get<Summary>(`/api/projects/${projectId}/preview-env`)
      .then(setSummary)
      .catch(() => setSummary({ keys: [], wantsDatabase: false, updatedAt: null }));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const next = await api.put<Summary>(`/api/projects/${projectId}/preview-env`, { env: draft });
      setSummary(next);
      // The one place the draft is cleared, and it matters: leaving a pasted
      // secret in a textarea after saving is the same leak as showing it back.
      setDraft('');
      onSaved?.();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "that didn't save");
    } finally {
      setBusy(false);
    }
  }

  const stored = summary?.keys ?? [];

  return (
    <div className="mt-2 space-y-work-tight rounded-inset border border-hairline bg-panel-soft p-work-tight">
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">What the preview runs with</p>

      {stored.length > 0 ? (
        <p className="text-meta text-ink-dim">
          {stored.length} {stored.length === 1 ? 'value is' : 'values are'} stored:{' '}
          <span className="font-mono text-tech text-ink-quiet">{stored.join(', ')}</span>
        </p>
      ) : (
        <p className="text-meta text-ink-quiet">Nothing stored yet.</p>
      )}

      <label className="block text-meta text-ink-quiet">
        Paste the <code className="font-mono text-tech">.env</code> this app needs
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          spellCheck={false}
          autoComplete="off"
          placeholder={'STRIPE_SECRET_KEY=sk_live_…\nSESSION_SECRET=…'}
          className="mt-1 block w-full rounded-inset border border-hairline bg-panel px-3 py-2 font-mono text-tech text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        />
      </label>

      <p className="text-meta text-ink-quiet">
        These go into the sandbox as a file in <code className="font-mono text-tech">/tmp</code> — never into your repository and never
        into the preview URL. {stored.length > 0 && 'Saving replaces everything stored, so paste the whole file.'}
      </p>

      <div className="flex items-center gap-work">
        <button
          onClick={() => void save()}
          disabled={busy || draft.trim() === ''}
          className="rounded-inset border border-hairline bg-panel px-3 py-1 text-body text-ink hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save and try again'}
        </button>
        {stored.length > 0 && (
          <button
            onClick={async () => {
              setBusy(true);
              setNote(null);
              try {
                setSummary(await api.put<Summary>(`/api/projects/${projectId}/preview-env`, { env: '' }));
              } catch (err) {
                setNote(err instanceof Error ? err.message : "that didn't work");
              } finally {
                setBusy(false);
              }
            }}
            className="text-meta text-ink-quiet underline hover:text-ink-dim"
          >
            Remove them
          </button>
        )}
      </div>

      {/* An unconfigured vault is a deployment problem said plainly — the route
          refuses rather than storing secrets in the clear, and this is where
          that refusal lands. */}
      {note && <p className="text-meta text-thread">{note}</p>}
    </div>
  );
}
