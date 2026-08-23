import { Link } from 'react-router-dom';
import { SelvedgeLockup } from '../components/Logo.js';
import { SelvedgeEdge, type EdgeStatus } from '../components/SelvedgeEdge.js';
import { AgentChip } from '../components/AgentChip.js';
import { Pane, btnPrimary, btnGhost, eyebrowCls } from '../components/ui.js';

/**
 * THE LANDING PAGE — what a stranger sees before they have an account.
 *
 * ONE SENTENCE, AND EVERYTHING ON THE PAGE SERVES IT:
 *
 *   Selvedge is one window per project where every AI you use talks, builds,
 *   and is remembered — and when something breaks, the conversation that
 *   caused it is one click away.
 *
 * WHAT CHANGED AND WHY. This page used to sell a monitoring product: a sample
 * morning brief, four apps, "Selvedge keeps your apps running". That was true
 * of an older Selvedge and is no longer true of this one — the brief is
 * retired, Today is gone, and the workbench is the product. A landing page
 * describing a product the code no longer builds is the most expensive kind of
 * stale prose there is.
 *
 * The hierarchy that resolves the old thesis: watching did not stop being the
 * product, it became the REASON TO BELIEVE this window over the other windows.
 * Anyone can put four models in one chat. Only this one knows whether what got
 * built actually worked. So watching appears here as evidence (§"Why you can
 * believe it"), never as the headline.
 *
 * WHERE THE WORDS COME FROM. The alignment pack of 22 Aug 2026 and the product
 * as built. NOT from EXPLAINER.md, which this page used to cite as its copy
 * source — that document is superseded and carries a banner saying so.
 *
 * RULES THAT BIND THIS PAGE:
 *  - Rust (`--thread`) appears EXACTLY ONCE: the "needs you" edge specimen. A
 *    marketing page needs nothing from you but a click, so the colour reserved
 *    for "this needs you" has one honest use here and no other. There is a
 *    test for the count.
 *  - Agent identity is text chips only. No vendor logos, no brand colours,
 *    anywhere — including inside copy illustrations. The colour system means
 *    status, and a page full of brand colour would teach people otherwise
 *    before they ever signed in.
 *  - House voice: no "observability", no "dashboard" as a promise, no "nobody
 *    does this". The competitive claim is incentive-shaped ("a window owned by
 *    one AI company has a favourite"), never honesty-shaped.
 *  - Tokens only. No raw colour, radius, or type values.
 *  - One motion token. The sample thread settles in on arrival and then holds
 *    still; nothing loops, and `prefers-reduced-motion` collapses the duration
 *    to zero (tokens.css), so this obeys without a second code path.
 */

/** Section heading — Fraunces, the reading register, one size for all of them. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="max-w-2xl font-display text-section text-ink">{children}</h2>;
}

/** A card in one of the three-up rows. */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Pane>
      <h3 className="font-display text-headline font-medium text-ink">{title}</h3>
      <div className="mt-2 space-y-2 text-body text-ink-dim">{children}</div>
    </Pane>
  );
}

/** One of the four reasons, separated by hairlines rather than boxes. */
function Reason({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-hairline pt-5">
      <h3 className="text-body-lg font-medium text-ink">{title}</h3>
      <p className="mt-1 max-w-xl text-body text-ink-dim">{children}</p>
    </div>
  );
}

/** A sigil, shown at the size it is actually typed. */
function Sigil({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--brass)' }}>{children}</span>;
}

/** A mono line inside a card — an example of what you would actually type. */
function Example({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-inset bg-panel-soft px-3 py-2 font-mono text-tech text-ink-dim">{children}</p>
  );
}

/**
 * THE SAMPLE THREAD — the page's signature, and the only argument that
 * actually lands.
 *
 * It replaces the old sample brief for the same reason the brief left the
 * app: the thing worth showing is the conversation, and a conversation is
 * something you read rather than something you are told about. Two models
 * disagreeing usefully, a decision from March pulled in by name, and a
 * builder shipping it — in seven messages, with no sentence of explanation
 * around them.
 *
 * Hand-authored and labelled as a sample. Every piece of it is the real
 * component: the real AgentChip, the real edge, the real mono register for
 * system lines.
 */

