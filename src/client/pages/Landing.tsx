import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { SelvedgeLockup } from '../components/Logo.js';
import { AgentChip } from '../components/AgentChip.js';
import { btnGhost, btnPrimary, eyebrowCls } from '../components/ui.js';
import { BYO_KEYS_LINE, FOUNDING_MEMBER_BADGE, PLAN_TAGLINE, planBullets, priceLine, yearlySavingLine } from '../../shared/plans.js';

function Message({ who, agent, children, muted = false }: { who: string; agent?: string; children: React.ReactNode; muted?: boolean }) {
  return <div className={`landing-message ${muted ? 'landing-message-muted' : ''}`}><div className="flex items-center gap-2">{agent && <AgentChip agent={agent} />}<p className={eyebrowCls}>{who}</p></div><div className="mt-2 text-body-lg text-ink">{children}</div></div>;
}
function ContextLine({ children }: { children: React.ReactNode }) { return <p className="landing-context-line font-mono text-tech text-ink-quiet">{children}</p>; }
function ProjectHeader({ detail }: { detail: string }) {
  return <div className="flex items-center justify-between gap-4 border-b border-hairline px-4 py-3 sm:px-6"><div><p className="text-body font-medium text-ink">Loom / Onboarding</p><p className="mt-0.5 text-meta text-ink-quiet">One project conversation</p></div><p className="font-mono text-tech text-ink-quiet">{detail}</p></div>;
}

/** Used by the landing page and the social-card capture script. */
export function SampleThread({ short = false, caption = true }: { short?: boolean; caption?: boolean } = {}) {
  return <div><div className="landing-thread overflow-hidden border border-hairline bg-panel"><ProjectHeader detail="12 conversations in context" /><div className="px-4 py-5 sm:px-6 sm:py-7">
    <Message who="You">We need to rethink onboarding. <span className="text-brass">@claude</span>, make the strongest case for removing the setup wizard. <span className="text-brass">@gpt</span>, disagree with it.</Message>
    <div className="landing-answer-pair mt-6"><Message who="Claude" agent="claude">Remove it. The wizard asks people to describe a project before they have seen Selvedge use one. Let them bring a conversation first; the project can take shape from evidence.</Message><Message who="GPT" agent="gpt">I disagree with Claude. A short wizard can establish the project boundary before imported chats muddy it. Cut it to one decision: what belongs here?</Message></div>
    {!short && <><ContextLine>↳ both answers used the same 12 imported conversations</ContextLine><Message who="You" muted>Keep the boundary question. Move it after import. <span className="text-brass">@codex</span> make that change in the onboarding branch.</Message></>}
  </div>{!short && <div className="border-t border-hairline px-4 py-3 sm:px-6"><div className="flex items-center gap-2 font-mono text-tech text-ink-dim"><AgentChip agent="codex" /><span className="text-healthy">✓</span> updated onboarding · 4 files · preview ready</div></div>}</div>{caption && <p className="mt-2 text-meta text-ink-quiet">A sample project conversation.</p>}</div>;
}

