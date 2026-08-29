import { useEffect, useState } from 'react';
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

type DemoStep = 'connect' | 'map' | 'workspace' | 'preview' | 'verify' | 'cutover';

const DEMO_STEPS: Array<{ id: DemoStep; label: string; short: string }> = [
  { id: 'connect', label: 'Connect', short: 'Read-only access' },
  { id: 'map', label: 'Map', short: 'See every dependency' },
  { id: 'workspace', label: 'Copy', short: 'Keep production untouched' },
  { id: 'preview', label: 'Preview', short: 'Use the migrated app' },
  { id: 'verify', label: 'Verify', short: 'Compare real behavior' },
  { id: 'cutover', label: 'Approve', short: 'You decide when to ship' },
];

function ProductDemo() {
  const [step, setStep] = useState<DemoStep>('connect');
  const [playing, setPlaying] = useState(true);
  const activeIndex = DEMO_STEPS.findIndex((item) => item.id === step);
  const reached = (candidate: DemoStep) => activeIndex >= DEMO_STEPS.findIndex((item) => item.id === candidate);

  useEffect(() => {
    if (!playing || typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setTimeout(() => {
      setStep(DEMO_STEPS[(activeIndex + 1) % DEMO_STEPS.length]!.id);
    }, 3600);
    return () => window.clearTimeout(timer);
  }, [activeIndex, playing]);

  const choose = (next: DemoStep) => {
    setStep(next);
    setPlaying(false);
  };

  return (
    <div className="landing-demo landing-demo-light" aria-label="Guided Selvedge migration demonstration">
      <div className="landing-demo-bar">
        <div className="landing-window-dots" aria-hidden="true"><i /><i /><i /></div>
        <p>Selvedge migration · Customer portal</p>
        <button type="button" onClick={() => setPlaying((current) => !current)} aria-label={playing ? 'Pause migration walkthrough' : 'Play migration walkthrough'}>
          {playing ? 'Pause' : 'Play'}
        </button>
      </div>

      <div className="landing-demo-guide" aria-label="Demo stages">
        {DEMO_STEPS.map((item, index) => <button key={item.id} type="button" onClick={() => choose(item.id)} aria-current={step === item.id ? 'step' : undefined} title={item.short}>
          <span>{String(index + 1).padStart(2, '0')}</span>{item.label}
        </button>)}
      </div>

      <div className="landing-demo-shell">
        <aside className="landing-demo-threads" aria-label="Migration source">
          <p className="landing-demo-label">LEAVING</p>
          <strong>Lovable</strong>
          <div className="landing-demo-thread active"><span>Production</span><b>Customer portal</b><small>stays live throughout</small></div>
          <div className="landing-migration-source"><span className={reached('connect') ? 'done' : ''}>Code export</span><span className={reached('map') ? 'done' : ''}>Postgres</span><span className={reached('map') ? 'done' : ''}>Auth + storage</span><span className={reached('map') ? 'done' : ''}>Secrets + domains</span></div>
        </aside>

        <section className="landing-demo-work" aria-live="polite">
          <div className="landing-demo-heading">
            <p className="landing-demo-label">MIGRATION / {DEMO_STEPS[activeIndex]!.label.toUpperCase()}</p>
            <h3>Bring the portal home without risking production</h3>
            <p><span>{DEMO_STEPS[activeIndex]!.short}</span> · Selvedge coordinates the work</p>
          </div>
          <div className="landing-demo-conversation">
            <div className="landing-demo-note"><span>YOU</span><p>Move our Lovable portal into Selvedge. Do not change the live app until the copy is verified.</p></div>
            <div className="landing-demo-note"><span>SELVEDGE</span><p>{step === 'connect' && 'Connecting read-only. Lovable production, users, data, and domain remain untouched.'}{step === 'map' && 'I found the application, Postgres schema, authentication, file storage, environment secrets, integrations, and domain configuration.'}{step === 'workspace' && 'Approval 1 received. Claude and Codex are working in an isolated copy with test-safe credentials and data.'}{step === 'preview' && 'The migrated portal is running beside this conversation. Use it like a customer would; nothing here can alter production.'}{step === 'verify' && 'Independent checks are comparing screens, permissions, records, uploads, and critical flows against the current live app.'}{step === 'cutover' && 'The replacement is ready in accounts you control. Nothing moves to the live domain until you approve cutover.'}</p></div>
            {reached('workspace') && <div className="landing-demo-transfer"><b>Agent-neutral workspace</b><span>Claude mapped the dependencies · Codex prepared the copy · project context stayed in Selvedge</span></div>}
            {step === 'cutover' && <div className="landing-approval-card"><span>APPROVAL 2</span><strong>Move the live domain?</strong><p>Verified copy ready · rollback plan prepared</p><div><button type="button">Keep Lovable live</button><button type="button">Approve cutover</button></div></div>}
          </div>
        </section>

        <aside className="landing-demo-context" aria-label="Migration evidence">
          <div className="landing-demo-tabs" role="tablist" aria-label="Context view">
            <button type="button" role="tab" aria-selected={!reached('preview')} onClick={() => choose('map')}>Project map</button>
            <button type="button" role="tab" aria-selected={reached('preview')} onClick={() => choose('preview')}>Preview</button>
          </div>
          {reached('preview') ? <div className="landing-app-preview">
            <div className="landing-preview-browser"><span>preview.selvedge.app</span><b className={reached('verify') ? 'text-healthy' : ''}>{reached('verify') ? 'verified' : 'private'}</b></div>
            <div className="landing-preview-page"><small>NORTHSTAR</small><h4>Welcome back, Avery.</h4><p>Your projects, invoices, and account details moved with you.</p><button type="button">Open customer portal</button>{reached('verify') && <div className="landing-verification"><span>✓ Pages match</span><span>✓ Auth verified</span><span>✓ Data isolated</span><span>✓ Rollback ready</span></div>}</div>
          </div> : <div className="landing-demo-memory">
            <p className="landing-demo-label">PROJECT MAP</p>
            <strong>{step === 'connect' ? 'Connecting without touching production…' : 'Everything the portal depends on, in one place.'}</strong>
            <dl><div><dt>Application</dt><dd>{reached('map') ? 'Next.js · 184 files' : 'Reading…'}</dd></div><div><dt>Data</dt><dd>{reached('map') ? 'Postgres · 24 tables' : 'Waiting'}</dd></div><div><dt>Services</dt><dd>{reached('map') ? 'Auth · storage · email · Stripe' : 'Waiting'}</dd></div></dl>
            {step === 'map' && <div className="landing-approval-card"><span>APPROVAL 1</span><strong>Create the isolated copy?</strong><p>Production remains untouched</p></div>}
          </div>}
        </aside>
      </div>

      <div className="landing-migration-promise"><span>Lovable production stays live</span><span aria-hidden>→</span><span>you approve the map</span><span aria-hidden>→</span><span>you approve cutover</span></div>
    </div>
  );
}

export function Landing() {
  return <div className="landing-site overflow-hidden">
    <header className="landing-nav sticky top-0 z-20 border-b border-hairline"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6"><SelvedgeLockup tone="chalk" className="h-7 w-auto" /><nav aria-label="Public navigation" className="landing-public-links"><a href="#product">Product</a><a href="#memory">How it works</a><a href="#pricing">Pricing</a></nav><div className="flex items-center gap-1 sm:gap-2"><Link to="/sign-in" className={btnGhost}>Sign in</Link><Link to="/sign-up" className={btnPrimary}>Start free</Link></div></div></header>
    <main>
      <section className="landing-hero mx-auto max-w-6xl px-4 pt-14 sm:px-6 sm:pt-20 lg:pt-24"><div className="landing-hero-copy"><p className={eyebrowCls}>Your project has somewhere better to go</p><h1 className="mt-4 max-w-5xl font-display text-hero font-medium text-ink">The place your projects go when other AI builders price you out.</h1><p className="mt-6 max-w-2xl text-hero-sub text-ink-dim">Bring your project home. Keep hosting, databases, and infrastructure in accounts you control—then build, iterate, and manage it from one simple conversation in Selvedge.</p><div className="mt-8 flex flex-wrap gap-3"><Link to="/sign-up" className={btnPrimary}>Bring my project home</Link><a href="#product" className={btnGhost}>See how it works ↓</a></div></div><div id="product" className="landing-product-stage"><ProductDemo /></div><p className="landing-scroll-cue font-mono text-tech text-ink-quiet">Your project is the product. The agent is a worker. ↓</p></section>

      <section id="memory" aria-label="How migration works" className="landing-continuity mx-auto max-w-6xl px-4 sm:px-6"><div className="landing-continuity-copy"><p className={eyebrowCls}>Move once. Keep control.</p><h2 className="mt-4 font-display text-section font-medium text-ink">Leave the builder. Keep the project.</h2><p className="mt-4 max-w-xl text-body-lg text-ink-dim">Selvedge maps what you have, gives agents a safe temporary workspace, shows you the result, verifies it, and ships only when you approve.</p></div><ol className="landing-continuity-steps"><li><span>01</span><strong>Bring it over</strong><p>Connect the repository and the services your project already uses.</p></li><li><span>02</span><strong>Work naturally</strong><p>Ask for an outcome. Selvedge gives the right agent the project context and opens the preview when it is ready.</p></li><li><span>03</span><strong>Approve and ship</strong><p>Review the result and verification, then publish to infrastructure you control.</p></li></ol></section>

      <section aria-label="Project memory" className="landing-section landing-memory mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="PROJECT MEMORY" title="Nothing important disappears into the chat log.">Selvedge separates durable project knowledge from the conversation that produced it—without severing the evidence and history behind it.</SectionIntro><div className="landing-memory-sheet"><div><p className="landing-demo-label">GOVERNING DECISION</p><strong>Ask for the project boundary after import.</strong><small>Accepted Mar 05 · supported by 3 conversations</small></div><div><p className="landing-demo-label">ACCEPTED LANGUAGE</p><strong>“Bring the work you already started.”</strong><small>Used in onboarding and import flows</small></div><div><p className="landing-demo-label">OPEN QUESTION</p><strong>What should happen when there is nothing to import?</strong><small>Owner: Product · fresh today</small></div></div></section>

      <section aria-label="Many models, one project" className="landing-models mx-auto max-w-6xl px-4 sm:px-6"><div><p className={eyebrowCls}>Agent-neutral by design</p><h2 className="mt-4 max-w-3xl font-display text-section font-medium text-ink">Selvedge is your home. The top AI agents do what they do best.</h2><p className="mt-4 max-w-2xl text-body-lg text-ink-dim">Choose an agent when you care, or keep working in the same easy flow. Switching workers never means surrendering your project or starting its memory over.</p></div><div className="landing-model-row"><AgentChip agent="claude" /><AgentChip agent="gpt" /><AgentChip agent="gemini" /><AgentChip agent="codex" /><span>one project, no agent lock-in</span></div></section>

      <section id="pricing" aria-label="Pricing" className="landing-section landing-pricing mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="PRICING" title="What it costs.">One price for the record that holds all of this together. The models stay yours, at cost.</SectionIntro><div><PricingCards /><p className="landing-plans-note text-body text-ink-dim">{BYO_KEYS_LINE}</p><PricingFaq /></div></section>

      <section className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6 sm:pb-32"><p className={eyebrowCls}>Focus on the project</p><h2 className="mt-4 max-w-4xl font-display text-hero font-medium text-ink">Stop managing the cost and limitations of your builder.</h2><div className="mt-8 flex flex-wrap items-center gap-5"><Link to="/sign-up" className={btnPrimary}>Bring my project home</Link><p className="font-mono text-tech text-ink-quiet">Your infrastructure. Your agents. One simple place to work.</p></div></section>
    </main>
    <footer className="border-t border-hairline"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-meta text-ink-quiet sm:px-6"><p><span className="font-display font-semibold text-ink-dim">Selvedge</span> — the permanent home for projects built with AI.</p><div className="flex gap-5"><Link to="/docs">Docs</Link><Link to="/security">Security</Link><Link to="/sign-in">Sign in</Link></div></div></footer>
  </div>;
}
