/**
 * /styleguide — every Selvedge design token, rendered (Prompt 1 acceptance).
 * This page is the living contract: if a component uses a value you cannot
 * see here, the component is wrong, not this page.
 */

import { SelvedgeEdge, StatusDot } from '../components/SelvedgeEdge.js';
import { Brief, BriefEyebrow, BriefItem, BriefClose, Headline, Reveal } from '../components/Brief.js';
import { SituationCard } from '../components/SituationCard.js';
import { ProjectRail } from '../components/ProjectRail.js';
import { SelvedgeLockup, SelvedgeMark } from '../components/Logo.js';

const COLORS: Array<{ token: string; varName: string; note: string }> = [
  { token: 'paper', varName: '--paper', note: 'the daylight ground' },
  { token: 'ink', varName: '--ink', note: 'primary text' },
  { token: 'ink-dim', varName: '--ink-dim', note: 'secondary text' },
  { token: 'ink-faint', varName: '--ink-faint', note: 'tertiary; also the cannot_tell edge (dashed)' },
  { token: 'panel', varName: '--panel', note: 'pane fill (solid glass fallback)' },
  { token: 'panel-soft', varName: '--panel-soft', note: 'inset pane fill' },
  { token: 'hairline', varName: '--hairline', note: 'borders, dividers' },
];

const STATUS: Array<{ token: string; varName: string; note: string }> = [
  { token: 'thread', varName: '--thread', note: 'RATIONED — needs-you only. Never decorative.' },
  { token: 'brass', varName: '--brass', note: 'working / in-motion; also focus rings' },
  { token: 'healthy', varName: '--healthy', note: 'quiet good (users_fine)' },
];

const TYPE_SCALE: Array<{ name: string; varName: string; px: string; sample: string; className: string }> = [
  { name: 'label', varName: '--text-label', px: '11', sample: 'YOUR STACK · READ THE EDGES', className: 'text-label font-body uppercase tracking-widest text-ink-quiet' },
  { name: 'meta', varName: '--text-meta', px: '12', sample: 'composed this morning at 7:02', className: 'text-meta font-body text-ink-dim' },
  { name: 'tech', varName: '--text-tech', px: '12.5', sample: 'workflow_run failed · exit 1 · deploy.yml#L34', className: 'text-tech font-mono text-ink-dim' },
  { name: 'body', varName: '--text-body', px: '14', sample: 'Everything else ran quietly and stayed up.', className: 'text-body font-body text-ink' },
  { name: 'body-lg', varName: '--text-body-lg', px: '14.5', sample: 'Mirror shipped an update in the late morning.', className: 'text-body-lg font-body text-ink' },
  { name: 'lede', varName: '--text-lede', px: '15.5', sample: 'Users are fine — the previous version is still serving.', className: 'text-lede font-body font-medium text-ink' },
  { name: 'headline', varName: '--text-headline', px: '20', sample: 'What moved', className: 'text-headline font-display text-ink' },
  { name: 'display', varName: '--text-display', px: '22', sample: 'A quiet day, kept.', className: 'text-display font-display font-medium text-ink' },
];

function Swatch({ varName, token, note }: { varName: string; token: string; note: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-12 w-12 shrink-0 rounded-inset border border-hairline"
        style={{ background: `var(${varName})` }}
      />
      <div>
        <p className="font-mono text-tech text-ink">
          {token} <span className="text-ink-quiet">{varName}</span>
        </p>
        <p className="text-meta text-ink-dim">{note}</p>
      </div>
    </div>
  );
}