function SectionIntro({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <div className="landing-section-intro"><p className="font-mono text-tech text-action-bright">{number}</p><h2 className="mt-3 font-display text-section font-medium text-ink">{title}</h2><p className="mt-4 max-w-md text-body-lg text-ink-dim">{children}</p></div>;
}


/**
 * THE PRICE, RENDERED FROM THE SAME TABLE THAT ENFORCES IT.
 *
 * Every number here — two projects, thirty days, sixty minutes, twelve
 * dollars — is read from `shared/plans.ts`, which is what
 * `server/billing/entitlements.ts` reads to decide what an account may
 * actually do. Not a convention: a marketing page that says "60 build minutes"
 * while the server allows 30 is a bug nobody writes on purpose, and it only
 * happens when the number lives in two files.
 *
 * The yearly saving is worked out from the two prices on the page rather than
 * asserted. "2 months free" is something a person can check against the
 * figures in front of them; "20% off" is something they have to take on trust.
 * Same reason there is no countdown and no struck-through price: the founding
 * member line is a promise kept in a database column, and dressing it as
 * scarcity would make the one true thing on this page look like the fake ones
 * everywhere else.
 */
function PricingCards() {
  const [yearly, setYearly] = useState(false);
  const saving = yearlySavingLine('pro');

  return (
    <div className="landing-plans">
      <div className="landing-plan">
        <p className={eyebrowCls}>Free</p>
        <p className="landing-plan-price font-display text-section font-medium text-ink">{priceLine('free')}</p>
        <p className="landing-plan-note font-mono text-tech">Free forever, not free for now</p>
        <p className="mt-2 text-body-lg text-ink-dim">{PLAN_TAGLINE.free}</p>
        <ul className="landing-plan-list">{planBullets('free').map((line) => <li key={line}>{line}</li>)}</ul>
        <Link to="/sign-up" className="landing-plan-cta landing-plan-cta-quiet">Start free</Link>
        <p className="mt-3 font-mono text-tech text-ink-quiet">No card. No trial timer.</p>
      </div>

      <div className="landing-plan landing-plan-primary">
        <div className="flex items-baseline justify-between gap-3">
          <p className={eyebrowCls}>Pro</p>
          {/*
            A toggle rather than two cards: the plan is one plan, and showing it
            twice would imply a choice about what you get rather than about how
            often you are charged.
          */}
          <button
            type="button"
            onClick={() => setYearly(!yearly)}
            aria-pressed={yearly}
            className="font-mono text-tech text-action-bright underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          >
            {yearly ? 'show monthly' : `pay yearly${saving ? ` — ${saving}` : ''}`}
          </button>
        </div>
        <p className="landing-plan-price font-display text-section font-medium text-ink">{priceLine('pro', yearly ? 'yearly' : 'monthly')}</p>
        <p className="landing-plan-badge font-mono text-tech">{FOUNDING_MEMBER_BADGE}</p>
        <p className="mt-2 text-body-lg text-ink-dim">{PLAN_TAGLINE.pro}</p>
        <ul className="landing-plan-list">{planBullets('pro').map((line) => <li key={line}>{line}</li>)}</ul>
        <Link to="/sign-up" className={`${btnPrimary} landing-plan-cta`}>Go Pro</Link>
      </div>
    </div>
  );
}

/**
 * The three questions somebody actually has before paying, answered plainly.
 * `<details>` rather than a scripted accordion: it opens without JavaScript,
 * it is readable by a crawler, and the answer is in the page whether or not
 * anyone clicks.
 */
function PricingFaq() {
  const qa: Array<[string, string]> = [
    ['What happens to my data on Free?', 'Nothing is deleted. History older than the window is locked rather than removed, it unlocks the moment you upgrade, and an export includes all of it at every tier.'],
    ['What are build minutes?', 'Time your sandboxes spend building and previewing your projects. Previews sleep after ten idle minutes, and a build that starts with minutes left is always allowed to finish.'],
    ['Will the price go up?', `For new accounts, eventually. Anyone who subscribes now keeps ${priceLine('pro')} through any later raise — that is what the founding member line means.`],
  ];
  return (
    <div className="landing-faq">
      {qa.map(([q, a]) => (
        <details key={q}>
          <summary className="text-body text-ink">{q}</summary>
          <p className="mt-2 text-body text-ink-dim">{a}</p>
        </details>
      ))}
    </div>
  );
}

type DemoStep = 'route' | 'think' | 'switch' | 'preview' | 'remember';

const DEMO_STEPS: Array<{ id: DemoStep; label: string }> = [
  { id: 'route', label: 'Route' },
  { id: 'think', label: 'Think' },
  { id: 'switch', label: 'Switch builder' },
  { id: 'preview', label: 'Preview' },
  { id: 'remember', label: 'Remember' },
];

const DEMO_PROMPTS = [
  'Improve the onboarding without adding another step',
  'Challenge our decision to remove the setup wizard',
  'Ship the new onboarding landing page',
] as const;

function ProductDemo() {
  const [step, setStep] = useState<DemoStep>('route');
  const [prompt, setPrompt] = useState<string>(DEMO_PROMPTS[0]);
  const [startedPrompt, setStartedPrompt] = useState<string>(DEMO_PROMPTS[0]);
  const [theme, setTheme] = useState<'night' | 'light'>('night');
  const promptId = useId();
  const activeIndex = DEMO_STEPS.findIndex((item) => item.id === step);
  const reached = (candidate: DemoStep) => activeIndex >= DEMO_STEPS.findIndex((item) => item.id === candidate);

  function beginDemo() {
    const next = prompt.trim();
    if (!next) return;
    setStartedPrompt(next);
    setStep('route');
  }

  return (
    <div className={`landing-demo landing-demo-${theme}`} aria-label="Interactive Selvedge product demonstration">
      <div className="landing-demo-bar">
        <div className="landing-window-dots" aria-hidden="true"><i /><i /><i /></div>
        <p>Selvedge · Loom</p>
        <button type="button" onClick={() => setTheme(theme === 'night' ? 'light' : 'night')} aria-label={`Use ${theme === 'night' ? 'light' : 'Night Weave'} demo theme`}>
          {theme === 'night' ? 'Light' : 'Night Weave'}
        </button>
      </div>

      <div className="landing-demo-guide" aria-label="Demo stages">
        {DEMO_STEPS.map((item, index) => <button key={item.id} type="button" onClick={() => setStep(item.id)} aria-current={step === item.id ? 'step' : undefined}>
          <span>{String(index + 1).padStart(2, '0')}</span>{item.label}
        </button>)}
      </div>

      <div className="landing-demo-shell">
        <aside className="landing-demo-threads" aria-label="Project conversations">
          <p className="landing-demo-label">PROJECT / LOOM</p>
          <strong>Onboarding</strong>
          <div className="landing-demo-thread active"><span>Now</span><b>{startedPrompt}</b><small>just now · CX</small></div>
          <div className="landing-demo-thread"><span>Decision</span><b>Where should project setup happen?</b><small>yesterday · CL</small></div>
          <div className="landing-demo-thread"><span>Research</span><b>Customer import interviews</b><small>Feb 12 · GP</small></div>
        </aside>

        <section className="landing-demo-work" aria-live="polite">
          <div className="landing-demo-heading">
            <p className="landing-demo-label">CURRENT WORK</p>
            <h3>{startedPrompt}</h3>
            <p><span>Context received</span> · 12 conversations · 3 decisions · builder {reached('switch') ? 'Codex' : 'Claude'}</p>
          </div>
          <div className="landing-demo-conversation">
            <div className="landing-demo-note"><span>YOU</span><p>{startedPrompt}</p></div>
            {reached('think') && <div className="landing-demo-note"><span>CLAUDE</span><p>Keep one boundary question, but ask it after import. People understand the project once Selvedge has something real to organize.</p></div>}
            {reached('switch') && <div className="landing-demo-transfer"><b>Context preserved</b><span>Claude → Codex · decision, evidence, and 12 conversations transferred</span></div>}
            {reached('switch') && <div className="landing-demo-note"><span>CODEX</span><p>I have the onboarding decision and customer evidence. Updating the import-first path now.</p><small>✓ 4 files changed · 14 tests passed</small></div>}
            {reached('preview') && <button type="button" className="landing-demo-ready" onClick={() => setStep('preview')}><span>✓ Preview ready</span><strong>Open in the Preview panel →</strong></button>}
          </div>
        </section>

        <aside className="landing-demo-context" aria-label="Project context">
          <div className="landing-demo-tabs" role="tablist" aria-label="Context view">
            <button type="button" role="tab" aria-selected={step !== 'preview'} onClick={() => setStep('remember')}>Memory</button>
            <button type="button" role="tab" aria-selected={step === 'preview'} onClick={() => setStep('preview')}>Preview</button>
          </div>
          {step === 'preview' ? <div className="landing-app-preview">
            <div className="landing-preview-browser"><span>loom.app/onboarding</span><b>↗</b></div>
            <div className="landing-preview-page"><small>LOOM</small><h4>Bring the work you already started.</h4><p>Import a conversation. Selvedge will find the project boundary with you.</p><button type="button">Import a conversation</button></div>
          </div> : <div className="landing-demo-memory">
            <p className="landing-demo-label">WHAT GOVERNS THIS WORK</p>
            <strong>Establish the project boundary after import, not before it.</strong>
            <dl><div><dt>Strongest evidence</dt><dd>7 of 9 interviews understood the project after seeing imported context.</dd></div><div><dt>Current builder</dt><dd>{reached('switch') ? 'Codex · context transferred' : 'Claude'}</dd></div><div><dt>Open question</dt><dd>Should empty projects keep the old path?</dd></div></dl>
            {reached('remember') && <p className="landing-memory-saved">✓ This decision now belongs to Loom</p>}
          </div>}
        </aside>
      </div>

      <form className="landing-demo-composer" onSubmit={(event) => { event.preventDefault(); beginDemo(); }}>
        <label htmlFor={promptId}>Try Selvedge with an outcome</label>
        <div><input id={promptId} value={prompt} onChange={(event) => setPrompt(event.target.value)} /><button type="submit">Route this work →</button></div>
        <div className="landing-demo-suggestions" aria-label="Example outcomes">{DEMO_PROMPTS.map((example) => <button key={example} type="button" onClick={() => setPrompt(example)}>{example}</button>)}</div>
      </form>
    </div>
  );
}

export function Landing() {
  return <div className="landing-site overflow-hidden">
    <header className="landing-nav sticky top-0 z-20 border-b border-hairline"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6"><SelvedgeLockup tone="chalk" className="h-7 w-auto" /><nav aria-label="Public navigation" className="landing-public-links"><a href="#product">Product</a><a href="#memory">How it works</a><a href="#pricing">Pricing</a></nav><div className="flex items-center gap-1 sm:gap-2"><Link to="/sign-in" className={btnGhost}>Sign in</Link><Link to="/sign-up" className={btnPrimary}>Start free</Link></div></div></header>
    <main>
      <section className="landing-hero mx-auto max-w-6xl px-4 pt-14 sm:px-6 sm:pt-20 lg:pt-24"><div className="landing-hero-copy"><p className={eyebrowCls}>The project layer for all your AI</p><h1 className="mt-4 max-w-4xl font-display text-hero font-medium text-ink">Your project remembers, even when the AI changes.</h1><p className="mt-6 max-w-2xl text-hero-sub text-ink-dim">Think with Claude. Challenge it with GPT. Build with Codex. Every decision, conversation, and preview stays with the project.</p><div className="mt-8 flex flex-wrap gap-3"><Link to="/sign-up" className={btnPrimary}>Start a project</Link><a href="#product" className={btnGhost}>Try the demo ↓</a></div></div><div id="product" className="landing-product-stage"><ProductDemo /></div><p className="landing-scroll-cue font-mono text-tech text-ink-quiet">The work belongs to the project, not the agent. ↓</p></section>

      <section id="memory" aria-label="How project continuity works" className="landing-continuity mx-auto max-w-6xl px-4 sm:px-6"><div className="landing-continuity-copy"><p className={eyebrowCls}>One continuous record</p><h2 className="mt-4 font-display text-section font-medium text-ink">The work stays together.</h2><p className="mt-4 max-w-xl text-body-lg text-ink-dim">A conversation becomes a decision. A decision guides a build. The preview and its evidence return to the same project—ready for whichever mind comes next.</p></div><ol className="landing-continuity-steps"><li><span>01</span><strong>Bring what you know</strong><p>Import conversations, notes, evidence, and repositories.</p></li><li><span>02</span><strong>Use the right mind</strong><p>Ask one model, compare several, or hand the work to a builder.</p></li><li><span>03</span><strong>Keep what matters</strong><p>Decisions, accepted language, open questions, and previews endure.</p></li></ol></section>

      <section aria-label="Project memory" className="landing-section landing-memory mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="PROJECT MEMORY" title="Nothing important disappears into the chat log.">Selvedge separates durable project knowledge from the conversation that produced it—without severing the evidence and history behind it.</SectionIntro><div className="landing-memory-sheet"><div><p className="landing-demo-label">GOVERNING DECISION</p><strong>Ask for the project boundary after import.</strong><small>Accepted Mar 05 · supported by 3 conversations</small></div><div><p className="landing-demo-label">ACCEPTED LANGUAGE</p><strong>“Bring the work you already started.”</strong><small>Used in onboarding and import flows</small></div><div><p className="landing-demo-label">OPEN QUESTION</p><strong>What should happen when there is nothing to import?</strong><small>Owner: Product · fresh today</small></div></div></section>

      <section aria-label="Many models, one project" className="landing-models mx-auto max-w-6xl px-4 sm:px-6"><div><p className={eyebrowCls}>Many minds, one project</p><h2 className="mt-4 max-w-3xl font-display text-section font-medium text-ink">Use the best AI for each moment—not one AI for everything.</h2></div><div className="landing-model-row"><AgentChip agent="claude" /><AgentChip agent="gpt" /><AgentChip agent="gemini" /><AgentChip agent="codex" /><span>and the tools you already use</span></div></section>

      <section id="pricing" aria-label="Pricing" className="landing-section landing-pricing mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="PRICING" title="What it costs.">One price for the record that holds all of this together. The models stay yours, at cost.</SectionIntro><div><PricingCards /><p className="landing-plans-note text-body text-ink-dim">{BYO_KEYS_LINE}</p><PricingFaq /></div></section>

      <section className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6 sm:pb-32"><p className={eyebrowCls}>Start with the work</p><h2 className="mt-4 max-w-4xl font-display text-hero font-medium text-ink">Give your project a memory that outlasts every model.</h2><div className="mt-8 flex flex-wrap items-center gap-5"><Link to="/sign-up" className={btnPrimary}>Start free</Link><p className="font-mono text-tech text-ink-quiet">Bring a conversation, a repo, or just a question.</p></div></section>
    </main>
    <footer className="border-t border-hairline"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-meta text-ink-quiet sm:px-6"><p><span className="font-display font-semibold text-ink-dim">Selvedge</span> — the project layer across the AI you already use.</p><div className="flex gap-5"><Link to="/docs">Docs</Link><Link to="/security">Security</Link><Link to="/sign-in">Sign in</Link></div></div></footer>
  </div>;
}
