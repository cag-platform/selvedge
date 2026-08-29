import { and, eq, getTableColumns, getTableName, inArray, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';
import * as schema from './schema/index.js';
import {
  agentMessageAttachments,
  agentMessages,
  agentRuns,
  cards,
  decisionBriefs,
  externalSessions,
  narrations,
  narrationLibrary,
  orgs,
  packs,
  projectBuild,
  subscriptions,
  threads,
} from './schema/index.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { assertValidPack } from '../packs/validate.js';
import { advance, type CardAction } from '../cards/machine.js';
import { proposeCard } from '../cards/propose.js';
import type { Card } from '../cards/types.js';

/**
 * The screenshot account is real product data, not a client fixture. One seed
 * feeds the browser, the phone and the widget through the same endpoints a
 * customer uses. IDs are stable so the command can refresh recency before a
 * shoot without duplicating history.
 */

export const DEMO_WORKSPACE = 'Northstar Studio';
export const DEMO_PROJECT_IDS = ['demo-morrow', 'demo-relay', 'demo-parcel', 'demo-juniper', 'demo-fieldnote'] as const;

type ProjectId = (typeof DEMO_PROJECT_IDS)[number];

export type DemoSeedResult = {
  workspace: string;
  projects: number;
  threads: number;
  messages: number;
  openFixes: number;
};

const threadIds = {
  morrowThinking: 'demo-thread-morrow-timezone-decision',
  morrow: 'demo-thread-morrow-booking-errors',
  relay: 'demo-thread-relay-health-check',
  parcel: 'demo-thread-parcel-delivery-updates',
  juniperDesign: 'demo-thread-juniper-card-direction',
  juniper: 'demo-thread-juniper-autumn-collection',
  fieldnote: 'demo-thread-fieldnote-offline-reports',
} as const;

const consultationIds = {
  juniperCardDirection: 'demo-consultation-juniper-card-direction',
} as const;

const runIds = {
  morrow: 'demo-run-morrow-diagnose',
  relay: 'demo-run-relay-diagnose',
  parcelTurn: 'demo-run-parcel-turn',
  parcelShip: 'demo-run-parcel-ship',
  juniperTurn: 'demo-run-juniper-turn',
  juniperShip: 'demo-run-juniper-ship',
  fieldnoteTurn: 'demo-run-fieldnote-turn',
  fieldnoteShip: 'demo-run-fieldnote-ship',
} as const;

const cardIds = {
  morrow: 'demo-card-morrow-timezone-fallback',
  relay: 'demo-card-relay-health-alias',
  parcel: 'demo-card-parcel-delivery-rows',
  juniper: 'demo-card-juniper-autumn-page',
  fieldnote: 'demo-card-fieldnote-offline-drafts',
} as const;

const fingerprints: Record<ProjectId, string> = {
  'demo-morrow': 'demo:northstar:morrow:calendar-timeout:v1',
  'demo-relay': 'demo:northstar:relay:duplicate-reconnect:v1',
  'demo-parcel': 'demo:northstar:parcel:duplicate-webhook:v1',
  'demo-juniper': 'demo:northstar:juniper:cold-image-check:v1',
  'demo-fieldnote': 'demo:northstar:fieldnote:reconnect-resend:v1',
};

const learnedPhrasing: Record<ProjectId, string> = {
  'demo-morrow': '{project} calendar-provider timeouts clear on one bounded retry.',
  'demo-relay': '{project} reconnect pings can arrive twice without creating a second handoff.',
  'demo-parcel': '{project} carrier webhooks often arrive twice; matching tracking number and status keeps one update.',
  'demo-juniper': '{project} image processing can miss its first check after a cold start, then settles.',
  'demo-fieldnote': '{project} reconnects can resend a saved report; the report id keeps one copy.',
};

function ago(now: Date, amount: number, unit: 'minute' | 'hour' | 'day'): Date {
  const multiplier = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() - amount * multiplier);
}

