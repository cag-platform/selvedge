import { Link } from 'react-router-dom';
import { SelvedgeLockup } from '../components/Logo.js';
import { SelvedgeEdge, StatusDot, type EdgeStatus } from '../components/SelvedgeEdge.js';
import { Pane, btnPrimary, btnGhost, eyebrowCls } from '../components/ui.js';

/**
 * The landing page — what a stranger sees before they have an account.
 *
 * Every sentence here is decided language from EXPLAINER.md ("use these words
 * on the website") arranged, not invented. The one creative liberty is showing
 * the product with its own vocabulary: a hand-authored sample brief whose rows
 * wear the real SelvedgeEdge states, so "you read health from the edges" is
 * demonstrated rather than claimed. Clearly labeled a sample — never dressed
 * up as anyone's real morning.
 *
 * Vocabulary rules hold on this page like everywhere else: no "observability",
 * no "dashboard" as a promise, no infrastructure nouns at the plain register.
 * Rust appears exactly once outside the sample — nowhere, actually: rust is
 * needs-you only, and a marketing page needs nothing from you but a click.
 */

/** One row of the sample brief. The edge does the talking. */
function BriefRow({ status, children }: { status: EdgeStatus; children: React.ReactNode }) {
  return (
    <div className="relative rounded-inset bg-panel-soft py-2 pl-4 pr-3">
      <SelvedgeEdge status={status} />
      <p className="text-body-lg text-ink">{children}</p>
    </div>
  );
}

function HowCard({ status, title, children }: { status: EdgeStatus; title: string; children: React.ReactNode }) {
  return (
    <Pane className="pl-5">
      <SelvedgeEdge status={status} />
      <h3 className="font-display text-headline font-medium text-ink">{title}</h3>
      <p className="mt-2 text-body text-ink-dim">{children}</p>
    </Pane>
  );
}

function HonestyPoint({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-body-lg font-medium text-ink">{title}</h3>
      <p className="mt-1 text-body text-ink-dim">{children}</p>
    </div>
  );
}

