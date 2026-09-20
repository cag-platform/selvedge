import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fuelLabel, keyHint } from '../lib/fuel.js';
import { AGENTS } from '../../shared/agents.js';
import { CompanionKeys } from '../components/CompanionKeys.js';
import { ConnectProviders } from '../components/ConnectProviders.js';

/**
 * Connections — one place to turn on every agent. The big three (Claude, GPT,
 * Gemini) are cards with one honest primary path each — see ConnectProviders
 * for the provider-policy reasoning. Model API keys are verified before they
 * are stored. Secrets are never shown back — only a last-four hint and a
 * status.
 */

type Connected = { provider: string; kind: string; label: string | null; last4: string | null; status: string };
type FuelState = { connected: Connected[]; available: string[]; coming_soon: string[] };

/** The providers whose cards live above — the generic key form covers the rest. */
const CARDED_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'zai']);

export function Connections() {
  const [state, setState] = useState<FuelState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<FuelState>('/api/fuel')
      .then(setState)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="text-body text-thread">{error}</p>;
  if (!state) return <p className="text-body text-ink-quiet">Loading…</p>;

  const connectedProviders = new Set(state.connected.map((c) => c.provider));
  const connectable = state.available.filter((p) => !connectedProviders.has(p) && !CARDED_PROVIDERS.has(p));

  return (
    <div className="animate-settle space-y-8">
      <div>
        <h1 className="text-display font-display font-medium text-ink">Connect your AI</h1>
        <p className="mt-2 max-w-xl text-body text-ink-dim">One is enough to start. Your project context stays the same whichever you use.</p>
      </div>

      <section>
        <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Your AI</p>
        <ConnectProviders />
      </section>

      <section id="agent-keys">
        <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Connected accounts</p>
        {state.connected.length === 0 ? (
          <p className="text-body text-ink-quiet">Nothing connected yet. Connect one above and it appears here.</p>
        ) : (
          <div className="space-y-2">
            {state.connected.map((c) => (
              <ConnectedRow key={c.provider} row={c} onRemoved={() => void load()} />
            ))}
          </div>
        )}
      </section>

      {connectable.length > 0 && <ConnectForm providers={connectable} onConnected={() => void load()} />}

      <details id="local-agents" className="rounded-card border border-hairline bg-panel p-4">
        <summary className="cursor-pointer text-body font-medium text-ink">Your computer — subscriptions, session watching, and Apple builds</summary>
        <div className="mt-4"><CompanionKeys /></div>
      </details>

      {state.coming_soon.length > 0 && (
        <p className="text-meta text-ink-quiet">
          Coming soon: {state.coming_soon.map(fuelLabel).join(', ')}.
        </p>
      )}

      <Hosts />

    </div>
  );
}

type HostRow = { provider: string; last4: string | null; status: string };
const HOST_LABEL: Record<string, string> = { railway: 'Railway', vercel: 'Vercel', supabase: 'Supabase' };

/**
 * Host tokens — what lets Selvedge watch your deploys. Unlike a model key, a bad
 * host token is safe: everything downstream degrades to "can't tell", never a
 * false alarm, so it's stored without a blocking check and confirmed the next
 * time deploys are read.
 */
function Hosts() {
  const [connected, setConnected] = useState<HostRow[] | null>(null);
  const [available, setAvailable] = useState<string[]>([]);

  const load = () =>
    api
      .get<{ connected: HostRow[]; available: string[] }>('/api/hosts')
      .then((r) => {
        setConnected(r.connected);
        setAvailable(r.available);
      })
      .catch(() => setConnected([]));

  useEffect(() => {
    void load();
  }, []);

  if (!connected) return null;
  const connectedProviders = new Set(connected.map((c) => c.provider));
  const connectable = available.filter((p) => !connectedProviders.has(p));

  return (
    <section>
      <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Your host</p>
      <p className="mb-3 max-w-xl text-meta text-ink-dim">
        Grant a token so I can see whether your deploys go live or fail. It’s your account; the token stays in the vault,
        and you can remove it any time.
      </p>
      <div className="space-y-2">
        {connected.map((c) => (
          <div key={c.provider} className="flex items-center justify-between rounded-card border border-hairline bg-panel px-4 py-3">
            <div>
              <p className="text-body text-ink">{HOST_LABEL[c.provider] ?? c.provider}</p>
              <p className="text-meta text-ink-quiet">{c.last4 ? `token ending ${c.last4}` : 'token stored'}</p>
            </div>
            <button
              onClick={async () => {
                await api.del(`/api/hosts/${c.provider}`);
                void load();
              }}
              className="text-meta text-ink-quiet hover:text-thread"
            >
              Remove
            </button>
          </div>
        ))}
        {connectable.map((p) => (
          <div key={p} className="space-y-2">
            {p === 'railway' && <RailwayOneClick onConnected={() => void load()} />}
            <HostConnect provider={p} onConnected={() => void load()} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * "Login with Railway" — one click instead of a token to hunt for.
 *
 * The popup keeps the whole flow in-app. When it closes we re-read the host
 * list rather than trusting the popup to have succeeded: the callback may have
 * been declined, and the connection list is the only thing that actually knows.
 * If one-click isn't configured on the server, the button says so and the paste
 * field below it still works — that path never depended on OAuth.
 */
function RailwayOneClick({ onConnected }: { onConnected: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { authorize_url } = await api.post<{ authorize_url: string }>('/api/connectors/railway/start', {});
      const popup = window.open(authorize_url, 'selvedge-railway', 'width=560,height=760');
      if (!popup) {
        setNote('Your browser blocked the popup. Allow popups for this site, or paste a token below.');
        setBusy(false);
        return;
      }
      const timer = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(timer);
        setBusy(false);
        onConnected();
      }, 500);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "that didn't work");
      setBusy(false);
    }
  };

  return (
    <div className="rounded-card border border-hairline bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-body text-ink">Railway</p>
          <p className="text-meta text-ink-quiet">Sign in once. It stays in your name, and you can revoke it any time.</p>
        </div>
        <button
          onClick={() => void start()}
          disabled={busy}
          className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
        >
          {busy ? 'Waiting for Railway…' : 'Login with Railway'}
        </button>
      </div>
      {note && <p className="mt-2 text-meta text-thread">{note}</p>}
    </div>
  );
}

function HostConnect({ provider, onConnected }: { provider: string; onConnected: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.post('/api/hosts', { provider, token: token.trim() });
          setToken('');
          onConnected();
        } catch (err) {
          setError(err instanceof Error ? err.message : "that didn't work");
        } finally {
          setBusy(false);
        }
      }}
      className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-hairline bg-panel-soft px-4 py-3"
    >
      <span className="text-body text-ink-dim">{HOST_LABEL[provider] ?? provider}</span>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={`paste your ${HOST_LABEL[provider] ?? provider} token`}
        className="min-w-[14rem] flex-1 rounded-inset border border-hairline bg-panel px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
      />
      <button
        type="submit"
        disabled={busy || token.trim().length < 8}
        className="rounded-inset border border-hairline bg-panel px-4 py-1.5 text-body font-medium text-ink hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Connect'}
      </button>
      {error && <span className="text-meta text-thread">{error}</span>}
    </form>
  );
}