function ahead(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

function between(start: Date, end: Date, fraction: number): Date {
  return new Date(start.getTime() + (end.getTime() - start.getTime()) * fraction);
}

function scopedId(orgId: string, id: string): string {
  return `${orgId}:${id}`;
}

function scopedMessageMeta(meta: unknown, orgId: string): unknown {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const record = meta as Record<string, unknown>;
  const scoped: Record<string, unknown> = { ...record };
  if (typeof record.run_id === 'string') scoped.run_id = scopedId(orgId, record.run_id);
  if (typeof record.consultation_id === 'string') scoped.consultation_id = scopedId(orgId, record.consultation_id);
  if (typeof record.in_reply_to === 'string') scoped.in_reply_to = scopedId(orgId, record.in_reply_to);
  if (record.consultation !== null && typeof record.consultation === 'object' && !Array.isArray(record.consultation)) {
    const consultation = record.consultation as Record<string, unknown>;
    scoped.consultation = {
      ...consultation,
      ...(typeof consultation.id === 'string' ? { id: scopedId(orgId, consultation.id) } : {}),
      ...(typeof consultation.prompt_id === 'string' ? { prompt_id: scopedId(orgId, consultation.prompt_id) } : {}),
    };
  }
  return scoped;
}

function advanceOrThrow(card: Card, action: CardAction): Card {
  const result = advance(card, action);
  if (!result.ok) throw new Error(`Invalid demo card lifecycle (${action.type}: ${result.error}).`);
  return result.card;
}

function demoPack(input: {
  id: ProjectId;
  name: string;
  description: string;
  audience: string;
  tier: 'live_small' | 'live_critical';
  userScale: 'dozens' | 'hundreds';
  touchesMoney: boolean;
  downtime: string;
  stack: string;
  healthy: boolean;
  cadence: 'multiple_daily' | 'daily' | 'weekly';
  deployedAt: Date;
  glossary: { term: string; preferred: string };
  knownFlaky?: { pattern: string; note: string };
  gap?: { gap: string; summary: string; blocking: string };
  inProgress?: { ref: string; summary: string; openedAt: Date; lastActivityAt: Date };
  liveUrl?: string;
}): ContextPack {
  const pack: ContextPack = {
    pack_version: '1.0',
    identity: {
      project_id: input.id,
      name: input.name,
      owner_description: input.description,
      audience: input.audience,
      ...(input.liveUrl ? { links: { live_url: input.liveUrl } } : {}),
    },
    stakes: {
      tier: input.tier,
      has_external_users: true,
      user_scale: input.userScale,
      touches_money: input.touchesMoney,
      business_role: input.touchesMoney ? 'revenue_product' : 'internal_operations',
      downtime_translation: input.downtime,
    },
    topology: {
      // Deliberately connector-free. A marketing account must not poll a fake
      // URL, receive production webhooks, or imply that an invented repo is a
      // door the owner can open.
      sources: [],
      stack_summary: input.stack,
      ...(input.gap ? { capability_gaps: [input.gap] } : {}),
    },
    baselines: {
      deploy_cadence: input.cadence,
      typical_build_seconds: input.cadence === 'multiple_daily' ? 78 : 112,
      build_failure_rate_30d: input.healthy ? 0.04 : 0.09,
      ...(input.knownFlaky ? { known_flaky: [{ ...input.knownFlaky, graduated: true }] } : {}),
    },
    state: {
      serving_now: {
        version_ref: `demo-${input.deployedAt.toISOString().slice(0, 10)}`,
        deployed_at: input.deployedAt.toISOString(),
        healthy: input.healthy,
      },
      last_successful_deploy: input.deployedAt.toISOString(),
      ...(input.inProgress
        ? {
            in_progress: [
              {
                ref: input.inProgress.ref,
                summary: input.inProgress.summary,
                opened_at: input.inProgress.openedAt.toISOString(),
                last_activity_at: input.inProgress.lastActivityAt.toISOString(),
              },
            ],
          }
        : {}),
    },
    trust: { overall_confidence: 'high' },
    voice: {
      detail_level: 'plain_expandable',
      language: 'en',
      glossary_overrides: [
        {
          term: input.glossary.term,
          preferred_phrasing: input.glossary.preferred,
          graduated_at: ago(input.deployedAt, 30, 'day').toISOString(),
        },
      ],
    },
  };
  assertValidPack(pack);
  return pack;
}

function packsFor(now: Date): ContextPack[] {
  return [
    demoPack({
      id: 'demo-morrow',
      name: 'Morrow',
      description:
        'Morrow handles booking and deposits for independent wellness studios. When a customer has no timezone, use the studio timezone; never guess UTC.',
      audience: '42 independent studios and the clients booking with them',
      tier: 'live_critical',
      userScale: 'hundreds',
      touchesMoney: true,
      downtime: 'new clients cannot book or pay a deposit',
      stack: 'Next.js and TypeScript on Railway, Postgres, Stripe deposits, Google Calendar sync.',
      healthy: false,
      cadence: 'multiple_daily',
      deployedAt: ago(now, 3, 'hour'),
      glossary: { term: 'appointment', preferred: 'booking' },
      knownFlaky: {
        pattern: 'calendar_provider_timeout',
        note: 'A single calendar-provider timeout normally clears on one bounded retry.',
      },
    }),
    demoPack({
      id: 'demo-relay',
      name: 'Relay',
      description: 'Relay is the shift-handoff board field teams use between jobs.',
      audience: '18 field crews across three service regions',
      tier: 'live_small',
      userScale: 'dozens',
      touchesMoney: false,
      downtime: 'crews lose the notes from the shift before them',
      stack: 'React, Express and Postgres on Railway with a lightweight mobile web shell.',
      healthy: true,
      cadence: 'daily',
      deployedAt: ago(now, 1, 'day'),
      glossary: { term: 'handoff', preferred: 'shift handoff' },
      liveUrl: 'https://tryselvedge.com/demo-apps/relay',
      gap: {
        gap: 'health-check-route',
        summary: 'Monitoring still points at the old /health route.',
        blocking: 'a reliable all-clear after each deploy',
      },
      inProgress: {
        ref: 'restore-health-check',
        summary: 'Restore the health check without interrupting crews.',
        openedAt: ago(now, 2, 'hour'),
        lastActivityAt: ago(now, 28, 'minute'),
      },
    }),
    demoPack({
      id: 'demo-parcel',
      name: 'Parcel',
      description: 'Parcel is the shipment-tracking portal subscription brands share with their customers.',
      audience: 'customers waiting on roughly 1,800 active shipments',
      tier: 'live_critical',
      userScale: 'hundreds',
      touchesMoney: false,
      downtime: 'customers cannot see where an order is or whether it needs attention',
      stack: 'Remix on Vercel, Postgres, and carrier webhooks from Shippo.',
      healthy: true,
      cadence: 'multiple_daily',
      deployedAt: ago(now, 4, 'hour'),
      glossary: { term: 'exception', preferred: 'delivery issue' },
    }),
    demoPack({
      id: 'demo-juniper',
      name: 'Juniper',
      description: 'Juniper lets independent plant shops shape their storefront without touching code.',
      audience: '11 plant shops and their online customers',
      tier: 'live_small',
      userScale: 'dozens',
      touchesMoney: true,
      downtime: 'shops cannot update what is for sale',
      stack: 'Next.js on Vercel, Supabase, Stripe, and an image-processing worker.',
      healthy: true,
      cadence: 'weekly',
      deployedAt: ago(now, 1, 'day'),
      glossary: { term: 'collection', preferred: 'seasonal storefront group' },
      knownFlaky: {
        pattern: 'image_worker_cold_start',
        note: 'The first image check after a cold start may miss once, then settles.',
      },
    }),
    demoPack({
      id: 'demo-fieldnote',
      name: 'Fieldnote',
      description: 'Fieldnote is the offline inspection and reporting app property teams carry on site.',
      audience: '27 inspectors working in basements, rooftops, and low-signal buildings',
      tier: 'live_small',
      userScale: 'dozens',
      touchesMoney: false,
      downtime: 'inspectors have to repeat a visit or reconstruct notes later',
      stack: 'Swift and React Native clients backed by a TypeScript sync service and Postgres.',
      healthy: true,
      cadence: 'weekly',
      deployedAt: ago(now, 2, 'day'),
      glossary: { term: 'visit', preferred: 'inspection' },
    }),
  ];
}

function threadRows(now: Date) {
  return [
    {
      id: threadIds.morrowThinking,
      orgId: '',
      projectId: 'demo-morrow',
      subjectId: null,
      kind: 'general',
      title: 'Choose a timezone fallback',
      agent: 'gpt',
      model: 'gpt-5.6-terra',
      technicalDetail: null,
      createdAt: ago(now, 4, 'day'),
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    },
    {
      id: threadIds.morrow,
      orgId: '',
      projectId: 'demo-morrow',
      subjectId: null,
      kind: 'workshop',
      title: 'Fix booking confirmation errors',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      technicalDetail: null,
      createdAt: ago(now, 2, 'hour'),
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    },
    {
      id: threadIds.relay,
      orgId: '',
      projectId: 'demo-relay',
      subjectId: null,
      kind: 'workshop',
      title: 'Restore the health check',
      agent: 'claude-code',
      model: 'sonnet',
      technicalDetail: null,
      createdAt: ago(now, 3, 'hour'),
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    },
    {
      id: threadIds.parcel,
      orgId: '',
      projectId: 'demo-parcel',
      subjectId: null,
      kind: 'workshop',
      title: 'Make delivery updates easier to scan',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      technicalDetail: null,
      createdAt: ago(now, 2, 'day'),
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    },
    {
      id: threadIds.juniperDesign,
      orgId: '',
      projectId: 'demo-juniper',
      subjectId: null,
      kind: 'general',
      title: 'Choose the collection-card direction',
      agent: 'gpt',
      model: 'gpt-5.6-terra',
      technicalDetail: null,
      createdAt: ago(now, 80, 'minute'),
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    },
    {
      id: threadIds.juniper,
      orgId: '',
      projectId: 'demo-juniper',
      subjectId: null,
      kind: 'workshop',
      title: 'Refresh the autumn collection page',
      agent: 'claude-code',
      model: 'sonnet',
      technicalDetail: null,
      createdAt: ago(now, 4, 'day'),
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    },
    {
      id: threadIds.fieldnote,
      orgId: '',
      projectId: 'demo-fieldnote',
      subjectId: null,
      kind: 'workshop',
      title: 'Save reports when signal drops',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      technicalDetail: null,
      createdAt: ago(now, 7, 'day'),
      archivedAt: null,
      importedFrom: null,
      importSourceId: null,
    },
  ];
}

function tool(id: string, name: string, detail: string, ok = true, note?: string) {
  return { id, name, detail, ok, ...(note ? { note } : {}) };
}

function messageRows(now: Date) {
  return [
    {
      id: 'demo-message-morrow-thinking-owner',
      projectId: 'demo-morrow',
      threadId: threadIds.morrowThinking,
      role: 'owner',
      content: 'If a customer has not shared a timezone, should booking use the studio timezone or UTC?',
      meta: null,
      runId: null,
      createdAt: ago(now, 4, 'day'),
    },
    {
      id: 'demo-message-morrow-thinking-agent',
      projectId: 'demo-morrow',
      threadId: threadIds.morrowThinking,
      role: 'agent',
      content:
        'Use the studio timezone. It is the one stable, owner-controlled fact that matches how the booking is staffed. Never silently guess UTC; keep the original value when the customer supplies one.',
      meta: { answered_by: 'gpt' },
      runId: null,
      createdAt: ago(now, 4, 'day'),
    },
    {
      id: 'demo-message-morrow-owner',
      projectId: 'demo-morrow',
      threadId: threadIds.morrow,
      role: 'owner',
      content: 'A few new customers are seeing an error after they choose a time. Can you find the smallest safe fix?',
      meta: null,
      runId: runIds.morrow,
      createdAt: ago(now, 34, 'minute'),
    },
    {
      id: 'demo-message-morrow-activity',
      projectId: 'demo-morrow',
      threadId: threadIds.morrow,
      role: 'activity',
      content: 'Read booking confirmation path\nReproduced missing timezone\nChecked existing booking records',
      meta: {
        run_id: runIds.morrow,
        tools: [
          tool('morrow-tool-1', 'Read', 'Reading src/bookings/confirm.ts'),
          tool('morrow-tool-2', 'Test', 'Reproducing a confirmation with no customer timezone'),
          tool('morrow-tool-3', 'Query', 'Checking whether existing bookings were changed'),
        ],
        truncated: false,
      },
      runId: runIds.morrow,
      createdAt: ago(now, 21, 'minute'),
    },
    {
      id: 'demo-message-morrow-agent',
      projectId: 'demo-morrow',
      threadId: threadIds.morrow,
      role: 'agent',
      content:
        'I found it. A blank customer timezone reaches the date formatter after this morning’s deploy. Existing bookings are untouched. The safe fix is to fall back to the studio timezone and lock that behavior in with one regression test.',
      meta: { answered_by: 'codex' },
      runId: runIds.morrow,
      createdAt: ago(now, 6, 'minute'),
    },
    {
      id: 'demo-message-relay-owner',
      projectId: 'demo-relay',
      threadId: threadIds.relay,
      role: 'owner',
      content: 'Why is Relay showing down if crews can still use it?',
      meta: null,
      runId: runIds.relay,
      createdAt: ago(now, 58, 'minute'),
    },
    {
      id: 'demo-message-relay-activity',
      projectId: 'demo-relay',
      threadId: threadIds.relay,
      role: 'activity',
      content: 'Checked old health route\nChecked current API health route\nRead deploy configuration',
      meta: {
        run_id: runIds.relay,
        tools: [
          tool('relay-tool-1', 'Fetch', 'GET /health', false, '404 Not Found'),
          tool('relay-tool-2', 'Fetch', 'GET /api/health'),
          tool('relay-tool-3', 'Read', 'Reading railway.json health-check configuration'),
        ],
        truncated: false,
      },
      runId: runIds.relay,
      createdAt: ago(now, 42, 'minute'),
    },
    {
      id: 'demo-message-relay-agent',
      projectId: 'demo-relay',
      threadId: threadIds.relay,
      role: 'agent',
      content:
        'Crews are fine. The app moved its check from /health to /api/health, but monitoring still calls the old address. I can add a backwards-compatible alias and update the check so the all-clear means something again.',
      meta: { answered_by: 'claude-code' },
      runId: runIds.relay,
      createdAt: ago(now, 31, 'minute'),
    },
    {
      id: 'demo-message-parcel-owner',
      projectId: 'demo-parcel',
      threadId: threadIds.parcel,
      role: 'owner',
      content: 'Make delivery updates easier to scan. The important change should read first without losing the carrier detail.',
      meta: null,
      runId: runIds.parcelTurn,
      createdAt: ago(now, 9, 'hour'),
    },
    {
      id: 'demo-message-parcel-claude',
      projectId: 'demo-parcel',
      threadId: threadIds.parcel,
      role: 'agent',
      content: 'I mapped the current event hierarchy and kept the carrier payload intact. The visual grouping is ready for a second pass.',
      meta: { answered_by: 'claude-code' },
      runId: runIds.parcelTurn,
      createdAt: ago(now, 8, 'hour'),
    },
    {
      id: 'demo-message-parcel-switch',
      projectId: 'demo-parcel',
      threadId: threadIds.parcel,
      role: 'switch',
      content: '⇄ continued with Codex — handoff 418 tokens, about $0.001',
      meta: { switch: { from: 'claude-code', to: 'codex', tokens: 418, cost_usd: 0.001, payload: null, pending: false } },
      runId: null,
      createdAt: ago(now, 7, 'hour'),
    },
    {
      id: 'demo-message-parcel-activity',
      projectId: 'demo-parcel',
      threadId: threadIds.parcel,
      role: 'activity',
      content: 'Edited delivery timeline\nAdded accessibility labels\nRan focused tests',
      meta: {
        run_id: runIds.parcelTurn,
        tools: [
          tool('parcel-tool-1', 'Edit', 'Editing app/components/DeliveryTimeline.tsx'),
          tool('parcel-tool-2', 'Edit', 'Editing app/styles/delivery.css'),
          tool('parcel-tool-3', 'Test', 'Running delivery timeline tests'),
        ],
        truncated: false,
      },
      runId: runIds.parcelTurn,
      createdAt: ago(now, 4, 'hour'),
    },
    {
      id: 'demo-message-parcel-agent',
      projectId: 'demo-parcel',
      threadId: threadIds.parcel,
      role: 'agent',
      content:
        'Done. The current delivery state leads, supporting carrier detail stays one line below, and repeated webhooks still collapse into one update. Keyboard and screen-reader labels are covered.',
      meta: { answered_by: 'codex' },
      runId: runIds.parcelTurn,
      createdAt: ago(now, 3, 'hour'),
    },
    {
      id: 'demo-message-juniper-design-owner',
      projectId: 'demo-juniper',
      threadId: threadIds.juniperDesign,
      role: 'owner',
      content:
        '@claudecode @codex The autumn collection cards feel too much like a catalog. Should the product image or the collection name lead? Give me two distinct directions before we build.',
      meta: { consultation_id: consultationIds.juniperCardDirection },
      runId: null,
      createdAt: ago(now, 44, 'minute'),
    },
    {
      id: 'demo-message-juniper-design-marker',
      projectId: 'demo-juniper',
      threadId: threadIds.juniperDesign,
      role: 'switch',
      content: '⇄ asked Claude Code and Codex for a take — nothing was built, and the conversation stays where it is.',
      meta: {
        consulted: ['claude-code', 'codex'],
        consultation_id: consultationIds.juniperCardDirection,
        consultation: {
          id: consultationIds.juniperCardDirection,
          prompt_id: 'demo-message-juniper-design-owner',
          agents: ['claude-code', 'codex'],
        },
      },
      runId: null,
      createdAt: ago(now, 43, 'minute'),
    },
    {
      id: 'demo-message-juniper-design-claude',
      projectId: 'demo-juniper',
      threadId: threadIds.juniperDesign,
      role: 'agent',
      content:
        'I would let the collection name lead. Use a quiet season label, a two-line title, then a fixed 4:5 image. That repeated anatomy makes a mixed catalog easy to scan and keeps every collection identifiable on a phone, while the photography can still vary inside a stable frame.',
      meta: {
        answered_by: 'claude-code',
        consultation_id: consultationIds.juniperCardDirection,
        in_reply_to: 'demo-message-juniper-design-owner',
      },
      runId: null,
      createdAt: ago(now, 40, 'minute'),
    },
    {
      id: 'demo-message-juniper-design-codex',
      projectId: 'demo-juniper',
      threadId: threadIds.juniperDesign,
      role: 'agent',
      content:
        'I would let the product image lead. Give each card a generous 4:5 crop, place the collection name along the lower edge, and reveal secondary detail only on focus or hover. It will feel like an editorial spread instead of a product grid; on touch screens, keep the name permanently visible.',
      meta: {
        answered_by: 'codex',
        consultation_id: consultationIds.juniperCardDirection,
        in_reply_to: 'demo-message-juniper-design-owner',
      },
      runId: null,
      createdAt: ago(now, 39, 'minute'),
    },
    {
      id: 'demo-message-juniper-design-decision',
      projectId: 'demo-juniper',
      threadId: threadIds.juniperDesign,
      role: 'owner',
      content:
        'Let’s use Codex’s image-led rhythm, but keep Claude Code’s always-visible collection name and stable crop. That gives us the editorial feeling without hiding what each collection is.',
      meta: null,
      runId: null,
      createdAt: ago(now, 18, 'minute'),
    },
    {
      id: 'demo-message-juniper-owner',
      projectId: 'demo-juniper',
      threadId: threadIds.juniper,
      role: 'owner',
      content: 'Give the autumn collection a calmer editorial opening, then make sure the image crop still works on phones.',
      meta: null,
      runId: runIds.juniperTurn,
      createdAt: ago(now, 2, 'day'),
    },
    {
      id: 'demo-message-juniper-activity',
      projectId: 'demo-juniper',
      threadId: threadIds.juniper,
      role: 'activity',
      content: 'Edited collection hero\nChecked responsive crops\nRan storefront tests',
      meta: {
        run_id: runIds.juniperTurn,
        tools: [
          tool('juniper-tool-1', 'Edit', 'Editing app/collections/[slug]/page.tsx'),
          tool('juniper-tool-2', 'Preview', 'Checking 390px and 1280px layouts'),
          tool('juniper-tool-3', 'Test', 'Running storefront smoke tests'),
        ],
        truncated: false,
      },
      runId: runIds.juniperTurn,
      createdAt: ago(now, 1, 'day'),
    },
    {
      id: 'demo-message-juniper-agent',
      projectId: 'demo-juniper',
      threadId: threadIds.juniper,
      role: 'agent',
      content: 'The autumn page is live. It opens with one editorial idea, the product grid breathes, and the crop holds on small screens.',
      meta: { answered_by: 'claude-code' },
      runId: runIds.juniperTurn,
      createdAt: ago(now, 23, 'hour'),
    },
    {
      id: 'demo-message-fieldnote-owner',
      projectId: 'demo-fieldnote',
      threadId: threadIds.fieldnote,
      role: 'owner',
      content: 'An inspector should never lose a report when the signal disappears halfway through.',
      meta: null,
      runId: runIds.fieldnoteTurn,
      createdAt: ago(now, 5, 'day'),
    },
    {
      id: 'demo-message-fieldnote-activity',
      projectId: 'demo-fieldnote',
      threadId: threadIds.fieldnote,
      role: 'activity',
      content: 'Added local draft queue\nHandled reconnect replay\nRan offline sync tests',
      meta: {
        run_id: runIds.fieldnoteTurn,
        tools: [
          tool('fieldnote-tool-1', 'Edit', 'Editing Sources/Reports/DraftQueue.swift'),
          tool('fieldnote-tool-2', 'Edit', 'Editing server/sync/replay.ts'),
          tool('fieldnote-tool-3', 'Test', 'Running offline and reconnect tests'),
        ],
        truncated: false,
      },
      runId: runIds.fieldnoteTurn,
      createdAt: ago(now, 3, 'day'),
    },
    {
      id: 'demo-message-fieldnote-agent',
      projectId: 'demo-fieldnote',
      threadId: threadIds.fieldnote,
      role: 'agent',
      content:
        'Reports now save locally first and upload when the signal returns. Reconnects use the report id, so a retry cannot create a duplicate.',
      meta: { answered_by: 'codex' },
      runId: runIds.fieldnoteTurn,
      createdAt: ago(now, 2, 'day'),
    },
  ];
}

function runRows(now: Date) {
  return [
    {
      id: runIds.morrow,
      projectId: 'demo-morrow',
      threadId: threadIds.morrow,
      prompt: 'plan: find the smallest safe booking confirmation fix',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      status: 'succeeded',
      costCents: 9,
      commitSha: null,
      verdict: null,
      changedPaths: null,
      startedAt: ago(now, 26, 'minute'),
      finishedAt: ago(now, 20, 'minute'),
      createdAt: ago(now, 27, 'minute'),
    },
    {
      id: runIds.relay,
      projectId: 'demo-relay',
      threadId: threadIds.relay,
      prompt: 'plan: verify whether the health alarm means users are down',
      agent: 'claude-code',
      model: 'sonnet',
      status: 'succeeded',
      costCents: 7,
      commitSha: null,
      verdict: null,
      changedPaths: null,
      startedAt: ago(now, 48, 'minute'),
      finishedAt: ago(now, 41, 'minute'),
      createdAt: ago(now, 49, 'minute'),
    },
    {
      id: runIds.parcelTurn,
      projectId: 'demo-parcel',
      threadId: threadIds.parcel,
      prompt: 'make delivery updates easier to scan without losing carrier detail',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      status: 'succeeded',
      costCents: 18,
      commitSha: null,
      verdict: 'verified',
      changedPaths: ['app/components/DeliveryTimeline.tsx', 'app/styles/delivery.css'],
      startedAt: ago(now, 5, 'hour'),
      finishedAt: ago(now, 4, 'hour'),
      createdAt: ago(now, 5, 'hour'),
    },
    {
      id: runIds.parcelShip,
      projectId: 'demo-parcel',
      threadId: threadIds.parcel,
      prompt: 'ship: clearer delivery updates with carrier detail preserved',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      status: 'succeeded',
      costCents: 2,
      commitSha: '8fd42b19bc7a',
      verdict: 'verified',
      changedPaths: ['app/components/DeliveryTimeline.tsx', 'app/styles/delivery.css'],
      startedAt: ago(now, 3, 'hour'),
      finishedAt: ago(now, 3, 'hour'),
      createdAt: ago(now, 3, 'hour'),
    },
    {
      id: runIds.juniperTurn,
      projectId: 'demo-juniper',
      threadId: threadIds.juniper,
      prompt: 'refresh the autumn collection page and preserve mobile crops',
      agent: 'claude-code',
      model: 'sonnet',
      status: 'succeeded',
      costCents: 21,
      commitSha: null,
      verdict: 'verified',
      changedPaths: ['app/collections/[slug]/page.tsx', 'app/styles/collection.css'],
      startedAt: ago(now, 27, 'hour'),
      finishedAt: ago(now, 25, 'hour'),
      createdAt: ago(now, 27, 'hour'),
    },
    {
      id: runIds.juniperShip,
      projectId: 'demo-juniper',
      threadId: threadIds.juniper,
      prompt: 'ship: calmer autumn collection opening and responsive image crop',
      agent: 'claude-code',
      model: 'sonnet',
      status: 'succeeded',
      costCents: 2,
      commitSha: 'ce914ab7461d',
      verdict: 'verified',
      changedPaths: ['app/collections/[slug]/page.tsx', 'app/styles/collection.css'],
      startedAt: ago(now, 24, 'hour'),
      finishedAt: ago(now, 24, 'hour'),
      createdAt: ago(now, 24, 'hour'),
    },
    {
      id: runIds.fieldnoteTurn,
      projectId: 'demo-fieldnote',
      threadId: threadIds.fieldnote,
      prompt: 'save reports locally first and make reconnect replay idempotent',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      status: 'succeeded',
      costCents: 27,
      commitSha: null,
      verdict: 'verified',
      changedPaths: ['Sources/Reports/DraftQueue.swift', 'server/sync/replay.ts'],
      startedAt: ago(now, 4, 'day'),
      finishedAt: ago(now, 3, 'day'),
      createdAt: ago(now, 4, 'day'),
    },
    {
      id: runIds.fieldnoteShip,
      projectId: 'demo-fieldnote',
      threadId: threadIds.fieldnote,
      prompt: 'ship: offline-first report drafts with safe reconnect replay',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      status: 'succeeded',
      costCents: 2,
      commitSha: '4ca91e5d203f',
      verdict: 'verified',
      changedPaths: ['Sources/Reports/DraftQueue.swift', 'server/sync/replay.ts'],
      startedAt: ago(now, 2, 'day'),
      finishedAt: ago(now, 2, 'day'),
      createdAt: ago(now, 2, 'day'),
    },
  ];
}

function cardRows(now: Date, orgId: string) {
  const proposed = (input: {
    id: string;
    projectId: ProjectId;
    title: string;
    proposal: string;
    createdAt: Date;
    low: number;
    high: number;
    cap: number;
  }) =>
    proposeCard({
      id: scopedId(orgId, input.id),
      orgId,
      projectId: input.projectId,
      trigger: 'incident',
      title: input.title,
      proposal: input.proposal,
      signals: {},
      estimate: { lowCents: input.low, highCents: input.high },
      capCents: input.cap,
      checkpointAtFractions: [],
      now: input.createdAt.toISOString(),
    });
  const done = (input: {
    id: string;
    projectId: ProjectId;
    title: string;
    proposal: string;
    createdAt: Date;
    updatedAt: Date;
    spent: number;
  }) => {
    let card = proposeCard({
      id: scopedId(orgId, input.id),
      orgId,
      projectId: input.projectId,
      trigger: 'request',
      title: input.title,
      proposal: input.proposal,
      signals: {},
      estimate: { lowCents: Math.max(1, input.spent - 8), highCents: input.spent + 12 },
      capCents: input.spent + 25,
      checkpointAtFractions: [],
      now: input.createdAt.toISOString(),
    });
    card = advanceOrThrow(card, { type: 'approve', at: between(input.createdAt, input.updatedAt, 0.08).toISOString() });
    card = advanceOrThrow(card, { type: 'start_work', at: between(input.createdAt, input.updatedAt, 0.15).toISOString() });
    card = advanceOrThrow(card, {
      type: 'spend',
      at: between(input.createdAt, input.updatedAt, 0.72).toISOString(),
      cents: input.spent,
      detail: 'Implemented the agreed change and ran its focused checks.',
    });
    card = advanceOrThrow(card, { type: 'begin_verify', at: between(input.createdAt, input.updatedAt, 0.88).toISOString() });
    return advanceOrThrow(card, {
      type: 'complete',
      at: input.updatedAt.toISOString(),
      verdict: 'verified',
      gradedBy: 'independent',
      summary: 'The requested behavior passed focused checks and an independent review.',
    });
  };
  const domainCards = [
    proposed({
      id: cardIds.morrow,
      projectId: 'demo-morrow',
      title: 'Ship the booking timezone fallback',
      proposal: 'Use the studio timezone when a customer has no timezone, then add a regression test before shipping.',
      createdAt: ago(now, 5, 'minute'),
      low: 35,
      high: 70,
      cap: 100,
    }),
    proposed({
      id: cardIds.relay,
      projectId: 'demo-relay',
      title: 'Restore the old health-check address',
      proposal: 'Keep /api/health as the source of truth, add a small /health alias, and point monitoring at the current route.',
      createdAt: ago(now, 29, 'minute'),
      low: 22,
      high: 48,
      cap: 75,
    }),
    done({
      id: cardIds.parcel,
      projectId: 'demo-parcel',
      title: 'Make delivery updates easier to scan',
      proposal: 'Lead with the current state, keep carrier detail underneath, and preserve accessible labels.',
      createdAt: ago(now, 9, 'hour'),
      updatedAt: ago(now, 3, 'hour'),
      spent: 20,
    }),
    done({
      id: cardIds.juniper,
      projectId: 'demo-juniper',
      title: 'Refresh the autumn collection page',
      proposal: 'Give the collection one editorial opening and preserve its image crop at every supported width.',
      createdAt: ago(now, 2, 'day'),
      updatedAt: ago(now, 1, 'day'),
      spent: 23,
    }),
    done({
      id: cardIds.fieldnote,
      projectId: 'demo-fieldnote',
      title: 'Save reports without a signal',
      proposal: 'Save locally first, upload on reconnect, and use the report id to prevent duplicate submissions.',
      createdAt: ago(now, 5, 'day'),
      updatedAt: ago(now, 2, 'day'),
      spent: 29,
    }),
  ];
  return domainCards.map((card) => ({
    ...card,
    createdAt: new Date(card.createdAt),
    updatedAt: new Date(card.updatedAt),
  }));
}

function narrationRows(now: Date) {
  const historical = DEMO_PROJECT_IDS.flatMap((projectId, projectIndex) =>
    [52, 18].map((days, occurrence) => {
      const at = ago(now, days - projectIndex, 'day');
      return {
        id: `demo-narration-${projectId}-learned-${occurrence + 1}`,
        projectId,
        eventId: `demo-event-${projectId}-learned-${occurrence + 1}`,
        eventType: 'runtime.pattern_observed',
        occurredAt: at,
        path: 'LIB',
        intendedPath: 'LIB',
        delivery: 'NONE',
        kind: 'quiet',
        fragment: learnedPhrasing[projectId].replace('{project}', projectId.replace('demo-', '')),
        technicalDetail: `fingerprint ${fingerprints[projectId]}`,
        verdict: 'users_fine',
        confidence: 'high',
        storm: false,
        meta: { fingerprint: fingerprints[projectId] },
        createdAt: at,
      };
    }),
  );
  return [
    ...historical,
    {
      id: 'demo-narration-morrow-current',
      projectId: 'demo-morrow',
      eventId: 'demo-event-morrow-current',
      eventType: 'runtime.error_rate_spike',
      occurredAt: ago(now, 18, 'minute'),
      path: 'TEMPLATE',
      intendedPath: 'LLM+VERDICT',
      delivery: 'PUSH',
      kind: 'attention',
      fragment: 'Morrow is rejecting a small number of new bookings after this morning’s deploy. Existing bookings are safe.',
      technicalDetail: '18 confirmation requests failed in 10 minutes; RangeError: Invalid time zone.',
      verdict: 'users_affected',
      confidence: 'high',
      storm: false,
      meta: { correlation: { plain: 'The failures began after the booking confirmation deploy.' } },
      createdAt: ago(now, 18, 'minute'),
    },
    {
      id: 'demo-narration-relay-current',
      projectId: 'demo-relay',
      eventId: 'demo-event-relay-current',
      eventType: 'runtime.health_failing',
      occurredAt: ago(now, 47, 'minute'),
      path: 'TEMPLATE',
      intendedPath: 'LLM+VERDICT',
      delivery: 'DIGEST',
      kind: 'attention',
      fragment: 'Relay is serving normally, but its old health-check address is returning 404.',
      technicalDetail: 'GET /health → 404; GET /api/health → 200.',
      verdict: 'users_fine',
      confidence: 'high',
      storm: false,
      meta: { correlation: { plain: 'The route moved in yesterday’s deploy; the monitor did not.' } },
      createdAt: ago(now, 47, 'minute'),
    },
  ];
}

/**
 * An automatically-created Clerk organization may have an `orgs` row from its
 * first authenticated API request while still containing no product data. The
 * adoption path calls this before marking that organization as the demo so an
 * empty-looking UI can never cause us to relabel somebody's real workspace.
 */
export async function assertDemoTenantEmpty(db: Db, orgId: string): Promise<void> {
  const occupied: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const table = value as PgTable;
    const tableName = getTableName(table);
    if (tableName === 'orgs') continue;
    const columns = getTableColumns(table) as Record<string, Parameters<typeof eq>[0]>;
    const tenantColumn = columns.orgId;
    if (!tenantColumn) continue;
    const rows = await (db as unknown as {
      select: (fields: Record<string, unknown>) => {
        from: (source: PgTable) => {
          where: (condition: unknown) => { limit: (count: number) => Promise<unknown[]> };
        };
      };
    }).select({ orgId: tenantColumn }).from(table).where(eq(tenantColumn, orgId)).limit(1);
    if (rows.length > 0) occupied.push(tableName);
  }
  if (occupied.length > 0) {
    throw new Error(`Refusing to adopt a Clerk organization that already contains Selvedge data: ${occupied.join(', ')}`);
  }
}

