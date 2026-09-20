import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { keyHint } from '../lib/fuel.js';
import { btnPrimary } from './ui.js';
import { CopyCommand } from './CompanionKeys.js';

/**
 * THE THREE DOORS — Claude, GPT, Gemini — one card each, one primary path each.
 *
 * The old connect step offered every provider the same way: a dropdown, a kind
 * selector, and a paste field, three times over. Nobody arriving from ChatGPT
 * or Claude thinks of themselves as holding an "anthropic api_key"; they think
 * "I pay for GPT". So each card leads with the best path that provider actually
 * permits, and says out loud what it doesn't:
 *
 *  - GPT: OpenAI allows paid ChatGPT plans inside third-party tools (their
 *    2026 posture, stated publicly). The primary path is the one-command
 *    computer bridge that signs Codex into that plan. API key is the fallback.
 *  - Claude: Anthropic locked consumer-plan OAuth to its own apps (server-side
 *    since Jan 2026) and stopped subscription usage covering third-party
 *    harnesses (Apr 2026). Pretending otherwise buys the customer a ToS
 *    problem, so the card is honest: API key, full stop.
 *  - Gemini: an AI Studio key is the whole story, and getting one is two
 *    clicks for anyone with a Google account.
 *
 * The card never shows a wall of prose. One line of status, one action, and
 * the reason lives in a single sentence under the input where someone is about
 * to act on it.
 */

type ConnectionState = {
  connected: boolean;
  kind: 'subscription' | 'api_key' | 'local' | null;
  label: string | null;
  last4: string | null;
  machine: string | null;
};

type AgentConnectionState = {
  agents: { codex: ConnectionState; claude_code: ConnectionState; gemini: ConnectionState; glm: ConnectionState; kimi: ConnectionState };
  local: { connected: boolean; name: string | null; codex: boolean; claude_code: boolean };
};

/** Which fuel providers are usable, derived the same way for every caller. */
export function connectedProvidersOf(state: AgentConnectionState | null): string[] {
  if (!state) return [];
  const list: string[] = [];
  if (state.agents.codex.connected) list.push('openai');
  if (state.agents.claude_code.connected) list.push('anthropic');
  if (state.agents.gemini.connected) list.push('gemini');
  if (state.agents.glm.connected) list.push('zai');
  if (state.agents.kimi.connected) list.push('kimi');
  return list;
}

function statusLine(connection: ConnectionState): string {
  if (!connection.connected) return '';
  if (connection.kind === 'local') return `Connected on ${connection.machine ?? 'your computer'}`;
  if (connection.kind === 'subscription') return 'Subscription token saved';
  return `API key${connection.last4 ? ` ····${connection.last4}` : ''} connected`;
}

function KeyForm({ provider, placeholder, kind = 'api_key', hint, onConnected }: { provider: string; placeholder: string; kind?: 'api_key' | 'subscription'; hint?: string; onConnected: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.post('/api/fuel', { provider, key: key.trim(), kind });
          setKey('');
          onConnected();
        } catch (err) {
          setError(err instanceof Error ? err.message : "that didn't work");
        } finally {
          setBusy(false);
        }
      }}
      className="mt-3 space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={placeholder}
          className="min-w-[13rem] flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        />
        <button
          type="submit"
          disabled={busy || key.trim().length < 8}
          className="rounded-inset bg-action px-4 py-1.5 text-body font-medium text-white hover:bg-action-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
      {/* The key is pinged before it's stored, so this promise is true —
          coding-plan keys included, on their own endpoints. */}
      {(hint ?? keyHint(provider)) && <p className="text-meta text-ink-quiet">{hint ?? `Get one ${keyHint(provider)}. It’s checked before it’s saved.`}</p>}
      {error && <p role="alert" className="text-meta text-thread">{error}</p>}
    </form>
  );
}

/**
 * The one-command bridge. The old ritual — name a machine, mint a key, copy a
 * token, then assemble three commands — is collapsed to a single button that
 * mints the key itself and prints the whole thing as one pasteable line. The
 * card flips to Connected on its own: the poll in ConnectProviders is the
 * arbiter, not the popup theater.
 */