function ConnectedRow({ row, onRemoved }: { row: Connected; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const invalid = row.status !== 'active';
  return (
    <div className="flex items-center justify-between rounded-card border border-hairline bg-panel px-4 py-3">
      <div>
        <p className="text-body text-ink">{fuelLabel(row.provider)}</p>
        <p className="text-meta text-ink-quiet">
          {row.kind === 'subscription'
            ? 'Claude Code subscription token'
            : row.last4 ? `API key ending ${row.last4}` : 'API key stored'}
          {invalid && <span className="ml-2 text-thread">— stopped working, reconnect</span>}
        </p>
      </div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.del(`/api/fuel/${row.provider}`);
            onRemoved();
          } finally {
            setBusy(false);
          }
        }}
        className="text-meta text-ink-quiet hover:text-thread disabled:opacity-50"
      >
        Remove
      </button>
    </div>
  );
}

/**
 * The long tail — Kimi, Grok, DeepSeek, Mistral — one generic key form.
 *
 * The subscription-token option that used to live here is gone on purpose:
 * Anthropic locked consumer-plan tokens to its own apps (enforced server-side
 * since January 2026), so offering the paste path here sold a door that no
 * longer opens. Existing stored tokens keep working wherever Anthropic still
 * honors them; we just stopped advertising the path.
 */
export function ConnectForm({ providers, onConnected }: { providers: string[]; onConnected: () => void }) {
  const [provider, setProvider] = useState(providers[0] ?? '');
  const [key, setKey] = useState('');
  const [state, setState] = useState<'idle' | 'checking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const hint = keyHint(provider);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('checking');
    setError(null);
    try {
      await api.post('/api/fuel', { provider, key: key.trim(), kind: 'api_key' });
      setKey('');
      onConnected();
    } catch (err) {
      // The route returns a plain reason ("that key didn't work — check it and try again").
      setError(err instanceof Error ? err.message : "that didn't work");
    } finally {
      setState('idle');
    }
  }

  return (
    <section>
      <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">More providers</p>
      <form onSubmit={submit} className="max-w-xl space-y-3 rounded-card border border-hairline bg-panel p-4">
        <div className="flex flex-wrap gap-3">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {fuelLabel(p)}
              </option>
            ))}
          </select>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="paste your API key"
            className="min-w-[16rem] flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          />
        </div>
        {/* WHAT THIS KEY SWITCHES ON, said where the key is being added. This
            copy lived in the @-menu, on rows for agents nobody had connected —
            which made the menu loud and taught nothing at the moment anyone
            could act on it. Here, it is the reason to paste the key. */}
        <div className="space-y-1">
          {AGENTS.filter((a) => a.provider === provider && a.live).map((a) => (
            <p key={a.id} className="text-meta text-ink-dim">
              <span className="font-mono text-tech text-brass">@{a.id}</span>{' '}
              {a.changesFiles ? <>changes files in your sandbox; {a.costNote}.</> : <>talks it through, never touches your files; {a.costNote}.</>}
            </p>
          ))}
        </div>
        {hint && <p className="text-meta text-ink-quiet">Your {fuelLabel(provider)} key — {hint}. It's checked before it's saved.</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={state === 'checking' || key.trim().length < 8}
            className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
          >
            {state === 'checking' ? 'Checking…' : 'Connect'}
          </button>
          {error && <span className="text-meta text-thread">{error}</span>}
        </div>
      </form>
    </section>
  );
}
