import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AGENTS, type AgentId } from '../../shared/agents.js';
import { api } from '../lib/api.js';
import { AgentChip } from './AgentChip.js';
import { btnPrimary } from './ui.js';
import { ConnectForm } from '../pages/Connections.js';
import { CompanionKeys } from './CompanionKeys.js';
import { fuelLabel } from '../lib/fuel.js';

type OrgAgentPreferences = {
  preferred_agents: AgentId[] | null;
  agent_preferences_set: boolean;
};

/**
 * The only onboarding question that changes the room the owner enters.
 * It does not hide anybody: it tells Selvedge which familiar names should be
 * first and which connection paths to lead with. Empty means “help me choose.”
 */
export function AgentOnboarding() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AgentId[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [connected, setConnected] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);

  const refreshConnections = async () => {
    setChecking(true);
    setError('');
    try {
      const result = await api.get<{ connected: { provider: string; kind: string; status: string }[] }>('/api/fuel');
      setConnected(result.connected.filter((row) => row.status === 'active' && row.kind === 'api_key').map((row) => row.provider));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check connections. Try again.');
    } finally { setChecking(false); }
  };

  useEffect(() => {
    const resume = () => { setOpen(true); setStep(1); };
    window.addEventListener('selvedge:setup', resume);
    api.get<OrgAgentPreferences>('/api/org')
      .then((org) => {
        setSelected(org.preferred_agents ?? []);
        setOpen(!org.agent_preferences_set);
      })
      .catch(() => undefined);
    return () => window.removeEventListener('selvedge:setup', resume);
  }, []);

  const groups = useMemo(() => ({
    chat: AGENTS.filter((agent) => !agent.changesFiles && agent.live),
    coding: AGENTS.filter((agent) => agent.changesFiles && agent.live),
  }), []);

  if (!open) return null;

  const toggle = (id: AgentId) => setSelected((current) => current.includes(id) ? current.filter((agent) => agent !== id) : [...current, id]);
  const save = async (destination: string) => {
    setSaving(true);
    setError('');
    try {
      await api.patch('/api/org/agent-preferences', { agents: selected });
      window.dispatchEvent(new CustomEvent('selvedge:agent-preferences', { detail: selected }));
      setOpen(false);
      navigate(destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Those choices could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const providers = [...new Set(AGENTS.filter((agent) => selected.includes(agent.id)).map((agent) => agent.provider))];
  const choices = providers.length ? providers : ['openai', 'anthropic', 'gemini'];

  const AgentChoice = ({ id }: { id: AgentId }) => {
    const agent = AGENTS.find((candidate) => candidate.id === id)!;
    const active = selected.includes(id);
    return (
      <button type="button" aria-pressed={active} onClick={() => toggle(id)} className={`flex min-h-14 items-center gap-3 rounded-card border px-4 py-3 text-left transition ${active ? 'border-action bg-panel-soft' : 'border-hairline bg-panel hover:border-ink-quiet'}`}>
        <AgentChip agent={id} />
        <span><strong className="block text-body font-medium text-ink">{agent.name}</strong><small className="text-meta text-ink-dim">{agent.changesFiles ? 'Builds and changes code' : 'Chats, plans, and reviews'}</small></span>
        <span className="ml-auto text-action" aria-hidden>{active ? '✓' : '+'}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-ink/45 p-4" role="dialog" aria-modal="true" aria-labelledby="agent-onboarding-title">
      <section className="my-auto w-full max-w-3xl rounded-pane border border-hairline bg-paper p-6 shadow-2xl sm:p-8">
        <p className="font-mono text-tech uppercase tracking-wider text-action" aria-live="polite">Step {step} of 3 · {step === 1 ? 'Choose your AI' : step === 2 ? 'Connect' : 'Open your project'}</p>
        {step === 1 && <>
        <h1 id="agent-onboarding-title" className="mt-2 font-display text-[clamp(2rem,5vw,3.6rem)] leading-[1.05] tracking-[-.035em] text-ink">Your projects and every AI, in one place.</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-dim">Bring in a project, connect the agents you already use, and keep every conversation, change, and release together.</p>

        <ol className="mt-6 grid gap-2 sm:grid-cols-3" aria-label="Getting started">
          <li className="rounded-card bg-panel-soft p-3"><span className="text-meta font-medium text-action">1 · Choose</span><p className="mt-1 text-meta text-ink-dim">Pick the AI you use.</p></li>
          <li className="rounded-card bg-panel-soft p-3"><span className="text-meta font-medium text-action">2 · Connect</span><p className="mt-1 text-meta text-ink-dim">One connection is enough to start.</p></li>
          <li className="rounded-card bg-panel-soft p-3"><span className="text-meta font-medium text-action">3 · Project</span><p className="mt-1 text-meta text-ink-dim">Bring one in or start an idea.</p></li>
        </ol>

        <h2 className="mt-7 text-headline font-medium text-ink">Which agents do you use?</h2>
        <p className="mt-1 text-body text-ink-dim">Choose any that are familiar. You can change this later.</p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div><h2 className="mb-3 text-body font-medium text-ink">Chat and thinking</h2><div className="grid gap-2">{groups.chat.map((agent) => <AgentChoice key={agent.id} id={agent.id} />)}</div></div>
          <div><h2 className="mb-3 text-body font-medium text-ink">Coding and building</h2><div className="grid gap-2">{groups.coding.map((agent) => <AgentChoice key={agent.id} id={agent.id} />)}</div></div>
        </div>
        </>}
        {step === 2 && <div className="mt-4 space-y-4">
          <h1 id="agent-onboarding-title" className="font-display text-3xl text-ink">Connect your AI.</h1>
          <p className="text-body text-ink-dim">Connect one to start. You can add the others any time in Connections.</p>
          {connected.length > 0 && <p role="status" className="text-body text-action">Connected: {connected.map(fuelLabel).join(', ')}</p>}
          {choices.filter((provider) => !connected.includes(provider)).map((provider) => <ConnectForm key={provider} providers={[provider]} onConnected={() => void refreshConnections()} />)}
          <details className="rounded-card border border-hairline p-4">
            <summary className="cursor-pointer text-body text-ink">Use a coding subscription on your computer</summary>
            <p className="my-3 text-meta text-ink-dim">This currently needs the computer companion and a one-time Terminal setup. A coding subscription does not connect general GPT or Claude chat.</p>
            <CompanionKeys />
          </details>
          <button type="button" disabled={checking} onClick={() => void refreshConnections()} className="text-meta text-action">{checking ? 'Checking…' : 'Check connections again'}</button>
        </div>}
        {step === 3 && <div className="mt-4 space-y-4">
          <h1 id="agent-onboarding-title" className="font-display text-3xl text-ink">What are we working on?</h1>
          <p className="text-body text-ink-dim">Open a project, then tell your agent what you want to do. Your conversation and changes stay together in the Workspace.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button disabled={saving} onClick={() => void save('/migrate')} className={btnPrimary}>Bring in a project →</button>
            <button disabled={saving} onClick={() => void save('/?new=1')} className={btnPrimary}>Start a new idea →</button>
          </div>
          <button disabled={saving} onClick={() => void save('/')} className="text-body text-action">Open my existing projects →</button>
        </div>}
        {error && <p role="alert" className="mt-4 text-body text-thread">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5">
          {step > 1 ? <button disabled={saving} onClick={() => setStep(step === 3 ? 2 : 1)} className="text-body text-ink-dim">← Back</button> : <button disabled={saving} onClick={() => void save('/')} className="text-body text-ink-dim">Set up later</button>}
          {step === 1 && <button onClick={() => { setStep(2); void refreshConnections(); }} className={btnPrimary}>Continue →</button>}
          {step === 2 && <button disabled={checking} onClick={() => setStep(3)} className={btnPrimary}>{connected.length ? 'Continue to project →' : 'Connect later →'}</button>}
        </div>
      </section>
    </div>
  );
}