function BridgeSetup() {
  const [command, setCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<{ token: string }>('/api/companion-keys', { name: 'My computer' });
      setCommand(
        `curl -fsSL https://tryselvedge.com/install-companion | sh && $HOME/.local/bin/selvedge login --token ${made.token} && $HOME/.local/bin/selvedge runtime agents --login`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't go through");
    } finally {
      setBusy(false);
    }
  };

  if (!command) {
    return (
      <div className="mt-3">
        <button type="button" onClick={() => void start()} disabled={busy} className={btnPrimary}>
          {busy ? 'One moment…' : 'Use my ChatGPT plan'}
        </button>
        {error && <p role="alert" className="mt-2 text-meta text-thread">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3">
      <p className="text-body text-ink">Paste this into Terminal on your computer:</p>
      <CopyCommand command={command} />
      <p className="mt-2 text-meta text-ink-quiet">
        It signs Codex in with your ChatGPT account — the login stays on your computer. This card turns green when it connects,
        usually under a minute.
      </p>
    </div>
  );
}

function ProviderCard({
  title,
  tagline,
  connection,
  children,
}: {
  title: string;
  tagline: string;
  connection: ConnectionState;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-card border p-4 ${connection.connected ? 'border-action/40 bg-action-soft/30' : 'border-hairline bg-panel'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-body font-medium text-ink">{title}</p>
          <p className="mt-0.5 text-meta text-ink-dim">{tagline}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-meta font-medium ${connection.connected ? 'bg-action text-white' : 'bg-panel-soft text-ink-quiet'}`}>
          {connection.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      {connection.connected ? <p className="mt-3 text-meta text-ink">{statusLine(connection)}</p> : children}
    </div>
  );
}

export function ConnectProviders({ onStateChange }: { onStateChange?: (providers: string[]) => void } = {}) {
  const [state, setState] = useState<AgentConnectionState | null>(null);
  const [gptPath, setGptPath] = useState<'plan' | 'key'>('plan');
  const notify = useRef(onStateChange);
  notify.current = onStateChange;

  const load = useCallback(async () => {
    try {
      const next = await api.get<AgentConnectionState>('/api/agent-connections');
      setState(next);
      notify.current?.(connectedProvidersOf(next));
    } catch {
      // A failed poll keeps the last known state on screen; the next tick retries.
    }
  }, []);

  useEffect(() => {
    void load();
    // 5s, not 10: the bridge path ends with someone watching this card while a
    // Terminal command runs, and a minute of "did it work?" is the whole cost
    // we're trying to remove from setup.
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const empty: ConnectionState = { connected: false, kind: null, label: null, last4: null, machine: null };
  const agents = state?.agents ?? { codex: empty, claude_code: empty, gemini: empty, glm: empty, kimi: empty };

  return (
    <div className="grid gap-3">
      <ProviderCard title="GPT" tagline="Chat with GPT and build with Codex." connection={agents.codex}>
        {gptPath === 'plan' ? (
          <>
            <BridgeSetup />
            <button type="button" onClick={() => setGptPath('key')} className="mt-3 text-meta font-medium text-action hover:text-action-bright">
              Use an OpenAI API key instead →
            </button>
          </>
        ) : (
          <>
            <KeyForm provider="openai" placeholder="paste your OpenAI API key" onConnected={() => void load()} />
            <button type="button" onClick={() => setGptPath('plan')} className="mt-3 text-meta font-medium text-action hover:text-action-bright">
              ← Use my ChatGPT plan instead
            </button>
          </>
        )}
      </ProviderCard>

      <ProviderCard title="Claude" tagline="Chat with Claude and build with Claude Code." connection={agents.claude_code}>
        <KeyForm provider="anthropic" placeholder="paste your Anthropic API key" onConnected={() => void load()} />
        {/* Not an apology, a fact: pointing people at their Claude subscription
            here would point them at a locked door with our name on the sign. */}
        <p className="mt-2 text-meta text-ink-quiet">Anthropic allows Claude subscriptions only in its own apps, so Claude connects here with an API key.</p>
      </ProviderCard>

      <ProviderCard title="Gemini" tagline="Chat with Gemini." connection={agents.gemini}>
        <KeyForm provider="gemini" placeholder="paste your Gemini API key" onConnected={() => void load()} />
      </ProviderCard>

      {/* CODING PLANS people already pay for. Kimi and Z.ai sell flat-monthly
          coding subscriptions whose keys are made for third-party tools like
          this one — the opposite of the Claude situation, and worth its own
          shelf so a subscriber recognizes their plan by name. */}
      <details className="rounded-card border border-hairline bg-panel p-4">
        <summary className="cursor-pointer text-body font-medium text-ink">
          Have a coding subscription? GLM Coding Plan and Kimi Code work here
          {(agents.glm.connected || agents.kimi.connected) && <span className="ml-2 rounded-full bg-action px-2 py-0.5 text-meta font-medium text-white">Connected</span>}
        </summary>
        <div className="mt-3 grid gap-3">
          <ProviderCard title="GLM Coding Plan" tagline="Z.ai’s flat monthly plan builds here — no per-turn charge." connection={agents.glm}>
            <KeyForm provider="zai" kind="subscription" placeholder="paste your Z.ai key" hint="From z.ai → API Keys. Your plan covers the usage; the key is checked before it’s saved." onConnected={() => void load()} />
          </ProviderCard>
          <ProviderCard title="Kimi Code membership" tagline="Moonshot’s coding plan builds here on your membership." connection={agents.kimi}>
            <KeyForm provider="kimi" kind="subscription" placeholder="paste your Kimi Code API key" hint="From the Kimi Code Console (Andante plan or above). Checked before it’s saved." onConnected={() => void load()} />
          </ProviderCard>
        </div>
      </details>
    </div>
  );
}