export function Landing() {
  return (
    <div className="animate-settle">
      {/* One of the screen's two allowed blur layers, same treatment as the app nav. */}
      <header
        className="sticky top-0 z-10 border-b border-hairline"
        style={{ background: 'var(--glass-fill)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)' }}
      >
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <SelvedgeLockup tone="chalk" className="h-7 w-auto" />
          <Link to="/sign-in" className={btnGhost}>
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section aria-label="What Selvedge is" className="grid items-center gap-10 py-16 md:grid-cols-[1.1fr_1fr] md:py-24">
          <div>
            <p className={eyebrowCls}>The tailor for software you didn&rsquo;t write</p>
            <h1 className="mt-3 font-display text-hero font-medium text-ink">
              Selvedge keeps your <span style={{ color: 'var(--action-bright)' }}>apps running</span>.
            </h1>
            <p className="mt-5 max-w-xl text-hero-sub text-ink-dim">
              A calm place to own software you didn&rsquo;t write by hand. One morning brief in plain
              English &mdash; the important things, first.
            </p>
            <div className="mt-8 flex items-center gap-4">
              <Link to="/sign-up" className={btnPrimary}>
                Get started
              </Link>
              <span className="text-meta text-ink-quiet">Bring an app you already own.</span>
            </div>
          </div>

          {/* The sample brief — the product shown in its own vocabulary. */}
          <div>
            <Pane className="p-5">
              <p className={eyebrowCls}>This morning &middot; four apps</p>
              <div className="mt-3 space-y-2">
                <BriefRow status="healthy">Loom &mdash; quiet night. 214 sign-ins, nothing needed.</BriefRow>
                <BriefRow status="working">Patina &mdash; building the photo uploads you asked for yesterday.</BriefRow>
                <BriefRow status="needs">
                  Sild &mdash; checkout errors since 6:12am. I can fix it for about $4 &mdash; say the word.
                </BriefRow>
                <BriefRow status="unknown">Fern &mdash; can&rsquo;t see this one yet.</BriefRow>
              </div>
            </Pane>
            <p className="mt-2 text-meta text-ink-quiet">
              A sample brief. The edges are the status &mdash; <StatusDot status="needs" /> rust is the only
              thing that needs you, and <StatusDot status="unknown" /> &ldquo;I can&rsquo;t tell&rdquo; is a real answer.
            </p>
          </div>
        </section>

        {/* ── The job ──────────────────────────────────────────────────── */}
        <section aria-label="The job Selvedge does" className="border-t border-hairline py-14">
          <p className={eyebrowCls}>The second job</p>
          <p className="mt-4 max-w-2xl font-display text-section text-ink">
            Building an app and running one are different jobs &mdash; and running it never got cheaper.
          </p>
          <p className="mt-4 max-w-2xl text-body-lg text-ink-dim">
            Selvedge does that second job. It watches the apps you own, tells you in plain English when
            something is wrong, fixes it with your approval, and proves the fix actually worked. It
            didn&rsquo;t build your app &mdash; so it has no reason to tell you everything&rsquo;s fine
            when it isn&rsquo;t.
          </p>
        </section>

        {/* ── How it works ─────────────────────────────────────────────── */}
        <section aria-label="How it works" className="border-t border-hairline py-14">
          <p className={eyebrowCls}>How it works</p>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <HowCard status="healthy" title="It watches">
              One morning brief, honest about what it can&rsquo;t see. The important things first, the
              quiet things folded away &mdash; and never a false all-clear.
            </HowCard>
            <HowCard status="working" title="It fixes">
              Say what you want in plain words. Every repair has a price agreed in advance and a hard
              limit &mdash; it will never quietly spend your money trying the same broken idea forty times.
            </HowCard>
            <HowCard status="healthy" title="It proves">
              Every finished change is checked by a different model than the one that wrote it. And when
              the evidence isn&rsquo;t there, the verdict says &ldquo;I can&rsquo;t tell yet&rdquo; &mdash;
              a real answer here.
            </HowCard>
          </div>
        </section>

        {/* ── Why believe it ───────────────────────────────────────────── */}
        <section aria-label="Why you can believe it" className="border-t border-hairline py-14">
          <p className={eyebrowCls}>Why you can believe it</p>
          <div className="mt-5 grid gap-x-10 gap-y-7 md:grid-cols-2">
            <HonestyPoint title="Flat price.">
              Selvedge doesn&rsquo;t earn more when your app breaks more.
            </HonestyPoint>
            <HonestyPoint title="No stake in the answer.">
              It didn&rsquo;t sell you the app, so it has no reason to reassure you.
            </HonestyPoint>
            <HonestyPoint title="It admits what it doesn&rsquo;t know.">
              &ldquo;I can&rsquo;t tell yet&rdquo; is a real answer here &mdash; shown with its own mark,
              never dressed up as fine.
            </HonestyPoint>
            <HonestyPoint title="It stops.">
              Every repair has a price agreed in advance and a hard limit. Caps genuinely stop work.
            </HonestyPoint>
          </div>
        </section>

        {/* ── Who it's for ─────────────────────────────────────────────── */}
        <section aria-label="Who it is for" className="border-t border-hairline py-14">
          <p className={eyebrowCls}>Who it&rsquo;s for</p>
          <p className="mt-4 max-w-2xl font-display text-section text-ink">
            You built an app and now people depend on it.
          </p>
          <p className="mt-4 max-w-2xl text-body-lg text-ink-dim">
            Selvedge is who you call when it breaks &mdash; except you don&rsquo;t have to call, because
            it already noticed. For people who own working software with real users or real revenue, and
            who don&rsquo;t have an engineer to call.
          </p>
          <div className="mt-8 flex items-center gap-4">
            <Link to="/sign-up" className={`${btnPrimary} shrink-0 whitespace-nowrap`}>
              Get started
            </Link>
            <span className="text-meta text-ink-quiet">
              Everything Selvedge knows about your app exports as one file &mdash; being able to leave is
              what makes people stay.
            </span>
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-8">
          <p className="text-meta text-ink-quiet">
            <span className="font-display italic">selvedge</span>, from self + edge: the woven border that
            finishes itself and cannot fray.
          </p>
          <Link to="/sign-in" className="text-meta text-ink-quiet hover:text-ink-dim">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
