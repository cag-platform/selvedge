import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiUpload } from '../lib/api.js';

/**
 * IMPORT FROM REPLIT — the migration door, as a screen.
 *
 * The whole gesture is: download the Repl as a zip, drop it here, name it.
 * Selvedge filters the workspace junk, mints a private repo under the
 * account's GitHub, lands the files as one commit, makes the project, and
 * opens its workshop — the same rooms every other project lives in.
 *
 * THE HALF-STATE IS HANDLED, NOT HOPED AWAY. If the repo gets minted and the
 * push then fails, the server says so and names the project; this screen keeps
 * the zip selected and retries INTO that project, which layers a commit rather
 * than duplicating anything. "It failed" after infrastructure exists is the
 * kind of message that costs an hour — the retry button is the apology.
 *
 * SECRETS ARE SAID OUT LOUD TO NOT BE HERE. A Repl's env lives in Replit's
 * vault, not its filesystem, so the zip cannot contain them — the done-state
 * points at the preview environment box, which is the screen built for that
 * paste.
 */

type ImportResult = {
  project_id: string;
  thread_id: string;
  repo: string;
  files: number;
  skipped: string[];
  skipped_count: number;
  summary: string;
};

export function ImportReplit() {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'importing' | 'preparing' | 'opening'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [githubAction, setGithubAction] = useState(false);
  /** Set when a repo exists but the files never landed — the retry target. */
  const [retryProjectId, setRetryProjectId] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  async function send() {
    if (!file || busy) return;
    if (!retryProjectId && name.trim() === '') {
      setNote('Give it a name first.');
      return;
    }
    setBusy(true);
    setPhase('importing');
    setNote(null);
    setGithubAction(false);
    try {
      const form = new FormData();
      form.append('file', file);
      if (retryProjectId) form.append('project_id', retryProjectId);
      else form.append('name', name.trim());
      const made = await apiUpload<ImportResult & { project_id?: string }>('/api/import/replit', form);
      setPhase('preparing');
      const workspace = await api.post<{ workspace_id: string; preview: { state: string } }>(`/api/projects/${encodeURIComponent(made.project_id)}/migration/workspace`, {}).catch(() => null);
      const prepared = Boolean(workspace);
      setPhase('opening');
      await api.post(`/api/threads/${made.thread_id}/message`, {
        text: prepared
          ? 'Continue this migration automatically in the isolated workspace Selvedge prepared. Configure the development-safe copy, start the preview, and verify what can be observed. Identify anything still requiring account access. Do not change production or ship anything.'
          : 'Continue this migration automatically. The initial workspace preparation needs attention; inspect the migration plan, resolve the stated blocker if possible, then prepare the isolated copy, start the preview, and verify what can be observed. Do not change production or ship anything.',
        mode: 'build',
      }).catch(() => undefined);
      navigate(`/inbox/${made.thread_id}`);
    } catch (err) {
      const failed = err as Error & { body?: Record<string, unknown> };
      // The half-state: the server names the project the files should land
      // in, and the next press retries into it instead of minting a second.
      const half = typeof failed.body?.project_id === 'string' ? failed.body.project_id : null;
      if (half) setRetryProjectId(half);
      setGithubAction(failed.body?.code === 'github_authorization_required');
      setNote(failed.message || "that didn't go through");
      setBusy(false);
      setPhase('idle');
    }
  }

  return (
    <div className="space-y-3 rounded-card border border-hairline bg-panel-soft p-4">
      <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Hand the project to Selvedge</p>
      <p className="text-meta text-ink-dim">
        In Replit: your Repl&rsquo;s files pane &rarr; &#8942; &rarr; <span className="text-ink">Download as zip</span>. Drop it here and it
        becomes a project with its own private repo. That export is the only manual handoff; the migration agent takes it from there.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => picker.current?.click()}
          className="rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink hover:border-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        >
          {file ? file.name : 'Choose Replit export'}
        </button>
        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setNote(null);
            setGithubAction(false);
          }}
        />
        {!retryProjectId && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="what to call it"
            className="w-44 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink placeholder:text-ink-quiet focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          />
        )}
        <button
          onClick={() => void send()}
          disabled={busy || !file}
          className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-ink transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-40"
        >
          {busy ? phase === 'importing' ? 'Inspecting export…' : phase === 'preparing' ? 'Preparing preview…' : 'Opening project…' : retryProjectId ? `Retry into ${retryProjectId}` : 'Hand it to Selvedge →'}
        </button>
      </div>

      {busy && <ol className="grid gap-1.5 rounded-inset bg-panel px-3 py-2 text-meta text-ink-dim"><li><span className="mr-2 text-healthy">{phase === 'importing' ? '●' : '✓'}</span>Inspect and create the owner-controlled repository</li><li><span className={`mr-2 ${phase === 'preparing' ? 'text-action-bright' : phase === 'opening' ? 'text-healthy' : 'text-ink-quiet'}`}>{phase === 'preparing' ? '●' : phase === 'opening' ? '✓' : '○'}</span>Prepare the temporary workspace and preview</li><li><span className={`mr-2 ${phase === 'opening' ? 'text-action-bright' : 'text-ink-quiet'}`}>{phase === 'opening' ? '●' : '○'}</span>Open the guided migration conversation</li></ol>}

      <p className="text-meta text-ink-quiet">
        Secrets never travel in a zip. When the preview asks for the app&rsquo;s environment, paste the <span className="font-mono text-tech">.env</span> there.
        Replit&rsquo;s agent chats have no export, so they stay behind; the code and the record start fresh here.
      </p>

      {note && <div className="space-y-2"><p className="text-meta text-thread">{note}</p>{githubAction && <a href="/api/connectors/github/install" className="inline-block rounded-full bg-action px-4 py-2 text-meta font-medium text-white hover:opacity-90">Connect or update GitHub →</a>}<p className="text-meta text-ink-quiet">Your export is still selected in this browser. Return here after GitHub and press the same button—Selvedge will inspect it again and continue.</p></div>}
    </div>
  );
}
