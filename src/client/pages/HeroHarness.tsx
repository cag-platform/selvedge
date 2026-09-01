import { useEffect, useState } from 'react';
import { AgentChip } from '../components/AgentChip.js';
import { SelvedgeMark } from '../components/Logo.js';
import { DemoAppPreview } from './DemoAppPreview.js';

type TaskId = 'relay' | 'juniper' | 'parcel';
type SideView = 'context' | 'preview' | 'proof';

const tasks = {
  relay: {
    name: 'Relay', summary: 'Restore the health check', agent: 'claude-code', side: 'preview' as SideView,
    owner: 'Why is Relay showing down if crews can still use it?',
    steps: [['Fetch','GET /health','404 Not Found'],['Fetch','GET /api/health','200 OK'],['Read','railway.json health-check configuration','']],
    answer: 'Crews are fine. The app moved its check from /health to /api/health, but monitoring still calls the old address. I can add a backwards-compatible alias and update the check so the all-clear means something again.',
    context: ['Railway deployment', 'Health endpoint', 'Crew handoff app'], proof: ['Current app stayed available', 'Failure reproduced', 'Configuration mismatch isolated'],
  },
  juniper: {
    name: 'Juniper', summary: 'Choose the collection-card direction', agent: 'claude-code', side: 'context' as SideView,
    owner: '@claudecode @codex The autumn collection cards feel too much like a catalog. Should the product image or the collection name lead?',
    steps: [], answer: '', context: ['Autumn collection', 'Existing card anatomy', 'Mobile reading order'], proof: ['Two independent opinions', 'Shared project context', 'Nothing built before decision'],
  },
  parcel: {
    name: 'Parcel', summary: 'Make delivery updates easier to scan', agent: 'codex', side: 'proof' as SideView,
    owner: 'Make delivery updates easier to scan. The important change should read first without losing the carrier detail.',
    steps: [['Edit','app/components/DeliveryTimeline.tsx',''],['Edit','app/styles/delivery.css',''],['Test','delivery timeline tests','Passed']],
    answer: 'Done. The current delivery state leads, supporting carrier detail stays one line below, and repeated webhooks still collapse into one update. Keyboard and screen-reader labels are covered.',
    context: ['Carrier webhook contract', 'Delivery timeline', 'Accessibility baseline'], proof: ['Focused tests passed', 'Repeated webhooks deduplicated', 'Screen-reader labels covered'],
  },
} as const;

function ContextPane({ task }: { task: typeof tasks[TaskId] }) {
  return <div className="hero-demo-context"><small>WHAT GOVERNS THIS WORK</small><h3>{task.name}</h3><p>This is one of Northstar Studio’s projects.</p><div><small>CURRENT BUILDER</small><p><AgentChip agent={task.agent}/><strong>{task.agent === 'claude-code' ? 'Claude Code' : 'Codex'}</strong></p><a>Change builder — project context stays here</a></div><small>ATTACHED CONTEXT</small><ul>{task.context.map(item => <li key={item}>✓ {item}</li>)}</ul></div>;
}

function ProofPane({ task }: { task: typeof tasks[TaskId] }) {
  return <div className="hero-demo-proof"><small>RESULT RECORD</small><h3>Ready for review</h3><ul>{task.proof.map(item => <li key={item}><span>✓</span><p><strong>{item}</strong><small>Recorded in the project history</small></p></li>)}</ul><button type="button">Review the work →</button></div>;
}

export function HeroHarness() {
  const [taskId, setTaskId] = useState<TaskId>('relay');
  const [side, setSide] = useState<SideView>('preview');
  const [stage, setStage] = useState(0);
  const task = tasks[taskId];
  useEffect(() => {
    setStage(0); setSide(task.side);
    const timers = [700, 1450, 2400].map((delay, index) => window.setTimeout(() => setStage(index + 1), delay));
    return () => timers.forEach(window.clearTimeout);
  }, [taskId, task.side]);
  function choose(id: TaskId) { setTaskId(id); }
  return <div id="product" className="hero-harness hero-selvedge-demo" aria-label="Interactive Selvedge product demonstration"><header className="hero-harness-bar"><div><SelvedgeMark className="h-5 w-5"/><strong>Selvedge</strong><span>Northstar Studio</span></div><b className={stage === 3 ? 'ready' : ''}><i/>{stage === 3 ? 'Ready for review' : 'Agent working'}</b></header><div className="hero-demo-shell"><aside className="hero-demo-rail"><small>PROJECTS</small>{(Object.keys(tasks) as TaskId[]).map(id => <button type="button" key={id} aria-selected={taskId === id} onClick={() => choose(id)}><strong>{tasks[id].name}</strong><span>{tasks[id].summary}</span><AgentChip agent={tasks[id].agent}/></button>)}</aside><main className="hero-demo-thread"><header><div><small>{task.name} / CONVERSATION</small><h3>{task.summary}</h3></div><AgentChip agent={task.agent}/></header><section><article className="hero-demo-message"><small>YOU</small><p>{task.owner}</p></article>{taskId === 'juniper' ? <div className={`hero-demo-opinions ${stage > 0 ? 'shown' : ''}`}><article><div><AgentChip agent="claude-code"/><strong>Claude Code</strong></div><p>Let the collection name lead. A stable title and image frame makes a mixed catalog easy to scan on a phone.</p></article><article><div><AgentChip agent="codex"/><strong>Codex</strong></div><p>Let the image lead, but keep the collection name anchored in one position. The distinction should come from the work, not a louder card.</p></article></div> : <><div className={`hero-demo-tools ${stage > 0 ? 'shown' : ''}`}>{task.steps.map(([verb,detail,note],index) => <div key={detail} style={{transitionDelay:`${index * 110}ms`}}><span>{note && note !== 'Passed' ? '×' : '✓'}</span><p><strong>{verb}</strong><small>{detail}{note ? ` · ${note}` : ''}</small></p></div>)}</div><article className={`hero-demo-message agent ${stage > 2 ? 'shown' : ''}`}><div><AgentChip agent={task.agent}/><small>{task.agent === 'claude-code' ? 'CLAUDE CODE' : 'CODEX'}</small></div><p>{task.answer}</p></article></>}</section></main><aside className="hero-demo-side"><nav>{(['context','preview','proof'] as SideView[]).map(view => <button type="button" key={view} aria-selected={side === view} onClick={() => setSide(view)}>{view === 'preview' ? 'App' : view}</button>)}</nav>{side === 'context' && <ContextPane task={task}/>} {side === 'proof' && <ProofPane task={task}/>} {side === 'preview' && (taskId === 'relay' ? <DemoAppPreview embedded/> : <div className="hero-demo-no-preview"><small>APP PREVIEW</small><h3>{task.name}</h3><p>Open this task’s result after the agent finishes.</p><button type="button" onClick={() => setSide('proof')}>See recorded proof →</button></div>)}</aside></div><footer><span>Repeatable demonstrations from Selvedge’s isolated Northstar workspace</span><span>Real product UI</span><span>No customer data</span></footer></div>;
}