/**
 * Seed one dedicated Clerk tenant. Identity and organization provisioning are
 * performed by the operator CLI; this function accepts Clerk's two valid
 * tenant namespaces and still refuses to mix the scene with other projects.
 */
export async function seedDemoWorkspace(
  db: Db,
  orgId: string,
  now: Date = new Date(),
  options: { boughtByUserId?: string } = {},
): Promise<DemoSeedResult> {
  if (!orgId.startsWith('org_') && !orgId.startsWith('user_')) {
    throw new Error('The marketing demo requires a Clerk user_… or org_… tenant id.');
  }
  const boughtByUserId = options.boughtByUserId ?? orgId;

  const existing = await db.select({ projectId: packs.projectId }).from(packs).where(eq(packs.orgId, orgId));
  const foreign = existing.map((row) => row.projectId).filter((id) => !DEMO_PROJECT_IDS.includes(id as ProjectId));
  if (foreign.length > 0) {
    throw new Error(`Refusing to seed a tenant that already owns non-demo projects: ${foreign.slice(0, 3).join(', ')}`);
  }

  const existingBuilds = await db
    .select({ projectId: projectBuild.projectId, sandboxId: projectBuild.sandboxId })
    .from(projectBuild)
    .where(and(eq(projectBuild.orgId, orgId), inArray(projectBuild.projectId, [...DEMO_PROJECT_IDS])));
  const liveBuild = existingBuilds.find((row) => row.sandboxId !== null);
  if (liveBuild) {
    throw new Error(`Refusing to refresh while ${liveBuild.projectId} has a live sandbox. Stop it first so the reset cannot orphan paid compute.`);
  }

  const existingSubscriptions = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId, stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId));
  if (existingSubscriptions.some((row) => row.stripeCustomerId !== null || row.stripeSubscriptionId !== null)) {
    throw new Error('Refusing to replace a real Stripe subscription on the marketing demo tenant.');
  }

  const demoPacks = packsFor(now);
  const seededThreads = threadRows(now).map((row) => ({ ...row, id: scopedId(orgId, row.id), orgId }));
  const seededMessages = messageRows(now).map((row) => ({
    ...row,
    id: scopedId(orgId, row.id),
    orgId,
    threadId: scopedId(orgId, row.threadId),
    runId: row.runId ? scopedId(orgId, row.runId) : null,
    meta: scopedMessageMeta(row.meta, orgId),
  }));
  const seededRuns = runRows(now).map((row) => ({
    ...row,
    id: scopedId(orgId, row.id),
    orgId,
    threadId: scopedId(orgId, row.threadId),
  }));
  const seededCards = cardRows(now, orgId);
  const seededNarrations = narrationRows(now).map((row) => ({
    ...row,
    id: scopedId(orgId, row.id),
    eventId: scopedId(orgId, row.eventId),
    orgId,
  }));

  await db.transaction(async (tx) => {
    // This account exists for repeatable captures. Remove only data attached to
    // the five named demo projects so a rehearsal can be reset without ever
    // reaching into another tenant or an unrelated project.
    const demoAttachments = and(eq(agentMessageAttachments.orgId, orgId), inArray(agentMessageAttachments.projectId, [...DEMO_PROJECT_IDS]));
    const demoMessages = and(eq(agentMessages.orgId, orgId), inArray(agentMessages.projectId, [...DEMO_PROJECT_IDS]));
    const demoRuns = and(eq(agentRuns.orgId, orgId), inArray(agentRuns.projectId, [...DEMO_PROJECT_IDS]));
    const demoCards = and(eq(cards.orgId, orgId), inArray(cards.projectId, [...DEMO_PROJECT_IDS]));
    const demoNarrations = and(eq(narrations.orgId, orgId), inArray(narrations.projectId, [...DEMO_PROJECT_IDS]));
    const demoDecisions = and(eq(decisionBriefs.orgId, orgId), inArray(decisionBriefs.projectId, [...DEMO_PROJECT_IDS]));
    const demoSessions = and(eq(externalSessions.orgId, orgId), inArray(externalSessions.projectId, [...DEMO_PROJECT_IDS]));
    const demoThreads = and(eq(threads.orgId, orgId), inArray(threads.projectId, [...DEMO_PROJECT_IDS]));
    const demoBuilds = and(eq(projectBuild.orgId, orgId), inArray(projectBuild.projectId, [...DEMO_PROJECT_IDS]));
    await tx.delete(agentMessageAttachments).where(demoAttachments);
    await tx.delete(decisionBriefs).where(demoDecisions);
    await tx.delete(agentMessages).where(demoMessages);
    await tx.delete(agentRuns).where(demoRuns);
    await tx.delete(cards).where(demoCards);
    await tx.delete(narrations).where(demoNarrations);
    await tx.delete(externalSessions).where(demoSessions);
    await tx.delete(threads).where(demoThreads);
    await tx.delete(projectBuild).where(demoBuilds);

    await tx
      .insert(orgs)
      .values({ orgId, timezone: 'America/Denver', timezoneSource: 'user', plan: 'studio', technicalDetail: 'full' })
      .onConflictDoUpdate({
        target: orgs.orgId,
        set: { timezone: 'America/Denver', timezoneSource: 'user', plan: 'studio', technicalDetail: 'full' },
      });

    await tx
      .insert(subscriptions)
      .values({
        id: scopedId(orgId, 'demo-subscription-northstar'),
        orgId,
        boughtByUserId,
        plan: 'pro',
        status: 'active',
        billingInterval: 'yearly',
        grandfatheredPrice: false,
        currentPeriodEnd: ahead(now, 365),
        createdAt: ago(now, 94, 'day'),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subscriptions.orgId,
        set: {
          id: scopedId(orgId, 'demo-subscription-northstar'),
          boughtByUserId,
          plan: 'pro',
          status: 'active',
          billingInterval: 'yearly',
          currentPeriodEnd: ahead(now, 365),
          updatedAt: now,
        },
      });

    for (const pack of demoPacks) {
      await tx
        .insert(packs)
        .values({
          orgId,
          projectId: pack.identity.project_id,
          pack,
          createdAt: ago(now, 94, 'day'),
          updatedAt: now,
          archivedAt: null,
          mutedAt: null,
        })
        .onConflictDoUpdate({
          target: [packs.orgId, packs.projectId],
          set: { pack, createdAt: ago(now, 94, 'day'), updatedAt: now, archivedAt: null, mutedAt: null },
        });
    }

    for (const projectId of DEMO_PROJECT_IDS) {
      await tx
        .insert(narrationLibrary)
        .values({
          id: `demo-library-${projectId}`,
          fingerprint: fingerprints[projectId],
          phrasing: { fragment: learnedPhrasing[projectId] },
          useCount: 6,
          negativeFeedbackCount: 0,
          status: 'graduated',
          createdAt: ago(now, 80, 'day'),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: narrationLibrary.fingerprint,
          set: {
            phrasing: { fragment: learnedPhrasing[projectId] },
            useCount: 6,
            negativeFeedbackCount: 0,
            status: 'graduated',
            updatedAt: now,
          },
        });
    }

    for (const row of seededThreads) {
      await tx.insert(threads).values(row).onConflictDoUpdate({
        target: threads.id,
        set: {
          projectId: row.projectId,
          subjectId: row.subjectId,
          kind: row.kind,
          title: row.title,
          agent: row.agent,
          model: row.model,
          technicalDetail: row.technicalDetail,
          createdAt: row.createdAt,
          archivedAt: null,
        },
      });
    }

    for (const row of seededRuns) {
      await tx.insert(agentRuns).values({ ...row, threadId: row.threadId }).onConflictDoUpdate({
        target: agentRuns.id,
        set: {
          projectId: row.projectId,
          threadId: row.threadId,
          prompt: row.prompt,
          agent: row.agent,
          model: row.model,
          status: row.status,
          costCents: row.costCents,
          commitSha: row.commitSha,
          verdict: row.verdict,
          changedPaths: row.changedPaths,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          createdAt: row.createdAt,
        },
      });
    }

    for (const row of seededMessages) {
      await tx.insert(agentMessages).values({ ...row, threadId: row.threadId }).onConflictDoUpdate({
        target: agentMessages.id,
        set: {
          projectId: row.projectId,
          threadId: row.threadId,
          role: row.role,
          content: row.content,
          meta: row.meta,
          runId: row.runId,
          createdAt: row.createdAt,
        },
      });
    }

    for (const row of seededCards) {
      await tx.insert(cards).values(row).onConflictDoUpdate({
        target: cards.id,
        set: {
          projectId: row.projectId,
          trigger: row.trigger,
          title: row.title,
          proposal: row.proposal,
          risk: row.risk,
          gate: row.gate,
          state: row.state,
          verdict: row.verdict,
          gradedBy: row.gradedBy,
          estimate: row.estimate,
          stop: row.stop,
          spentCents: row.spentCents,
          backupVerified: row.backupVerified,
          acts: row.acts,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
    }

    for (const row of seededNarrations) {
      await tx.insert(narrations).values(row).onConflictDoUpdate({
        target: narrations.id,
        set: {
          projectId: row.projectId,
          eventId: row.eventId,
          eventType: row.eventType,
          occurredAt: row.occurredAt,
          path: row.path,
          intendedPath: row.intendedPath,
          delivery: row.delivery,
          kind: row.kind,
          fragment: row.fragment,
          technicalDetail: row.technicalDetail,
          verdict: row.verdict,
          confidence: row.confidence,
          storm: row.storm,
          meta: row.meta,
          createdAt: row.createdAt,
        },
      });
    }

    await tx
      .insert(decisionBriefs)
      .values({
        id: scopedId(orgId, 'demo-decision-morrow-timezone'),
        orgId,
        projectId: 'demo-morrow',
        thinkingThreadId: scopedId(orgId, threadIds.morrowThinking),
        buildingThreadId: scopedId(orgId, threadIds.morrow),
        title: 'Use the studio timezone when the customer has none',
        decision: 'Use the studio timezone when customer timezone is absent; never guess UTC.',
        why: 'The studio owns the booking calendar and staffs the local time shown to the customer.',
        constraints: ['Keep a customer-supplied timezone unchanged.', 'Do not alter existing bookings.', 'Add a regression test before shipping.'],
        openQuestions: ['Should the confirmation screen say which timezone it is showing?'],
        evidenceThrough: ago(now, 4, 'day'),
        evidenceMessages: 2,
        extractedAt: ago(now, 3, 'day'),
        editedAt: ago(now, 3, 'day'),
        editedByHuman: true,
        createdAt: ago(now, 3, 'day'),
      })
      .onConflictDoUpdate({
        target: decisionBriefs.id,
        set: {
          projectId: 'demo-morrow',
          thinkingThreadId: scopedId(orgId, threadIds.morrowThinking),
          buildingThreadId: scopedId(orgId, threadIds.morrow),
          title: 'Use the studio timezone when the customer has none',
          decision: 'Use the studio timezone when customer timezone is absent; never guess UTC.',
          why: 'The studio owns the booking calendar and staffs the local time shown to the customer.',
          constraints: ['Keep a customer-supplied timezone unchanged.', 'Do not alter existing bookings.', 'Add a regression test before shipping.'],
          openQuestions: ['Should the confirmation screen say which timezone it is showing?'],
          evidenceThrough: ago(now, 4, 'day'),
          evidenceMessages: 2,
          extractedAt: ago(now, 3, 'day'),
          editedAt: ago(now, 3, 'day'),
          editedByHuman: true,
        },
      });

    const sessions = [
      {
        id: scopedId(orgId, 'demo-session-parcel-codex'),
        orgId,
        projectId: 'demo-parcel',
        agent: 'codex',
        sessionId: 'northstar-parcel-delivery-layout',
        repo: null,
        cwd: null,
        intent: 'Make delivery updates easier to scan',
        filesTouched: ['app/components/DeliveryTimeline.tsx', 'app/styles/delivery.css'],
        toolsRun: { read: 4, edit: 2, test: 1 },
        outcome: 'shipped',
        commitSha: '8fd42b19bc7a',
        costUsd: 0.18,
        detail: null,
        startedAt: ago(now, 5, 'hour'),
        endedAt: ago(now, 3, 'hour'),
        createdAt: ago(now, 3, 'hour'),
      },
      {
        id: scopedId(orgId, 'demo-session-juniper-claude'),
        orgId,
        projectId: 'demo-juniper',
        agent: 'claude-code',
        sessionId: 'northstar-juniper-autumn-page',
        repo: null,
        cwd: null,
        intent: 'Refresh the autumn collection page',
        filesTouched: ['app/collections/[slug]/page.tsx', 'app/styles/collection.css'],
        toolsRun: { read: 3, edit: 2, test: 2 },
        outcome: 'shipped',
        commitSha: 'ce914ab7461d',
        costUsd: 0.21,
        detail: null,
        startedAt: ago(now, 27, 'hour'),
        endedAt: ago(now, 24, 'hour'),
        createdAt: ago(now, 24, 'hour'),
      },
    ];
    for (const row of sessions) {
      await tx.insert(externalSessions).values(row).onConflictDoUpdate({
        target: [externalSessions.orgId, externalSessions.agent, externalSessions.sessionId],
        set: {
          projectId: row.projectId,
          repo: row.repo,
          cwd: row.cwd,
          intent: row.intent,
          filesTouched: row.filesTouched,
          toolsRun: row.toolsRun,
          outcome: row.outcome,
          commitSha: row.commitSha,
          costUsd: row.costUsd,
          detail: row.detail,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          createdAt: row.createdAt,
        },
      });
    }
  });

  // A postcondition catches a partial-looking seed even if the database driver
  // ever changes transaction behavior. It is deliberately scoped to the five
  // exact project IDs, not to all rows in the account.
  const visible = await db
    .select({ projectId: packs.projectId })
    .from(packs)
    .where(and(eq(packs.orgId, orgId), inArray(packs.projectId, [...DEMO_PROJECT_IDS])));
  if (visible.length !== DEMO_PROJECT_IDS.length) throw new Error(`Demo seed incomplete: expected 5 projects, found ${visible.length}.`);

  return {
    workspace: DEMO_WORKSPACE,
    projects: demoPacks.length,
    threads: seededThreads.length,
    messages: seededMessages.length,
    openFixes: seededCards.filter((card) => card.state === 'proposed').length,
  };
}
