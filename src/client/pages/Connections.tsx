import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fuelLabel, keyHint } from '../lib/fuel.js';

/**
 * Connections — where the owner turns on the voice by connecting their own
 * model key (BYO fuel). Selvedge charges for the layer, not the compute: the
 * key is the customer's, verified live before it's stored, and revocable. The
 * secret is never shown back — only the last four characters and a status.
 */

type Connected = { provider: string; last4: string | null; status: string };
type FuelState = { connected: Connected[]; available: string[]; coming_soon: string[] };

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
  const connectable = state.available.filter((p) => !connectedProviders.has(p));

  return (
    <div className="animate-settle space-y-8">
      <div>
        <h1 className="text-display font-display font-medium text-ink">Connections</h1>
        <p className="mt-2 max-w-xl text-body text-ink-dim">
          Connect your own AI model key to turn on the voice. Selvedge charges for the layer — the watching, the
          explaining, the caps and checkpoints — not for the model. The key is yours, checked before it's saved, and you
          can remove it any time.
        </p>
      </div>

      <section>
        <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Connected</p>
        {state.connected.length === 0 ? (
          <p className="text-body text-ink-quiet">Nothing connected yet — add a key below and the brief gains its voice.</p>
        ) : (
          <div className="space-y-2">
            {state.connected.map((c) => (
              <ConnectedRow key={c.provider} row={c} onRemoved={() => void load()} />
            ))}
          </div>
        )}
      </section>

      {connectable.length > 0 && <ConnectForm providers={connectable} onConnected={() => void load()} />}

      {state.coming_soon.length > 0 && (
        <p className="text-meta text-ink-quiet">
          Coming soon: {state.coming_soon.map(fuelLabel).join(', ')}.
        </p>
      )}
    </div>
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
          {row.last4 ? `key ending ${row.last4}` : 'key stored'}
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

function ConnectForm({ providers, onConnected }: { providers: string[]; onConnected: () => void }) {
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
      await api.post('/api/fuel', { provider, key: key.trim() });
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
      <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Add a key</p>
      <form onSubmit={submit} className="max-w-xl space-y-3 rounded-card border border-hairline bg-panel p-4">
        <div className="flex flex-wrap gap-3">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass"
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
            className="min-w-[16rem] flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass"
          />
        </div>
        {hint && <p className="text-meta text-ink-quiet">Your {fuelLabel(provider)} key — {hint}. It's checked before it's saved.</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={state === 'checking' || key.trim().length < 8}
            className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass disabled:opacity-50"
          >
            {state === 'checking' ? 'Checking…' : 'Connect'}
          </button>
          {error && <span className="text-meta text-thread">{error}</span>}
        </div>
      </form>
    </section>
  );
}