export function Styleguide() {
  return (
    <div className="space-y-10 pb-16">
      <header>
        <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Selvedge · design tokens</p>
        <h1 className="mt-1 text-display font-display font-medium">Cloth and light</h1>
        <p className="mt-2 max-w-xl text-body text-ink-dim">
          Chalk-paper daylight, frosted panels, one signature seam. Color is rationed: selvedge-red appears only for
          what needs you. Every value on this page lives in <span className="font-mono text-tech">tokens.css</span> —
          nothing else is allowed in.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-headline font-display">The mark</h2>
        <div className="flex flex-wrap items-center gap-8 rounded-pane border border-hairline bg-panel p-6">
          <SelvedgeMark tone="ink" className="h-16 w-16" />
          <SelvedgeLockup tone="ink" className="h-10 w-auto" />
          <div className="flex items-center gap-6 rounded-card p-4" style={{ background: '#1A1F36' }}>
            <SelvedgeMark tone="chalk" className="h-12 w-12" />
            <SelvedgeLockup tone="chalk" className="h-8 w-auto" />
          </div>
        </div>
        <p className="mt-2 max-w-xl text-meta text-ink-dim">
          Woven warp threads crossed by the weft — with one selvedge-red thread (the <span className="font-mono text-tech">--thread</span>{' '}
          token), the same rationed red that means "needs you" everywhere in the app. The wordmark's <span className="text-thread">l</span> is
          that thread.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">Ground &amp; ink</h2>
        <div className="grid grid-cols-1 gap-3 rounded-pane border border-hairline bg-panel p-5 sm:grid-cols-2">
          {COLORS.map((c) => (
            <Swatch key={c.token} {...c} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">Status — rationed</h2>
        <div className="grid grid-cols-1 gap-3 rounded-pane border border-hairline bg-panel p-5 sm:grid-cols-2">
          {STATUS.map((c) => (
            <Swatch key={c.token} {...c} />
          ))}
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 shrink-0 rounded-inset border-2 border-dashed" style={{ borderColor: 'var(--ink-faint)' }} />
            <div>
              <p className="font-mono text-tech text-ink">
                cannot_tell <span className="text-ink-quiet">--ink-faint + dashed</span>
              </p>
              <p className="text-meta text-ink-dim">shape-distinct: "can't see" must never read as "fine"</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">The selvedge edge</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(
            [
              { status: 'healthy', label: 'healthy', copy: 'quiet good — users are fine' },
              { status: 'working', label: 'working', copy: 'in motion — something is happening' },
              { status: 'needs', label: 'needs you', copy: 'the only place thread appears; the only glow' },
              { status: 'unknown', label: 'unknown', copy: "cannot_tell — dashed, never mistakable for fine" },
            ] as const
          ).map((s) => (
            <div key={s.status} className="relative rounded-card border border-hairline bg-panel p-4 pl-5">
              <SelvedgeEdge status={s.status} />
              <p className="flex items-center gap-2 text-body font-medium text-ink">
                <StatusDot status={s.status} /> {s.label}
              </p>
              <p className="mt-1 text-meta text-ink-dim">{s.copy}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">Type — three registers</h2>
        <div className="space-y-4 rounded-pane border border-hairline bg-panel p-5">
          {TYPE_SCALE.map((t) => (
            <div key={t.name} className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="w-24 shrink-0 font-mono text-tech text-ink-quiet">
                {t.name} · {t.px}
              </span>
              <span className={t.className}>{t.sample}</span>
            </div>
          ))}
          <p className="border-t border-hairline pt-3 text-meta text-ink-dim">
            Load-bearing rule: drill-down <em>shifts typeface</em>, body → mono. The technical register is a different
            material, not a smaller font.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">Radius</h2>
        <div className="flex flex-wrap gap-5 rounded-pane border border-hairline bg-panel p-5">
          {[
            { name: 'pane', varName: '--radius-pane', px: 20 },
            { name: 'card', varName: '--radius-card', px: 13 },
            { name: 'inset', varName: '--radius-inset', px: 9 },
          ].map((r) => (
            <div key={r.name} className="text-center">
              <div
                className="h-20 w-28 border border-hairline bg-panel-soft"
                style={{ borderRadius: `var(${r.varName})` }}
              />
              <p className="mt-2 font-mono text-tech text-ink-dim">
                {r.name} · {r.px}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">Glass — progressive enhancement</h2>
        <div
          className="relative overflow-hidden rounded-pane border border-hairline p-5"
          style={{ background: 'linear-gradient(120deg, var(--paper), var(--panel-soft) 45%, #dfe6ec)' }}
        >
          <div
            className="rounded-card border border-hairline p-4"
            style={{ background: 'var(--glass-fill)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)' }}
          >
            <p className="text-body-lg text-ink">
              Frosted pane. Solid <span className="font-mono text-tech">--panel</span> by default; translucency exists
              only inside <span className="font-mono text-tech">@supports (backdrop-filter)</span>. Readability never
              depends on blur.
            </p>
          </div>
          <div className="pointer-events-none absolute inset-0" style={{ background: 'var(--specular)' }} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">The brief — Day-2 golden, rendered</h2>
        <Brief status="unknown">
          <div>
            <BriefEyebrow>Morning brief · mixed day</BriefEyebrow>
            <Headline>Two things need you this morning.</Headline>
          </div>
          <BriefItem
            kind="attention"
            verdict="users_fine"
            reveal={
              <Reveal>
                chalk · first 5 live transactions · verdict users_fine (sales) · secondary cannot_tell (chalk→loom
                sync)
              </Reveal>
            }
          >
            Chalk ran its first five real transactions — the sales themselves went through fine. What I can't confirm
            is whether the transaction data made it back to Loom; check that connection before more sales stack up.
          </BriefItem>
          <BriefItem
            kind="attention"
            verdict="cannot_tell"
            reveal={<Reveal>sild · post-ship check coverage suspect · verdict cannot_tell · next: verify knowledge packs</Reveal>}
          >
            And SILD: the checks you built around the new features don't look like they're working right. Have Claude
            verify the knowledge packs are behaving — and a live test with a real counterparty would confirm SILD is
            actually reading their position correctly.
          </BriefItem>
          <BriefClose>Everything else is quiet.</BriefClose>
        </Brief>
        <p className="mt-2 text-meta text-ink-dim">
          Verdict → edge is fixed vocabulary: users_fine → healthy, users_affected → thread, cannot_tell → dashed. The
          pane's own edge carries the day's top priority (here: a cannot_tell outranks a users_fine).
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">The project rail — read the edges</h2>
        <ProjectRail
          projects={[
            { project_id: 'loom', name: 'Loom', tier: 'live_critical', health_line: 'Healthy.', edge: 'healthy' },
            { project_id: 'mirror', name: 'Mirror', tier: 'live_small', health_line: 'Two branches in motion.', edge: 'working' },
            { project_id: 'chalk', name: 'Chalk', tier: 'live_critical', health_line: 'Looks down right now.', edge: 'needs' },
            { project_id: 'sild', name: 'SILD', tier: 'live_small', health_line: "I can't fully verify this project's health right now.", edge: 'unknown' },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">Situation cards — the same fact, three registers</h2>
        <p className="mb-3 text-body text-ink-dim">
          One live event from the watching loop, rendered at each owner's <span className="font-mono text-tech">detail_level</span>.
          The verdict — and so the edge — is identical across all three. Only the technical line changes: absent, collapsed
          behind <span className="italic">why</span>, or shown inline.
        </p>
        <div className="space-y-3">
          {(['plain_only', 'plain_expandable', 'technical_forward'] as const).map((level) => (
            <SituationCard
              key={level}
              event={{
                id: `demo_${level}`,
                projectId: 'chalk',
                project_name: 'Chalk',
                eventId: 'evt_demo',
                eventType: 'runtime.health_failing',
                fragment: 'Chalk looks down right now — visitors are hitting an error page.',
                technicalDetail: 'GET / returned HTTP 500 on two consecutive checks, 60s apart.',
                verdict: 'users_affected',
                confidence: 'medium',
                detail_level: level,
                occurredAt: '2026-07-31T09:12:00Z',
              }}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-headline font-display">Motion — settle</h2>
        <div className="rounded-pane border border-hairline bg-panel p-5">
          <p className="text-body text-ink-dim">
            One gentle arrival, then stillness: <span className="font-mono text-tech">--settle</span> ={' '}
            <span className="font-mono text-tech">560ms cubic-bezier(.23,.9,.32,1)</span>. Nothing loops. Under{' '}
            <span className="font-mono text-tech">prefers-reduced-motion</span> the duration token collapses to 0ms —
            every animation obeys automatically because none may use any other duration.
          </p>
        </div>
      </section>
    </div>
  );
}
