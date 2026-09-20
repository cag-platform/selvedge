import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentId } from '../../shared/agents.js';
import { api } from '../lib/api.js';
import { btnPrimary } from './ui.js';
import { ConnectProviders } from './ConnectProviders.js';
import { ImportHistory } from './ImportHistory.js';

type OrgAgentPreferences = {
  preferred_agents: AgentId[] | null;
  agent_preferences_set: boolean;
};

/**
 * FIRST SIGN-IN, TWO QUESTIONS, DONE.
 *
 * This used to open with a quiz — "which of these twelve agents do you use?" —
 * before anything worked. The quiz is gone because connecting IS the answer:
 * whoever connects GPT uses GPT, and `preferred_agents` is derived from the
 * connections rather than asked as homework. What remains is the shortest
 * honest path:
 *
 *   1. Connect one AI (three cards, one action each).
 *   2. Bring your stuff (a project, your old chats), or start clean.
 *
 * Both steps are skippable, because a door that only opens after paperwork is
 * a wall. "Set up later" saves the empty preference — which the rest of the
 * product already reads as "help me choose" — and the Now page keeps a
 * "Finish setup" button that re-opens this via the `selvedge:setup` event.
 */
const PROVIDER_AGENTS: Record<string, AgentId[]> = {
  openai: ['gpt', 'codex'],
  anthropic: ['claude', 'claude-code'],
  gemini: ['gemini', 'gemini-build'],
  zai: ['glm-build'],
  kimi: ['kimi', 'kimi-code'],
};

export function AgentOnboarding() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [connected, setConnected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const resume = () => { setOpen(true); setStep(1); };
    window.addEventListener('selvedge:setup', resume);
    api.get<OrgAgentPreferences>('/api/org')
      .then((org) => setOpen(!org.agent_preferences_set))
      .catch(() => undefined);
    return () => window.removeEventListener('selvedge:setup', resume);
  }, []);

  if (!open) return null;

  const save = async (destination: string) => {
    setSaving(true);
    setError('');
    const agents = connected.flatMap((provider) => PROVIDER_AGENTS[provider] ?? []);
    try {
      await api.patch('/api/org/agent-preferences', { agents });
      window.dispatchEvent(new CustomEvent('selvedge:agent-preferences', { detail: agents }));
      setOpen(false);
      navigate(destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-ink/45 p-4" role="dialog" aria-modal="true" aria-labelledby="agent-onboarding-title">
      <section className="my-auto w-full max-w-2xl rounded-pane border border-hairline bg-paper p-6 shadow-2xl sm:p-8">
        <p className="font-mono text-tech uppercase tracking-wider text-action" aria-live="polite">
          Step {step} of 2 · {step === 1 ? 'Connect your AI' : 'Bring your stuff'}
        </p>

        {step === 1 && (
          <>
            <h1 id="agent-onboarding-title" className="mt-2 font-display text-3xl leading-tight tracking-[-.03em] text-ink">Connect the AI you already pay for.</h1>
            <p className="mt-2 text-body text-ink-dim">One is enough to start. Add the rest any time under Connections.</p>
            <div className="mt-5">
              <ConnectProviders onStateChange={setConnected} />
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 id="agent-onboarding-title" className="mt-2 font-display text-3xl leading-tight tracking-[-.03em] text-ink">Bring your stuff.</h1>
            <p className="mt-2 text-body text-ink-dim">Both optional. Everything here can also be done later.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button disabled={saving} onClick={() => void save('/migrate')} className={btnPrimary}>Bring in a project →</button>
              <button disabled={saving} onClick={() => void save('/?new=1')} className={btnPrimary}>Start a new idea →</button>
            </div>
            <p className="mt-4 text-meta text-ink-dim">From GitHub, Replit, Bolt, Cursor, Lovable — anywhere your app lives now.</p>
            <div className="mt-5 border-t border-hairline pt-4">
              <p className="text-body font-medium text-ink">Your old conversations</p>
              <ImportHistory />
            </div>
          </>
        )}

        {error && <p role="alert" className="mt-4 text-body text-thread">{error}</p>}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5">
          {step === 1 ? (
            <button disabled={saving} onClick={() => void save('/')} className="text-body text-ink-dim">Set up later</button>
          ) : (
            <button disabled={saving} onClick={() => setStep(1)} className="text-body text-ink-dim">← Back</button>
          )}
          {step === 1 && (
            <button onClick={() => setStep(2)} className={btnPrimary}>
              {connected.length ? 'Continue →' : 'Connect later →'}
            </button>
          )}
          {step === 2 && (
            <button disabled={saving} onClick={() => void save('/')} className="text-body text-action">Open my projects →</button>
          )}
        </div>
      </section>
    </div>
  );
}
