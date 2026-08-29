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
  { id: 'connect', label: 'Ask', short: 'Tell Selvedge where you are leaving' },
  { id: 'map', label: 'Discover', short: 'The migration agent maps everything' },
  { id: 'workspace', label: 'Migrate', short: 'The agent builds an isolated copy' },
  { id: 'preview', label: 'Preview', short: 'Use the migrated app' },
  { id: 'verify', label: 'Verify', short: 'Selvedge checks the result independently' },
  { id: 'cutover', label: 'Approve', short: 'You decide when to go live' },
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
          <p>Selvedge migration agent · Customer portal</p>
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
            <p><span>{DEMO_STEPS[activeIndex]!.short}</span> · you supervise, Selvedge does the work</p>
          </div>
          <div className="landing-demo-conversation">
            <div className="landing-demo-note"><span>YOU</span><p>Move our Lovable portal into Selvedge. Do not change the live app until the copy is verified.</p></div>
            <div className="landing-demo-note"><span>SELVEDGE MIGRATION AGENT</span><p>{step === 'connect' && 'That is enough to begin. I am connecting read-only; your production app, users, data, and domain remain untouched.'}{step === 'map' && 'I inspected the project and found the application, Postgres schema, authentication, storage, secrets, integrations, and domain configuration. You did not need to inventory them.'}{step === 'workspace' && 'I created an isolated workspace, chose the right workers, copied the project, configured test-safe services, and started the application.'}{step === 'preview' && 'The migrated portal is running beside this conversation. Use it like a customer would; nothing here can alter production.'}{step === 'verify' && 'I assigned verification independently. Screens, permissions, records, uploads, and critical flows are being compared with the current live app.'}{step === 'cutover' && 'The verified replacement is ready in accounts you control. Your only remaining decision is whether I should move the live domain.'}</p></div>
            {reached('workspace') && <div className="landing-demo-transfer"><b>Selvedge is running the migration</b><span>Claude mapped dependencies · Codex prepared the copy · Selvedge retained context and supervised both workers</span></div>}
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
            {step === 'map' && <div className="landing-approval-card"><span>NO HOMEWORK REQUIRED</span><strong>The migration agent has the map.</strong><p>It continues automatically in an isolated workspace. Production remains untouched.</p></div>}
          </div>}
        </aside>
      </div>

      <div className="landing-migration-promise"><span>You connect Lovable</span><span aria-hidden>→</span><span>Selvedge does the migration</span><span aria-hidden>→</span><span>you approve cutover</span></div>
    </div>
  );
}

