import { useEffect, useMemo, useState } from 'react';
import { AgentChip } from '../components/AgentChip.js';
import { SelvedgeMark } from '../components/Logo.js';

type HarnessView = 'work' | 'preview' | 'proof';

const run = [
  { label: 'Project received', detail: 'Replit export opened in a private workspace', agent: 'selvedge' },
  { label: 'System mapped', detail: 'React · Postgres · distributor API · 4 jobs', agent: 'claude' },
  { label: 'Workspace ready', detail: 'Dependencies installed and development data connected', agent: 'codex' },
  { label: 'Order flow repaired', detail: 'Receipt-based confirmation with durable retries', agent: 'codex' },
  { label: 'Preview running', detail: 'Threadline is ready to use without touching production', agent: 'selvedge' },
  { label: 'Independently checked', detail: 'Sign in, catalog, cart, and order submission passed', agent: 'gpt' },
];

function ThreadlinePreview() {
  const [category, setCategory] = useState<'All' | 'Jackets' | 'Shirting'>('All');
  const [ordered, setOrdered] = useState(false);
  const products = [
    { kind: 'Jackets', name: 'Hopsack travel jacket', meta: 'Navy · Fall 26', price: '$248' },
    { kind: 'Shirting', name: 'Brushed oxford shirt', meta: 'Chalk · Fall 26', price: '$82' },
  ].filter((item) => category === 'All' || item.kind === category);

  return <div className="hero-app">
    <header><div><b>THREADLINE</b><span>Wholesale</span></div><nav>Catalog&nbsp;&nbsp; Orders&nbsp;&nbsp; Account</nav></header>
    {ordered ? <div className="hero-app-success"><span>✓</span><small>ORDER TW-1849</small><h3>Distributor receipt confirmed.</h3><p>The retailer and Northline Distribution have both received the order.</p><button type="button" onClick={() => setOrdered(false)}>Return to catalog</button></div> : <>
      <div className="hero-app-intro"><small>FALL DELIVERY · 128 STYLES</small><h3>Order the line.<br/>Skip the email chain.</h3></div>
      <div className="hero-app-filters">{(['All','Jackets','Shirting'] as const).map(item => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}</div>
      <div className="hero-app-products">{products.map(item => <article key={item.name}><div/><small>{item.kind}</small><strong>{item.name}</strong><span>{item.meta} <b>{item.price}</b></span><button type="button" onClick={() => setOrdered(true)}>Add and submit</button></article>)}</div>
    </>}
  </div>;
}

export function HeroHarness() {
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [step, setStep] = useState(reduceMotion ? run.length - 1 : 0);
  const [playing, setPlaying] = useState(!reduceMotion);
  const [view, setView] = useState<HarnessView>(reduceMotion ? 'preview' : 'work');

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (step >= run.length - 1) {
        setPlaying(false);
        setView('preview');
        return;
      }
      const next = step + 1;
      setStep(next);
      if (next === 4) setView('preview');
      if (next === 5) setView('proof');
    }, step === 0 ? 1100 : 1450);
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  const status = step === run.length - 1 ? 'Ready for approval' : step >= 4 ? 'Preview ready' : 'Working safely';
  const completed = useMemo(() => run.slice(0, step + 1), [step]);

  function restart() { setStep(0); setView('work'); setPlaying(true); }
  function choose(next: HarnessView) { setView(next); setPlaying(false); }

  return <div id="product" className="hero-harness" aria-label="Interactive replay of a real Selvedge project">
    <header className="hero-harness-bar"><div><SelvedgeMark className="h-5 w-5"/><strong>Selvedge</strong><span>Threadline Wholesale</span></div><b className={step === run.length - 1 ? 'ready' : ''}><i/>{status}</b></header>
    <nav className="hero-harness-tabs" aria-label="Project views">
      {(['work','preview','proof'] as const).map(item => <button type="button" key={item} aria-selected={view === item} onClick={() => choose(item)}>{item === 'work' ? 'Work' : item === 'preview' ? 'Preview' : 'Proof'}{item === 'preview' && step >= 4 ? <i/> : null}</button>)}
      <button type="button" className="hero-harness-replay" onClick={restart}>{playing ? 'Running…' : 'Replay ↻'}</button>
    </nav>
    <div className="hero-harness-body">
      {view === 'work' && <div className="hero-work-view">
        <div className="hero-work-prompt"><small>YOU</small><p>Bring Threadline over from Replit. Fix order submissions and show me the result without touching the live app.</p></div>
        <div className="hero-run-list" aria-live="polite">{completed.map((item, index) => <div key={item.label} className={index === step && playing ? 'active' : ''}><span>{index < step || step === run.length - 1 ? '✓' : index === step ? '•' : ''}</span><AgentChip agent={item.agent}/><p><strong>{item.label}</strong><small>{item.detail}</small></p></div>)}</div>
        <div className="hero-run-note"><span>Original stays live</span><span>Secrets stay scoped</span><span>Nothing ships yet</span></div>
      </div>}
      {view === 'preview' && <div className="hero-preview-view"><div className="hero-browser-bar"><i/><i/><i/><span>private-preview.selvedge.work</span><b>Private</b></div><ThreadlinePreview/></div>}
      {view === 'proof' && <div className="hero-proof-view"><div><small>INDEPENDENT VERIFICATION</small><h3>The rebuilt order path works.</h3><p>Checked against the same user journey that failed in production.</p></div><ul><li><span>✓</span><p><strong>Retailer signs in</strong><small>Test account reached the private catalog</small></p><b>Passed</b></li><li><span>✓</span><p><strong>Order reaches distributor</strong><small>Receipt ND-84721 returned in 1.4 seconds</small></p><b>Passed</b></li><li><span>✓</span><p><strong>Retry does not duplicate</strong><small>The same request produced one distributor order</small></p><b>Passed</b></li><li><span>✓</span><p><strong>Production unchanged</strong><small>No deployment or live database write occurred</small></p><b>Passed</b></li></ul><button type="button" onClick={() => setView('preview')}>Open the working preview →</button></div>}
    </div>
    <footer><span>Sanitized replay from a seeded Selvedge project</span><span>Private workspace</span><span>Owner approval</span></footer>
  </div>;
}
