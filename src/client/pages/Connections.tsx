import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fuelLabel, keyHint } from '../lib/fuel.js';
import { AGENTS } from '../../shared/agents.js';
import { CompanionKeys } from '../components/CompanionKeys.js';

/**
 * Connections — one place to turn on every agent. Subscription-backed coding
 * agents can stay on a connected computer; model API keys are verified before
 * they are stored. Secrets are never shown back — only a last-four hint and a
 * status.
 */

type Connected = { provider: string; kind: string; label: string | null; last4: string | null; status: string };
type FuelState = { connected: Connected[]; available: string[]; coming_soon: string[] };
type AgentConnection = {
  connected: boolean;
  kind: 'subscription' | 'api_key' | 'local' | null;
  label: string | null;
  last4: string | null;
  machine: string | null;
};
type AgentConnectionState = {
  agents: { codex: AgentConnection; claude_code: AgentConnection };
  local: { connected: boolean; name: string | null; codex: boolean; claude_code: boolean };
};

function ConnectionCard({
  title,
  subtitle,
  connection,
  localLabel,
  apiLabel,
  subscriptionLabel,
  primaryAction,
  primaryHref,
  secondaryAction,
  secondaryHref,
}: {
  title: string;
  subtitle: string;
  connection: AgentConnection;
  localLabel: string;
  apiLabel: string;
  subscriptionLabel: string;
  primaryAction: string;
  primaryHref: string;
  secondaryAction: string;
  secondaryHref: string;
}) {
  const connectedLabel = connection.kind === 'local'
    ? `Connected on ${connection.machine ?? 'your computer'}`
    : connection.kind === 'subscription'
      ? subscriptionLabel
      : connection.kind === 'api_key'
        ? `${apiLabel}${connection.last4 ? ` ····${connection.last4}` : ''}`
        : 'Not connected yet';
  return (
    <div className={`rounded-card border p-4 ${connection.connected ? 'border-action/40 bg-action-soft/30' : 'border-hairline bg-panel'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-body font-medium text-ink">{title}</p>
          <p className="mt-1 text-meta text-ink-dim">{subtitle}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-meta font-medium ${connection.connected ? 'bg-action text-white' : 'bg-panel-soft text-ink-quiet'}`}>
          {connection.connected ? (connection.kind === 'subscription' ? 'Saved · not verified' : 'Connected') : 'Needs setup'}
        </span>
      </div>
      <p className="mt-4 text-meta text-ink">{connectedLabel}</p>
      {!connection.connected && <p className="mt-1 text-meta text-ink-quiet">{localLabel}</p>}
      {!connection.connected && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a href={primaryHref} className="rounded-inset bg-action px-3 py-2 text-meta font-medium text-white hover:bg-action-bright">{primaryAction}</a>
          <a href={secondaryHref} className="text-meta font-medium text-action hover:text-action-bright">{secondaryAction} ↓</a>
        </div>
      )}
    </div>
  );
}