export function Landing() {
  return <div className="landing-site overflow-hidden">
    <header className="landing-nav sticky top-0 z-20 border-b border-hairline"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6"><SelvedgeLockup tone="chalk" className="h-7 w-auto" /><nav aria-label="Public navigation" className="landing-public-links"><a href="#product">Product</a><a href="#memory">How it works</a><a href="#pricing">Pricing</a></nav><div className="flex items-center gap-1 sm:gap-2"><Link to="/sign-in" className={btnGhost}>Sign in</Link><Link to="/sign-up" className={btnPrimary}>Start free</Link></div></div></header>
    <main>
      <section className="landing-hero mx-auto max-w-7xl px-4 pt-10 sm:px-6 sm:pt-14 lg:pt-16"><div className="landing-hero-layout"><div className="landing-hero-copy"><p className={eyebrowCls}>Your project has somewhere better to go</p><h1 className="mt-4 font-display text-hero font-medium text-ink">Can’t stop vibe coding but don’t want to pay for Replit anymore? Come home.</h1><p className="mt-6 max-w-2xl text-hero-sub text-ink-dim">Keep hosting, databases, and infrastructure in accounts you control. Selvedge’s agents migrate the project, run the work, and bring you back a preview.</p><div className="mt-8 flex flex-wrap gap-3"><Link to="/sign-up" className={btnPrimary}>Bring my project home</Link><a href="#product" className={btnGhost}>Watch Selvedge work →</a></div></div><div id="product" className="landing-product-stage"><ProductDemo /></div></div><p className="landing-scroll-cue font-mono text-tech text-ink-quiet">You supervise. Selvedge does the work. ↓</p></section>

      <section id="memory" aria-label="How migration works" className="landing-continuity mx-auto max-w-6xl px-4 sm:px-6"><div className="landing-continuity-copy"><p className={eyebrowCls}>Move once. Keep control.</p><h2 className="mt-4 font-display text-section font-medium text-ink">Leave the builder. Keep the project.</h2><p className="mt-4 max-w-xl text-body-lg text-ink-dim">Tell Selvedge where the project lives. Its migration agent discovers the rest, coordinates the right workers, builds a safe copy, verifies it, and returns when there is something worth reviewing.</p></div><ol className="landing-continuity-steps"><li><span>01</span><strong>Point Selvedge at it</strong><p>Connect the builder or repository. The migration agent finds the code and services without making you produce an inventory.</p></li><li><span>02</span><strong>Let the agents work</strong><p>Selvedge creates the workspace, assigns the right agents, configures the copy, and opens a usable preview.</p></li><li><span>03</span><strong>Review one decision</strong><p>See the working result and independent verification. Approve cutover only when you are satisfied.</p></li></ol></section>

      <section aria-label="Project memory" className="landing-section landing-memory mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="PROJECT MEMORY" title="Nothing important disappears into the chat log.">Selvedge separates durable project knowledge from the conversation that produced it—without severing the evidence and history behind it.</SectionIntro><div className="landing-memory-sheet"><div><p className="landing-demo-label">GOVERNING DECISION</p><strong>Ask for the project boundary after import.</strong><small>Accepted Mar 05 · supported by 3 conversations</small></div><div><p className="landing-demo-label">ACCEPTED LANGUAGE</p><strong>“Bring the work you already started.”</strong><small>Used in onboarding and import flows</small></div><div><p className="landing-demo-label">OPEN QUESTION</p><strong>What should happen when there is nothing to import?</strong><small>Owner: Product · fresh today</small></div></div></section>

      <section aria-label="Many models, one project" className="landing-models mx-auto max-w-6xl px-4 sm:px-6"><div><p className={eyebrowCls}>Agent-neutral by design</p><h2 className="mt-4 max-w-3xl font-display text-section font-medium text-ink">Selvedge is your home. The top AI agents do what they do best.</h2><p className="mt-4 max-w-2xl text-body-lg text-ink-dim">Choose an agent when you care, or keep working in the same easy flow. Switching workers never means surrendering your project or starting its memory over.</p></div><div className="landing-model-row"><AgentChip agent="claude" /><AgentChip agent="gpt" /><AgentChip agent="gemini" /><AgentChip agent="codex" /><span>one project, no agent lock-in</span></div></section>

      <section aria-label="Coming from coding agents" className="landing-section landing-memory mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="ALREADY CODING WITH AI?" title="Bring the project. Keep your favorite tools.">Coming from Codex, Claude Code, or Cursor is not an escape from a hosted platform. It is a repository handoff: Selvedge becomes the project’s permanent home while those tools remain available as workers.</SectionIntro><div className="landing-memory-sheet"><div><p className="landing-demo-label">CODEX</p><strong>Keep Codex coding. Give the project lasting context.</strong><small>Repository · decisions · preview · verification</small></div><div><p className="landing-demo-label">CLAUDE CODE</p><strong>Keep Claude’s strengths without tying the project to one session.</strong><small>Shared history · neutral handoff · owner approval</small></div><div><p className="landing-demo-label">CURSOR</p><strong>Edit in Cursor. Operate and manage in Selvedge.</strong><small>One project record across every agent</small></div><Link to="/sign-up" className="m-5 inline-block text-body text-action-bright hover:underline">Bring a repository home →</Link></div></section>

      <section id="pricing" aria-label="Pricing" className="landing-section landing-pricing mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="PRICING" title="What it costs.">One price for the record that holds all of this together. The models stay yours, at cost.</SectionIntro><div><PricingCards /><p className="landing-plans-note text-body text-ink-dim">{BYO_KEYS_LINE}</p><PricingFaq /></div></section>

      <section className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6 sm:pb-32"><p className={eyebrowCls}>Focus on the project</p><h2 className="mt-4 max-w-4xl font-display text-hero font-medium text-ink">Stop managing the cost and limitations of your builder.</h2><div className="mt-8 flex flex-wrap items-center gap-5"><Link to="/sign-up" className={btnPrimary}>Bring my project home</Link><p className="font-mono text-tech text-ink-quiet">Your infrastructure. Your agents. One simple place to work.</p></div></section>
    </main>
    <footer className="border-t border-hairline"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-meta text-ink-quiet sm:px-6"><p><span className="font-display font-semibold text-ink-dim">Selvedge</span> — the permanent home for projects built with AI.</p><div className="flex gap-5"><Link to="/docs">Docs</Link><Link to="/security">Security</Link><Link to="/sign-in">Sign in</Link></div></div></footer>
  </div>;
}
