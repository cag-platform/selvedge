import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SelvedgeLockup } from '../components/Logo.js';
import { AgentChip } from '../components/AgentChip.js';
import { btnGhost, btnPrimary, eyebrowCls } from '../components/ui.js';
import { BYO_KEYS_LINE, FOUNDING_MEMBER_BADGE, PLAN_TAGLINE, planBullets, priceLine, yearlySavingLine } from '../../shared/plans.js';
import { ProductTour } from './ProductTour.js';
import { HeroHarness } from './HeroHarness.js';

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

type VisitorSystem = 'mac' | 'windows' | 'linux' | 'mobile' | 'web';
type ArrivalSource = 'replit' | 'lovable' | 'cursor' | null;

const SYSTEM_LABELS: Array<{ id: VisitorSystem; label: string }> = [
  { id: 'mac', label: 'Mac' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'web', label: 'Web' },
];

const SYSTEM_COPY: Record<VisitorSystem, { eyebrow: string; detail: string; cta: string }> = {
  mac: { eyebrow: 'Built for this Mac—and wherever the project runs', detail: 'Connect local tools, Xcode, and Apple previews when you need them.', cta: 'Start on this Mac' },
  windows: { eyebrow: 'Built for Windows and the web', detail: 'Use a private cloud workspace while Selvedge keeps the project together.', cta: 'Start on Windows' },
  linux: { eyebrow: 'Built for Linux and the web', detail: 'Bring your repository and tools. Selvedge handles the shared workspace.', cta: 'Start on Linux' },
  mobile: { eyebrow: 'Start here. Continue on your computer.', detail: 'Create the project now, then connect local tools when you are back at your desk.', cta: 'Create my workspace' },
  web: { eyebrow: 'One workspace, from any system', detail: 'Start in the browser. Connect local tools only when the project needs them.', cta: 'Start in the browser' },
};

function detectVisitorSystem(): VisitorSystem {
  if (typeof navigator === 'undefined') return 'web';
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(agent)) return 'mobile';
  if (/Macintosh|Mac OS X/i.test(agent)) return 'mac';
  if (/Windows/i.test(agent)) return 'windows';
  if (/Linux/i.test(agent)) return 'linux';
  return 'web';
}

function detectArrivalSource(): ArrivalSource {
  if (typeof window === 'undefined') return null;
  const explicit = new URLSearchParams(window.location.search).get('from')?.toLowerCase();
  const evidence = `${explicit ?? ''} ${document.referrer}`.toLowerCase();
  if (evidence.includes('replit')) return 'replit';
  if (evidence.includes('lovable')) return 'lovable';
  if (evidence.includes('cursor')) return 'cursor';
  return null;
}