const SETTLE_STEP_MS = 90;

/** One message. `index` staggers its arrival; nothing moves after that. */
function Message({
  who,
  chip,
  index,
  children,
}: {
  who: string;
  chip?: string;
  index: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="animate-settle"
      style={{ animationDelay: `calc(var(--settle-duration) * ${index * (SETTLE_STEP_MS / 560)})` }}
    >
      <div className="flex items-center gap-2">
        {chip && <AgentChip agent={chip} />}
        <p className={eyebrowCls}>{who}</p>
      </div>
      <p className="mt-1 text-body text-ink">{children}</p>
    </div>
  );
}

/** A system line: what Selvedge did, in the mono register it uses everywhere. */
function SystemLine({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <p
      className="animate-settle font-mono text-tech text-ink-quiet"
      style={{ animationDelay: `calc(var(--settle-duration) * ${index * (SETTLE_STEP_MS / 560)})` }}
    >
      {children}
    </p>
  );
}

/**
 * `short` exists for one caller: the OG card (scripts/shoot-og.ts), which
 * shows the first three messages — the question and the two signed answers.
 * The card is rendered from THIS component rather than drawn to look like it,
 * so a link preview can never be a picture of a product that no longer exists.
 */
export function SampleThread({ short = false, caption = true }: { short?: boolean; caption?: boolean } = {}) {
  const rest = !short;
  return (
    <div>
      <Pane className="pl-5">
        {/* The healthy edge, doing on this page exactly what it does in the
            app: saying what state the thing is in, without a word. */}
        <SelvedgeEdge status="healthy" />
        <p className={eyebrowCls}>loom &middot; projects / loom / checkout</p>

        <div className="mt-4 space-y-4">
          <Message who="You" index={0}>
            Checkout is dropping carts on the payment step. <Sigil>@claude</Sigil> <Sigil>@gpt</Sigil> &mdash;
            what&rsquo;s the most likely cause?
          </Message>

          <Message who="Claude" chip="claude" index={1}>
            The timeout on the payment confirm call is 5s and your processor&rsquo;s p95 is above that on
            weekends. I&rsquo;d look there first.
          </Message>

          <Message who="GPT" chip="gpt" index={2}>
            Agree it&rsquo;s likely the confirm step &mdash; but check the retry logic too. A double-submit
            guard that&rsquo;s too eager would look identical in your numbers.
          </Message>

          {/* The rest of the conversation. The OG card stops above this line:
              the question and the two signed answers are the whole argument,
              and a link preview has room for three messages, not seven. */}
          {rest && (
            <>
          <Message who="You" index={3}>
            We hit something like this in March &mdash; <Sigil>#stripe-timeouts</Sigil>
          </Message>

          <SystemLine index={4}>
            &#8627; pulled in #stripe-timeouts &mdash; a conversation imported from ChatGPT, Mar 2026
          </SystemLine>

          <Message who="You" index={5}>
            Same fix then. <Sigil>@claudecode</Sigil> raise the timeout, add the guard, ship it.
          </Message>

          <div
            className="animate-settle"
            style={{ animationDelay: `calc(var(--settle-duration) * ${6 * (SETTLE_STEP_MS / 560)})` }}
          >
            <div className="flex items-center gap-2">
              <AgentChip agent="claude-code" />
              <p className={eyebrowCls}>Claude Code</p>
            </div>
            <p className="mt-1 font-mono text-tech text-ink-dim">
              {/* Status colour used as status, which is the only way it is ever
                  used: this tick means the thing worked. */}
              {/* &nbsp; between a number and its unit: "3" at the end of one
                  line and "files" at the start of the next is two facts where
                  there was one. */}
              <span style={{ color: 'var(--healthy)' }}>&#10003;</span> shipped a4f19c2 &middot; 3&nbsp;files
              &middot; $0.42 &middot; preview held &middot; watching for 12&nbsp;min
            </p>
          </div>
            </>
          )}
        </div>
      </Pane>
      {caption && (
        <p className="mt-2 text-meta text-ink-quiet">
          A sample conversation. The names are how you actually type them.
        </p>
      )}
    </div>
  );
}

