import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Pane, btnPrimary, inputCls } from './ui.js';

/**
 * BRING AN OLD HISTORY IN — the mirror of "export my context", and the same
 * argument: what you said elsewhere is yours, and it should be here if you
 * want it here.
 *
 * The screen's job, beyond the upload, is to tell the truth about the result
 * twice over. What could not be read is listed, not counted-and-forgotten. And
 * what the FORMAT cannot carry — Google's export has no answers in it, an
 * edited ChatGPT chat loses its abandoned branches — is stated whether or not
 * anything went wrong, because those limits apply to the successful import
 * too, and a person who doesn't know them will later think Selvedge lost
 * something.
 *
 * There is no "connect ChatGPT" here and there never will be. This takes the
 * export a vendor already gives you, once.
 */

type Result = {
  vendor_name: string;
  file: string;
  filed: number;
  already_had: number;
  unreadable_count: number;
  unreadable: Array<{ ref: string; reason: string }>;
  unreadable_truncated: number;
  limitations: string[];
  summary: string;
};

type Destination = { projects: Array<{ project_id: string; name: string }>; subjects: Array<{ id: string; name: string }> };

export function ImportHistory() {
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState<Destination | null>(null);
  const [target, setTarget] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!open || dest) return;
    void Promise.all([
      api.get<Array<{ project_id: string; name: string }>>('/api/projects').catch(() => []),
      api.get<{ subjects: Array<{ id: string; name: string }> }>('/api/subjects').then((r) => r.subjects).catch(() => []),
    ]).then(([projects, subjects]) => setDest({ projects, subjects }));
  }, [open, dest]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || target === '') return;
    setBusy(true);
    setError(null);
    setResult(null);
    const body = new FormData();
    body.append('file', file);
    const [kind, id] = target.split(':');
    body.append(kind === 'subject' ? 'subject_id' : 'project_id', id!);
    try {
      // Multipart, so this one goes around the JSON helper rather than
      // through it — the browser has to set its own boundary header.
      const res = await fetch('/api/import/history', { method: 'POST', credentials: 'same-origin', body });
      const json = (await res.json()) as Result & { error?: string };
      if (!res.ok) setError(json.error ?? 'that import did not go through');
      else {
        setResult(json);
        setFile(null);
      }
    } catch {
      setError('that import did not go through');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 block text-body text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright">
        Bring in an old history →
      </button>
    );
  }

  return (
    <Pane className="mt-3">
      <p className="text-body text-ink">Bring in an old history</p>
      <p className="mt-1 text-meta text-ink-quiet">
        Upload the export ZIP that ChatGPT, Claude or Gemini gave you, exactly as it downloaded. Those chats become ordinary
        conversations here — searchable, part of the history — and every one is marked as imported, because none of it was said to
        Selvedge. Nothing is connected and nothing keeps reading: this happens once, from a file you chose.
      </p>

      <form onSubmit={submit} className="mt-work space-y-work-tight">
        <label className="block text-body text-ink-dim">
          The export
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-body text-ink-dim file:mr-3 file:rounded-inset file:border file:border-hairline file:bg-panel-soft file:px-3 file:py-1 file:text-body file:text-ink"
          />
        </label>
        <label className="block text-body text-ink-dim">
          Where these belong
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls}>
            <option value="">Choose a project or a subject…</option>
            {dest?.projects.map((p) => (
              <option key={p.project_id} value={`project:${p.project_id}`}>
                {p.name}
              </option>
            ))}
            {dest?.subjects.map((s) => (
              <option key={s.id} value={`subject:${s.id}`}>
                {s.name} (subject)
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-work">
          <button type="submit" disabled={busy || !file || target === ''} className={btnPrimary}>
            {busy ? 'Reading it…' : 'Import'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="text-meta text-ink-quiet hover:text-ink-dim">
            Not now
          </button>
        </div>
      </form>

      {error && <p className="mt-work rounded-inset border-2 border-thread bg-panel-soft px-3 py-2 text-body font-medium text-thread">{error}</p>}

      {result && (
        <div className="mt-work space-y-work-tight border-t border-hairline pt-work">
          <p className="text-body text-ink">{result.summary}</p>
          {result.already_had > 0 && (
            <p className="text-meta text-ink-quiet">
              {result.already_had} {result.already_had === 1 ? 'was' : 'were'} already here from a previous import, so {result.already_had === 1 ? 'it' : 'they'}{' '}
              {result.already_had === 1 ? 'was' : 'were'} left alone rather than filed twice.
            </p>
          )}
          {/* Always shown, success or not: these limits apply to what DID come in. */}
          {result.limitations.length > 0 && (
            <div>
              <p className="text-label font-body uppercase tracking-widest text-ink-quiet">What this export can't carry</p>
              <ul className="list-disc pl-5 text-body text-ink-dim">
                {result.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          {result.unreadable.length > 0 && (
            <div>
              <p className="text-label font-body uppercase tracking-widest text-thread">Not imported — I couldn't read these</p>
              <ul className="mt-1 font-mono text-tech text-ink-quiet">
                {result.unreadable.map((u) => (
                  <li key={u.ref}>
                    {u.ref} — {u.reason}
                  </li>
                ))}
              </ul>
              {result.unreadable_truncated > 0 && (
                <p className="mt-1 text-meta text-ink-quiet">…and {result.unreadable_truncated} more like these.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Pane>
  );
}