function AgentConnections() {
  const [state, setState] = useState<AgentConnectionState | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.get<AgentConnectionState>('/api/agent-connections').then((value) => { if (alive) setState(value); }).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const empty: AgentConnection = { connected: false, kind: null, label: null, last4: null, machine: null };
  return (
    <section className="space-y-3">
      <div>
        <p className="mb-1 text-label font-body uppercase tracking-widest text-ink-quiet">Your AI agents</p>
        <p className="max-w-2xl text-body text-ink-dim">Choose one way to connect. You can change it later, and your project context stays the same.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ConnectionCard title="Codex / GPT" subtitle="Build with Codex or talk with GPT." connection={state?.agents.codex ?? empty} localLabel="Your ChatGPT subscription connects through Codex on your computer." apiLabel="OpenAI API key" subscriptionLabel="ChatGPT subscription on your computer" primaryAction="Connect this computer" primaryHref="#local-agents" secondaryAction="Use an API key" secondaryHref="#agent-keys" />
        <ConnectionCard title="Claude / Claude Code" subtitle="Build with Claude Code or talk with Claude." connection={state?.agents.claude_code ?? empty} localLabel="Use Claude Code on your computer, or connect Claude here with a subscription token." apiLabel="Anthropic API key" subscriptionLabel="Claude Code subscription" primaryAction="Connect Claude" primaryHref="#agent-keys" secondaryAction="Use this computer" secondaryHref="#local-agents" />
      </div>
      <p className="text-meta text-ink-quiet">{state?.local.connected ? `Local agents are connected on ${state.local.name ?? 'your computer'}.` : 'Subscriptions stay with the provider. Selvedge only receives the work result and project state it needs.'}</p>
    </section>
  );
}

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
        <h1 className="text-display font-display font-medium text-ink">Connect your AI agents</h1>
        <p className="mt-2 max-w-xl text-body text-ink-dim">One place to connect the agents you already use. Subscription access stays with that provider; API keys are always optional.</p>
      </div>

      <AgentConnections />

      <div id="local-agents">
        <CompanionKeys />
      </div>

      <section id="agent-keys">
        <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">API keys, when you want them</p>
        {state.connected.length === 0 ? (
          <p className="text-body text-ink-quiet">No API accounts connected. That is fine when a subscription or local computer is connected above.</p>
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
 * Providers where a SUBSCRIPTION is an alternative to an API key.
 *
 * Claude Code can use a subscription token created by its official
 * `claude setup-token` flow. Codex/ChatGPT subscriptions stay on the local
 * Codex installation and are connected through the computer card above.
 */
const SUBSCRIPTION_PROVIDERS = new Set<string>(['anthropic']);

export function ConnectForm({ providers, onConnected }: { providers: string[]; onConnected: () => void }) {
  const [provider, setProvider] = useState(providers[0] ?? '');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<'api_key' | 'subscription'>('api_key');
  const [state, setState] = useState<'idle' | 'checking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const canSubscribe = SUBSCRIPTION_PROVIDERS.has(provider);
  // A kind that stopped being offered must not stay selected underneath.
  const effectiveKind = canSubscribe ? kind : 'api_key';
  const hint = keyHint(provider);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('checking');
    setError(null);
    try {
      await api.post('/api/fuel', { provider, key: key.trim(), kind: effectiveKind });
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
      <p className="mb-3 text-label font-body uppercase tracking-widest text-ink-quiet">Connect an API key or Claude subscription</p>
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
          {canSubscribe && (
            <select
              value={effectiveKind}
              onChange={(e) => setKind(e.target.value === 'subscription' ? 'subscription' : 'api_key')}
              className="rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
            >
              <option value="api_key">API key</option>
              <option value="subscription">Subscription</option>
            </select>
          )}
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={effectiveKind === 'subscription' ? 'paste your subscription token' : 'paste your API key'}
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
        {/*
          Two different promises, so two different sentences. A key is pinged
          before it's stored, so "checked before it's saved" is true. A
          subscription can't be — only the CLI that uses it can prove it — and
          saying it was checked would be a lie on the one screen whose whole
          job is that "connected" means "works".
        */}
        {effectiveKind === 'subscription' ? (
          <p className="text-meta text-ink-quiet">
            Your Claude subscription: run <code className="font-mono text-tech">claude setup-token</code> and paste what it prints. It
            can’t be checked from here the way a key can; your first build will prove it.
          </p>
        ) : (
          hint && <p className="text-meta text-ink-quiet">Your {fuelLabel(provider)} key — {hint}. It's checked before it's saved.</p>
        )}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={state === 'checking' || key.trim().length < 8}
            className="rounded-inset border border-hairline bg-panel-soft px-4 py-1.5 text-body font-medium text-ink transition-colors hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
          >
            {state === 'checking' ? (effectiveKind === 'subscription' ? 'Saving…' : 'Checking…') : 'Connect'}
          </button>
          {error && <span className="text-meta text-thread">{error}</span>}
        </div>
      </form>
    </section>
  );
}