/** The four edges, shown once, as themselves. */
const SPECIMENS: Array<{ status: EdgeStatus; label: string; line: string }> = [
  { status: 'healthy', label: 'Healthy', line: 'Shipped and holding.' },
  { status: 'working', label: 'Working', line: 'Building it now.' },
  { status: 'needs', label: 'Needs you', line: 'Stopped at the cap you set.' },
  { status: 'unknown', label: "Can't tell", line: 'Nothing has reported yet.' },
];

export function Landing() {
  return (
    <div>
      {/* One of the screen's two allowed blur layers, same treatment as the app nav. */}
      <header
        className="sticky top-0 z-10 border-b border-hairline"
        style={{ background: 'var(--glass-fill)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)' }}
      >
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <SelvedgeLockup tone="chalk" className="h-7 w-auto" />
          <div className="flex items-center gap-2">
            <Link to="/sign-in" className={btnGhost}>
              Sign in
            </Link>
            <Link to="/sign-up" className={btnPrimary}>
              Start free
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section aria-label="What Selvedge is" className="grid items-center gap-10 py-16 md:grid-cols-[1fr_1fr] md:py-24">
          <div className="animate-settle">
            <p className={eyebrowCls}>One window per project</p>
            <h1 className="mt-3 font-display text-hero font-medium text-ink">
              All your AI.
              <br />
              One conversation.
            </h1>
            <p className="mt-5 max-w-xl text-hero-sub text-ink-dim">
              Claude, GPT, Claude Code, and Codex &mdash; in the same thread, reading the same history.
              Ask two of them the same question and get two signed answers. Then tell one to build it,
              without saying anything twice.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link to="/sign-up" className={btnPrimary}>
                Start free
              </Link>
              <a href="#how" className={`${btnGhost} border border-hairline`}>
                See how it works
              </a>
            </div>
            <p className="mt-4 font-mono text-tech text-ink-quiet">runs on your own API keys</p>
          </div>

          <SampleThread />
        </section>

        {/* ── The sigils ───────────────────────────────────────────────── */}
        <section id="how" aria-label="The two marks" className="border-t border-hairline py-14">
          <SectionHeading>Two marks. That&rsquo;s the whole interface.</SectionHeading>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Card title="@ chooses who answers">
              <p>
                Name one and the conversation is theirs from here. Name two and you get two answers,
                each signed &mdash; not a blend, and not a vote.
              </p>
              <Example>@gpt is this schema going to bite us?</Example>
              <Example>@claude @gpt which of these is cheaper to run?</Example>
              <p>
                Nothing changes hands behind your back, and one delete takes it back.
              </p>
            </Card>
            <Card title="# chooses what you're talking about">
              <p>
                Point at another project, another subject, or another conversation &mdash; including one
                you had somewhere else and brought in.
              </p>
              <Example>how did we handle refunds in #loom?</Example>
              <p>
                The decision you made with Claude in March is right there for the agent building the
                thing this morning.
              </p>
            </Card>
          </div>
        </section>

        {/* ── History ──────────────────────────────────────────────────── */}
        <section aria-label="Your history" className="border-t border-hairline py-14">
          <SectionHeading>Your history comes with you.</SectionHeading>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <Card title="Bring your chats">
              <p>
                Upload the export ChatGPT, Claude, or Gemini already gives you and those conversations
                become ordinary threads here &mdash; searchable, referenceable, every one marked as
                imported because none of it was said to Selvedge.
              </p>
              <p>
                Importing the same file twice can&rsquo;t double your history, and whatever
                couldn&rsquo;t be read is listed with a reason, at the same volume as what came in.
              </p>
            </Card>
            <Card title="Bring your terminal">
              <p>
                <span className="font-mono text-tech">npx selvedge</span> reads the sessions you run in
                Claude Code and Codex and sends a summary of each: what you asked for, what it touched,
                how it ended, what it cost.
              </p>
              <p>
                Summaries only. There is nowhere in Selvedge to put a transcript, and nowhere to put
                your code.
              </p>
            </Card>
            <Card title="Keep the outcome">
              <p>
                Threads sit next to the commits, deploys, and breaks they produced. Months later, the
                question &ldquo;why is it like this?&rdquo; has an answer with a date on it.
              </p>
              <p>
                All of it exports as JSON whenever you like &mdash; being able to leave is what makes
                the record worth keeping.
              </p>
            </Card>
          </div>
        </section>

        {/* ── It ships ─────────────────────────────────────────────────── */}
        <section aria-label="It ships" className="border-t border-hairline py-14">
          <SectionHeading>It doesn&rsquo;t just talk. It ships.</SectionHeading>
          <p className="mt-4 max-w-2xl text-body-lg text-ink-dim">
            The builders work in a real sandbox on your repo. You watch it happen, see the thing running
            before anything goes live, ship when you mean to, and roll back if you were wrong. Every
            conversation has a ceiling you set, and when it&rsquo;s reached the work stops and tells you
            what it spent &mdash; the real number, not a warning about one.
          </p>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {SPECIMENS.map((s) => (
              <div key={s.status} className="relative rounded-inset bg-panel-soft py-3 pl-4 pr-3">
                <SelvedgeEdge status={s.status} />
                <p className="text-body font-medium text-ink">{s.label}</p>
                <p className="mt-0.5 text-meta text-ink-quiet">{s.line}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-meta text-ink-quiet">
            You read the state off the edge. &ldquo;Can&rsquo;t tell&rdquo; has its own mark, and it is a
            different shape rather than a paler colour &mdash; so it can never be mistaken for fine.
          </p>
        </section>

        {/* ── Why believe it ───────────────────────────────────────────── */}
        <section aria-label="Why you can believe it" className="border-t border-hairline py-14">
          <SectionHeading>Why you can believe it.</SectionHeading>
          <div className="mt-6 space-y-5">
            <Reason title="It runs on your keys.">
              Your Claude subscription, your OpenAI key, your usage. Selvedge charges for the window and
              the record, not for the tokens &mdash; so it has no reason to want your conversations
              longer than they need to be.
            </Reason>
            <Reason title="It sits between the vendors, not inside one.">
              Each model answers as itself, signed with its own name. A window owned by one AI company
              has a favourite; this one doesn&rsquo;t, and adding the next model is a row in a table
              rather than a change of heart.
            </Reason>
            <Reason title="It says &ldquo;I can&rsquo;t tell.&rdquo;">
              When nothing has reported, that is what you see &mdash; its own mark, its own shape, never
              folded into the quiet ones. When two changes could equally be behind a break, it names both
              and says it can&rsquo;t tell which. A coin toss dressed as an answer is the one output this
              product will not produce.
            </Reason>
            <Reason title="The record outlives the tab.">
              Close everything, come back in six months, and what was asked, what was decided, what
              shipped, and what broke are all still here &mdash; in the same sentences the export carries.
            </Reason>
          </div>
        </section>

        {/* ── Close ────────────────────────────────────────────────────── */}
        <section aria-label="Start" className="border-t border-hairline py-16">
          <SectionHeading>Stop re-explaining your project to every AI you open.</SectionHeading>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link to="/sign-up" className={btnPrimary}>
              Start free
            </Link>
            <span className="text-meta text-ink-quiet">
              Bring a repo, an old export, or just a question.
            </span>
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-8">
          <p className="max-w-2xl text-meta text-ink-quiet">
            <span className="font-display italic">selvedge</span> &mdash; from self + edge: the woven
            border a fabric finishes itself, the edge that cannot fray. The conversations, the code, the
            decisions between them &mdash; kept on one continuous cloth.
          </p>
          <Link to="/sign-in" className="text-meta text-ink-quiet hover:text-ink-dim">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
