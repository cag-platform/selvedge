import { useEffect, useState } from 'react';
import { AgentChip } from '../components/AgentChip.js';
import { SelvedgeMark } from '../components/Logo.js';

type HarnessView = 'work' | 'preview' | 'proof';
type Showcase = {
  observed_at: string;
  project: { name: string; description: string; healthy: boolean; live_url: string };
  thread: { title: string; agent: string } | null;
  messages: Array<{ role: string; content: string; created_at: string; tools: Array<{ name: string; detail: string; ok: boolean; note?: string }>; answered_by: unknown }>;
  runs: Array<{ agent: string | null; model: string | null; status: string; verdict: string | null; changed_paths: string[]; started_at: string | null; finished_at: string | null }>;
  cards: Array<{ title: string; state: string; verdict: string | null; graded_by: string | null }>;
  workspace: { preview_available: boolean; operation_status: string | null; staged_changes_ready: boolean; evidence_available: boolean } | null;
};

function Work({ data }: { data: Showcase }) {
  return <div className="hero-live-work">{data.messages.map((message, index) => <article key={`${message.created_at}-${index}`} className={`hero-live-message ${message.role}`}><div><span>{message.role === 'owner' ? 'YOU' : message.role === 'activity' ? 'WORKSPACE' : String(message.answered_by || data.thread?.agent || 'AGENT').toUpperCase()}</span>{message.role === 'agent' && <AgentChip agent={String(message.answered_by || data.thread?.agent || 'codex')}/>}</div>{message.role !== 'activity' && <p>{message.content}</p>}{message.tools.length > 0 && <ul>{message.tools.map((tool, toolIndex) => <li key={`${tool.name}-${toolIndex}`} className={tool.ok ? '' : 'failed'}><b>{tool.ok ? '✓' : '×'}</b><span><strong>{tool.name}</strong><small>{tool.detail}{tool.note ? ` · ${tool.note}` : ''}</small></span></li>)}</ul>}</article>)}</div>;
}

function Proof({ data }: { data: Showcase }) {
  const run = data.runs[0];
  const card = data.cards[0];
  return <div className="hero-proof-view hero-live-proof"><div><small>LIVE PROJECT RECORD</small><h3>{card?.title || data.thread?.title || 'Latest project work'}</h3><p>Read directly from Selvedge’s persisted run and verification records.</p></div><ul><li><span>{run?.status === 'succeeded' ? '✓' : '•'}</span><p><strong>Agent run</strong><small>{run?.agent || 'No agent'} · {run?.model || 'default model'}</small></p><b>{run?.status || 'Unavailable'}</b></li><li><span>{run?.verdict ? '✓' : '•'}</span><p><strong>Verification</strong><small>{run?.verdict ? `Recorded verdict: ${run.verdict}` : 'No verdict recorded'}</small></p><b>{run?.verdict || 'Not recorded'}</b></li><li><span>{card ? '✓' : '•'}</span><p><strong>Work card</strong><small>{card ? `${card.state}${card.graded_by ? ` · graded ${card.graded_by}` : ''}` : 'No active card'}</small></p><b>{card?.verdict || card?.state || 'Unavailable'}</b></li><li><span>{data.workspace?.preview_available ? '✓' : '•'}</span><p><strong>App surface</strong><small>{data.workspace?.preview_available ? 'The project has a reachable app preview' : 'No preview currently recorded'}</small></p><b>{data.workspace?.preview_available ? 'Available' : 'Unavailable'}</b></li></ul>{run?.changed_paths.length ? <div className="hero-live-files"><small>CHANGED PATHS</small>{run.changed_paths.map(path => <code key={path}>{path}</code>)}</div> : null}</div>;
}

export function HeroHarness() {
  const [view, setView] = useState<HarnessView>('work');
  const [data, setData] = useState<Showcase | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch('/showcase/relay');
        if (!response.ok) throw new Error('showcase unavailable');
        const next = await response.json() as Showcase;
        if (active) { setData(next); setError(false); }
      } catch { if (active) setError(true); }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const status = data ? (data.project.healthy ? 'Live project healthy' : 'Live project needs attention') : error ? 'Live project unavailable' : 'Reading live project…';
  return <div id="product" className="hero-harness" aria-label="Live Selvedge project harness"><header className="hero-harness-bar"><div><SelvedgeMark className="h-5 w-5"/><strong>Selvedge</strong><span>{data?.project.name || 'Northstar Studio'}</span></div><b className={data?.project.healthy ? 'ready' : ''}><i/>{status}</b></header><nav className="hero-harness-tabs" aria-label="Project views">{(['work','preview','proof'] as const).map(item => <button type="button" key={item} aria-selected={view === item} onClick={() => setView(item)}>{item === 'work' ? 'Work' : item === 'preview' ? 'Live app' : 'Proof'}</button>)}<span className="hero-harness-replay">Live data</span></nav><div className="hero-harness-body">{!data && !error && <div className="hero-live-loading"><span/><p>Reading the project record…</p></div>}{error && <div className="hero-live-loading failed"><p>The public demo project is temporarily unavailable.</p><small>No fallback or invented activity is being shown.</small></div>}{data && view === 'work' && <Work data={data}/>} {data && view === 'preview' && <div className="hero-preview-view hero-live-preview"><div className="hero-browser-bar"><i/><i/><i/><span>{data.project.live_url}</span><b>Live demo</b></div><iframe title={`${data.project.name} live application`} src={data.project.live_url}/></div>}{data && view === 'proof' && <Proof data={data}/>}</div><footer><span>Live, isolated Northstar project · refreshed every 15 seconds</span><span>Persisted runs</span><span>Real app surface</span></footer></div>;
}
