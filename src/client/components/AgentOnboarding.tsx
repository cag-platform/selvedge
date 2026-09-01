import { useEffect, useMemo, useState } from 'react';
import { AGENTS, type AgentId } from '../../shared/agents.js';
import { api } from '../lib/api.js';
import { AgentChip } from './AgentChip.js';
import { btnPrimary } from './ui.js';

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
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AgentId[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<OrgAgentPreferences>('/api/org')
      .then((org) => {
        setSelected(org.preferred_agents ?? []);
        setOpen(!org.agent_preferences_set);
      })
      .catch(() => undefined);
  }, []);

  const groups = useMemo(() => ({
    chat: AGENTS.filter((agent) => !agent.changesFiles && agent.live),
    coding: AGENTS.filter((agent) => agent.changesFiles && agent.live),
  }), []);

  if (!open) return null;

  const toggle = (id: AgentId) => setSelected((current) => current.includes(id) ? current.filter((agent) => agent !== id) : [...current, id]);
  const save = async (agents = selected) => {
    setSaving(true);
    setError('');
    try {
      await api.patch('/api/org/agent-preferences', { agents });
      window.dispatchEvent(new CustomEvent('selvedge:agent-preferences', { detail: agents }));
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Those choices could not be saved.');
    } finally {
      setSaving(false);
    }
  };

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
        <p className="font-mono text-tech uppercase tracking-wider text-action">Make Selvedge yours</p>
        <h1 id="agent-onboarding-title" className="mt-2 font-display text-[clamp(2rem,5vw,3.6rem)] leading-[1.05] tracking-[-.035em] text-ink">What chat and coding agents do you use?</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-dim">Pick the agents you use. You can change this later.</p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div><h2 className="mb-3 text-body font-medium text-ink">Chat and thinking</h2><div className="grid gap-2">{groups.chat.map((agent) => <AgentChoice key={agent.id} id={agent.id} />)}</div></div>
          <div><h2 className="mb-3 text-body font-medium text-ink">Coding and building</h2><div className="grid gap-2">{groups.coding.map((agent) => <AgentChoice key={agent.id} id={agent.id} />)}</div></div>
        </div>
        {error && <p role="alert" className="mt-4 text-body text-thread">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5">
          <button type="button" disabled={saving} onClick={() => save([])} className="text-body text-ink-dim hover:text-ink">I’m not sure — help me choose</button>
          <button type="button" disabled={saving} onClick={() => save()} className={btnPrimary}>{saving ? 'Saving…' : `Continue${selected.length ? ` with ${selected.length}` : ''} →`}</button>
        </div>
      </section>
    </div>
  );
}