export function Landing() {
  const [visitorSystem, setVisitorSystem] = useState<VisitorSystem>(() => detectVisitorSystem());
  const [arrivalSource] = useState<ArrivalSource>(() => detectArrivalSource());
  const systemCopy = SYSTEM_COPY[visitorSystem];
  const eyebrow = arrivalSource
    ? `Leaving ${arrivalSource === 'cursor' ? 'Cursor' : arrivalSource[0]!.toUpperCase() + arrivalSource.slice(1)}? Bring the project with you.`
    : systemCopy.eyebrow;
  const signUpHref = `/sign-up?system=${visitorSystem}${arrivalSource ? `&from=${arrivalSource}` : ''}`;

  return <div className="landing-site overflow-hidden">
    <header className="landing-nav sticky top-0 z-20 border-b border-hairline"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6"><SelvedgeLockup tone="chalk" className="h-7 w-auto" /><nav aria-label="Public navigation" className="landing-public-links"><a href="#product">Product</a><a href="#how">How it works</a><a href="#pricing">Pricing</a></nav><div className="flex items-center gap-1 sm:gap-2"><Link to="/sign-in" className={btnGhost}>Sign in</Link><Link to="/sign-up" className={btnPrimary}>Start free</Link></div></div></header>
    <main>
      <section className="landing-hero mx-auto max-w-7xl px-4 pt-10 sm:px-6 sm:pt-14 lg:pt-16"><div className="landing-hero-layout"><div className="landing-hero-copy"><p className={eyebrowCls}>{eyebrow}</p><h1 className="landing-hero-title mt-4 font-display font-medium text-ink">Selvedge keeps your work from unraveling.</h1><p className="mt-5 max-w-xl text-body-lg text-ink-dim">Keep the code, context, agents, previews, and production state together.</p><p className="landing-system-detail">{systemCopy.detail}</p><div className="mt-7 flex flex-wrap gap-3"><Link to={signUpHref} className={btnPrimary}>{systemCopy.cta}</Link><a href="#working-demo" className={btnGhost}>See a project work</a></div><div className="landing-system-picker"><span>Not your setup?</span>{SYSTEM_LABELS.map((system) => <button key={system.id} type="button" aria-pressed={visitorSystem === system.id} onClick={() => setVisitorSystem(system.id)}>{system.label}</button>)}</div></div><HeroHarness/></div></section>

      <section id="working-demo" className="landing-product-tour mx-auto max-w-7xl px-4 sm:px-6" aria-labelledby="product-tour-heading"><div className="landing-product-tour-copy"><p className={eyebrowCls}>Inside Selvedge</p><h2 id="product-tour-heading">One project. Three moments that matter.</h2><p>Move it, decide with the best agents, and catch production trouble early.</p></div><ProductTour embedded /></section>

      <section id="how" aria-label="How Selvedge works" className="landing-continuity mx-auto max-w-6xl px-4 sm:px-6"><div className="landing-continuity-copy"><p className={eyebrowCls}>How it works</p><h2 className="mt-4 font-display text-section font-medium text-ink">Bring it in. Build safely. Ship when ready.</h2></div><ol className="landing-continuity-steps"><li><span>01</span><strong>Bring the project</strong><p>From a builder, repository, or a new idea.</p></li><li><span>02</span><strong>Work with any agent</strong><p>Shared context. Private workspace. Live preview.</p></li><li><span>03</span><strong>Keep control</strong><p>Your infrastructure. Your approval. Your project.</p></li></ol></section>

      <section aria-label="Why Selvedge" className="landing-outcomes mx-auto max-w-6xl px-4 sm:px-6"><article><h2>The project remembers.</h2><p>Decisions and history stay with the work.</p></article><article><h2>Agents stay interchangeable.</h2><p>Use Claude, Codex, GPT, or what comes next.</p></article><article><h2>Production stays yours.</h2><p>Selvedge manages the work, not your lock-in.</p></article></section>

      <section aria-label="Safety and control" className="landing-trust mx-auto max-w-6xl px-4 sm:px-6"><p>Isolated workspaces</p><p>Scoped secrets</p><p>Independent checks</p><p>Nothing ships without approval</p></section>

      <section id="pricing" aria-label="Pricing" className="landing-section landing-pricing mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="PRICING" title="Start free.">Pay for Selvedge when the project becomes operational.</SectionIntro><div><PricingCards /><p className="landing-plans-note text-body text-ink-dim">{BYO_KEYS_LINE}</p><PricingFaq /></div></section>

      <section className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6 sm:pb-32"><h2 className="max-w-4xl font-display text-hero font-medium text-ink">Give the project a permanent home.</h2><div className="mt-8"><Link to="/sign-up" className={btnPrimary}>Start free</Link></div></section>
    </main>
    <footer className="landing-footer border-t border-hairline"><div className="mx-auto max-w-6xl px-4 py-10 sm:px-6"><p className="font-display font-semibold text-ink-dim">Selvedge</p><nav aria-label="Footer"><Link to="/docs">Docs</Link><Link to="/security">Security</Link><Link to="/status">Status</Link><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/sign-in">Sign in</Link></nav></div></footer>
  </div>;
}
