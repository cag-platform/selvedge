import { useState } from 'react';
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

export function Landing() {
  return <div className="overflow-hidden">
    <header className="landing-nav sticky top-0 z-20 border-b border-hairline"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6"><SelvedgeLockup tone="chalk" className="h-7 w-auto" /><div className="flex items-center gap-1 sm:gap-2"><a href="#pricing" className={btnGhost}>Pricing</a><Link to="/sign-in" className={btnGhost}>Sign in</Link><Link to="/sign-up" className={btnPrimary}>Start free</Link></div></div></header>
    <main>
      <section className="landing-hero mx-auto max-w-6xl px-4 pt-14 sm:px-6 sm:pt-20 lg:pt-24"><div className="relative z-10 max-w-4xl"><p className={eyebrowCls}>All your AI. One conversation.</p><h1 className="mt-4 max-w-4xl font-display text-hero font-medium text-ink">Where all your AI builds together.</h1><div className="mt-6 flex max-w-3xl flex-col gap-6 sm:flex-row sm:items-end sm:justify-between"><p className="max-w-xl text-hero-sub text-ink-dim">Claude, GPT, Codex and the rest of your AI stack, working from one project history.</p><Link to="/sign-up" className={`${btnPrimary} shrink-0 self-start sm:self-auto`}>Start a project</Link></div></div><div className="landing-hero-thread mt-12 lg:mt-16"><SampleThread caption={false} /></div><p className="landing-scroll-cue font-mono text-tech text-ink-quiet">Continue through the project ↓</p></section>

      <section aria-label="One project, many minds" className="landing-section landing-many mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="01" title="One project. Many minds.">Call in one model or several. Each reads the same history and answers in its own name.</SectionIntro><div className="landing-transcript"><ContextLine>loom / pricing · context carried forward from onboarding</ContextLine><Message who="You">Which pricing change creates the least confusion? <span className="text-brass">@gemini @claude @gpt</span></Message><Message who="Gemini" agent="gemini">Keep the current tiers. Change the usage language, not the structure.</Message><Message who="Claude" agent="claude">Collapse to two tiers. The middle option is doing no useful work.</Message><Message who="GPT" agent="gpt">Keep three tiers, but price the middle one as the obvious default.</Message></div></section>

      <section aria-label="Bring old conversations" className="landing-section landing-import mx-auto max-w-6xl px-4 sm:px-6"><div className="landing-import-stack" aria-label="Imported conversations becoming project context"><div className="landing-import-source"><span>ChatGPT</span><strong>Early customer interviews</strong><small>18 messages · Feb 12</small></div><div className="landing-import-source"><span>Claude</span><strong>Onboarding teardown</strong><small>31 messages · Mar 04</small></div><div className="landing-import-source"><span>Gemini</span><strong>Competitor notes</strong><small>9 messages · Mar 19</small></div><div className="landing-import-result font-mono text-tech"><span className="text-healthy">✓</span> 3 conversations added to Loom</div></div><SectionIntro number="02" title="Stop starting over.">Bring in the conversations that got you here. The next AI starts with the decisions, questions, and dead ends already in the project.</SectionIntro></section>

      <section aria-label="Compare models" className="landing-section landing-compare mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="03" title="Ask twice.">Give the same question to two models. Keep the disagreement visible. Decide for yourself.</SectionIntro><div className="landing-compare-stage"><p className="border-b border-hairline pb-5 text-body-lg text-ink">Should the free plan include conversation imports?</p><div className="landing-comparison"><div><AgentChip agent="claude" /><p>Yes. Import is the moment Selvedge proves its value. Limiting it delays understanding.</p><span>Include 3 imports</span></div><div><AgentChip agent="gpt" /><p>No. Imports have durable storage cost and make the free tier easy to treat as an archive.</p><span>Preview before upgrading</span></div></div></div></section>

      <section aria-label="Coding agents in the project" className="landing-section landing-building mx-auto max-w-6xl px-4 sm:px-6"><div className="landing-code-run font-mono text-tech"><div className="border-b border-hairline px-5 py-4 text-ink-quiet">loom / onboarding · Codex</div><div className="space-y-3 px-5 py-6 text-ink-dim"><p><span className="text-action-bright">→</span> Read the pricing decision above</p><p><span className="text-action-bright">→</span> Updated import limit copy</p><p><span className="text-action-bright">→</span> Changed upgrade boundary</p><p><span className="text-healthy">✓</span> 14 tests passed</p><p><span className="text-healthy">✓</span> preview ready · 7c3a1d8</p></div></div><SectionIntro number="04" title="Building belongs in the conversation.">Thinking and implementation share one history. Codex, Claude Code, and Cursor enter the same project instead of beginning in a blank terminal.</SectionIntro></section>

      <section aria-label="Project history" className="landing-section landing-memory mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="05" title="The project remembers.">Close the tab. Change models. Come back in six months. The project still knows how the work arrived here.</SectionIntro><div className="landing-history font-mono text-tech"><div><time>FEB 12</time><span>18 ChatGPT messages imported</span></div><div><time>MAR 04</time><span>Onboarding wizard challenged by Claude</span></div><div><time>MAR 05</time><span>Boundary question kept after GPT disagreed</span></div><div><time>MAR 06</time><span>Codex shipped 7c3a1d8</span></div><div><time>AUG 22</time><span>You asked “why is it like this?”</span></div></div></section>

      <section id="pricing" aria-label="Pricing" className="landing-section landing-pricing mx-auto max-w-6xl px-4 sm:px-6"><SectionIntro number="06" title="What it costs.">One price for the record that holds all of this together. The models stay yours, at cost.</SectionIntro><div><PricingCards /><p className="landing-plans-note text-body text-ink-dim">{BYO_KEYS_LINE}</p><PricingFaq /></div></section>

      <section className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6 sm:pb-32"><p className={eyebrowCls}>One project conversation</p><h2 className="mt-4 max-w-4xl font-display text-hero font-medium text-ink">Your work doesn’t belong to one AI anymore.</h2><div className="mt-8 flex flex-wrap items-center gap-5"><Link to="/sign-up" className={btnPrimary}>Start free</Link><p className="font-mono text-tech text-ink-quiet">Bring a conversation, a repo, or just a question.</p></div></section>
    </main>
    <footer className="border-t border-hairline"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-meta text-ink-quiet sm:px-6"><p><span className="font-display italic text-ink-dim">selvedge</span> — the project layer across the AI you already use.</p><div className="flex gap-5"><Link to="/docs">Docs</Link><Link to="/security">Security</Link><Link to="/sign-in">Sign in</Link></div></div></footer>
  </div>;
}
