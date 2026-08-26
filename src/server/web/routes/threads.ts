import { Router, type Request } from 'express';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { agentMessages, agentMessageAttachments, agentRuns, llmUsage, orgs, projectBuild, threads } from '../../db/schema/index.js';
import { getPack, listPacks, mutedProjectIds } from '../../packs/store.js';
import { edgeStatus, hasHealthSignal, healthLine } from '../../packs/healthLine.js';
import { getBuild } from '../../build/store.js';
import { configFor, engineEnv, type EngineEnv } from '../../build/engineConfig.js';
import { lookupRepoInfo, type LookupRepoInfo } from '../../build/repoInfo.js';
import { validateFileRefs, validateImages } from '../attachments.js';
import { consumeStagedUpload } from '../../build/uploads.js';
import type { AgentTurnConfig, AttachedFile } from '../../build/agent.js';
import { promises as fsp } from 'node:fs';
import { runAgentTurn } from '../../build/agent.js';
import { failActiveRun, stopActiveRun } from '../../build/stopRun.js';
import { runChatTurn, chatProviderFor } from '../../chat/turn.js';
import { publishLiveChat, subscribeLiveChat } from '../../chat/live.js';
import { resolveFuelFor } from '../../connectors/fuel/resolve.js';
import {
  createSubjectThread,
  createThread,
  ensureWorkshopThread,
  fileThread,
  getThread,
  isDefaultTitle,
  listThreads,
  renameThread,
  setThreadArchived,
  titleFromFirstMessage,
} from '../../threads/store.js';
import { getSubject, listSubjects } from '../../threads/subjects.js';
import { setPlacePutAway } from '../../threads/putAway.js';
import { getHandoffReceipt, listThreadHandoffReceipts, markHandoffSpent, pendingHandoff, switchThreadAgent } from '../../threads/switch.js';
import { agentRoster } from '../../threads/roster.js';
import { raiseCeiling, threadCeiling } from '../../threads/ceiling.js';
import { briefAsText, briefForThread, withFreshness } from '../../decisions/store.js';
import { staleWarningFor } from '../../decisions/freshness.js';
import { agentById, changesFiles, isAgentId, type AgentId } from '../../../shared/agents.js';
import type { TaskContextCapsule } from '../../../shared/types/contextCapsule.js';
import { consultationLine, mentionIntent, MAX_CONSULTED } from '../../../shared/mentions.js';
import { referenceLine, type SearchScope } from '../../../shared/references.js';
import { boundDocuments } from '../../../shared/documents.js';
import { conversationReferenceById, findRelatedConversations, listReferenceCandidates, renderReferences, resolveReferences } from '../../references/resolve.js';
import { boundContextThreadIds, boundContinuationSources } from '../../continuations/store.js';
import { consoleLinks } from '../../connectors/consoles.js';
import { isThreadKind, DEFAULT_GENERAL_TITLE, DEFAULT_WORKSHOP_TITLE, type ThreadKind } from '../../../shared/types/thread.js';
import { canStartBuild } from '../../billing/entitlements.js';
import { createProject } from '../../packs/create.js';
import type { StakesTier } from '../../../shared/types/pack.js';
import { refuse } from '../middleware/limit.js';
import { isTechnicalDetail } from '../../../shared/technicalDetail.js';
import { canResolveCheckout, inspectCheckout } from '../../build/checkoutGuard.js';
import { recordProductEvent, type ProductSurface } from '../../telemetry/productEvents.js';
import { cardEvidenceSheet, runEvidenceSheet, summarizeRunEvidence } from '../../build/evidenceSheet.js';
import { defaultChatModelFor, modelBelongsToAgent } from '../../llm/chatModels.js';
import { visualById, visualsForThread } from '../../visuals/store.js';
import { visualObjectStore, type VisualObjectStore } from '../../visuals/storage.js';
import { imageApiKeyFor } from '../../visuals/credentials.js';
import { OpenAIVisualRenderer, runVisualJob } from '../../visuals/render.js';
import { wantsVisual } from '../../../shared/visualIntent.js';
import { cancelVisualJobs } from '../../visuals/live.js';
import { executionModeFor, type ExecutionMode } from '../../../shared/executionIntent.js';
import { consultationStatuses } from '../../consultations/status.js';
import { compileTaskContext, type CompileContextInput } from '../../context/compiler.js';
import { deleteSandbox, inspectSandboxWorktree, isSandboxCapacityError, type SandboxExecutionSnapshot } from '../../build/sandbox.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

function surfaceOf(req: Request): ProductSurface {
  const value = req.header('x-selvedge-surface');
  return value === 'desktop_web' || value === 'responsive_web' || value === 'ios_native' ? value : 'unknown';
}

/**
 * THE INBOX'S SURFACE — the rail, a thread, and the two things you do to a
 * thread: talk in it, and change who is answering.
 *
 * It sits beside the workshop router rather than replacing it. Everything
 * PROJECT-scoped — ship, undo, preview, put-it-online, stop the sandbox,
 * attachments — stays there, because those are facts about a project and not
 * about a conversation. What lives here is what belongs to a thread.
 *
 * Turns run in the background (202) and the page polls, exactly as the workshop
 * has always worked: a build turn takes minutes, and the honest way to show
 * that is the work itself arriving on the thread, not a spinner.
 */

/**
 * How many of a place's OWN conversations a question asked inside it may
 * bring — a project's or a subject's alike. More than the account-wide
 * default, because the owner narrowed the search themselves by choosing where
 * to ask, and still bounded, because an answer built from thirty half-matches
 * is worse than one built from six good ones.
 */
const MAX_IN_HOME_THREAD = 6;

/** A run this old still marked running is a crashed process, not real work. */
const STUCK_RUN_MS = 45 * 60 * 1000;

export type ThreadsDeps = {
  runTurn?: typeof runAgentTurn;
  chatTurn?: typeof runChatTurn;
  env?: () => EngineEnv | null;
  /** How the repo's default branch is looked up; injected for tests. */
  lookup?: LookupRepoInfo;
  /**
   * Make a fresh private repo for an idea that turned into a thing. Absent
   * when the deployment has no GITHUB_TOKEN — in which case "start a new one"
   * is not offered at all rather than offered and then refused.
   */
  createRepo?: (name: string, description: string) => Promise<{ fullName: string }>;
  checkoutGuardEnabled?: boolean;
  visualStore?: VisualObjectStore | null;
  /** The single server-side compilation seam; injected so route tests can freeze it. */
  compileContext?: (db: Db, input: CompileContextInput) => ReturnType<typeof compileTaskContext>;
  captureExecutionState?: (db: Db, orgId: string, projectId: string) => Promise<SandboxExecutionSnapshot | null>;
};

export function createThreadsRouter(db: Db, deps: ThreadsDeps = {}) {
  const router = Router();
  const runTurn = deps.runTurn ?? runAgentTurn;
  const chatTurn = deps.chatTurn ?? runChatTurn;
  const env = deps.env ?? engineEnv;
  const lookup = deps.lookup ?? lookupRepoInfo;
  // WIRED BY THE APP, never reached for here — the same way the packs router
  // gets it. A router that reaches into process.env for a capability is a
  // router that behaves differently in a test than in production, and this one
  // decides whether to offer somebody a real repo.
  const makeRepo = deps.createRepo;
  const checkoutGuardEnabled = deps.checkoutGuardEnabled ?? false;
  const visualStore = deps.visualStore === undefined ? visualObjectStore() : deps.visualStore;
  const compileContext = deps.compileContext ?? compileTaskContext;
  const captureExecutionState = deps.captureExecutionState ?? (process.env.NODE_ENV === 'test' ? async () => null : inspectSandboxWorktree);

  router.post(
    '/api/projects/:projectId/checkout/preflight',
    asyncHandler(async (req, res) => {
      if (!checkoutGuardEnabled) {
        res.status(404).json({ error: "There's nothing at that address." });
        return;
      }
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      if (!(await getPack(db, orgId, projectId))) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const body = (req.body ?? {}) as { thread_id?: unknown; goal?: unknown; expected_files?: unknown };
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
      if (!goal) {
        res.status(400).json({ error: 'say what you want to change' });
        return;
      }
      const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
      if (threadId) {
        const thread = await getThread(db, orgId, threadId);
        if (!thread || thread.projectId !== projectId) {
          res.status(404).json({ error: 'no such project conversation' });
          return;
        }
      }
      const expectedFiles = Array.isArray(body.expected_files) ? body.expected_files.filter((p): p is string => typeof p === 'string') : [];
      const guard = await inspectCheckout(db, orgId, projectId, { threadId, goal, expectedFiles });
      await recordProductEvent(db, orgId, 'checkout_preflight', { surface: surfaceOf(req), projectId, threadId, properties: { state: guard.state, safe_to_start: guard.safe_to_start } });
      res.json(guard);
    }),
  );

  router.get(
    '/api/projects/:projectId/runs/:runId/evidence',
    asyncHandler(async (req, res) => {
      if (!checkoutGuardEnabled) { res.status(404).json({ error: "There's nothing at that address." }); return; }
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      if (!(await getPack(db, orgId, projectId))) { res.status(404).json({ error: 'no such project' }); return; }
      const sheet = await runEvidenceSheet(db, orgId, projectId, req.params.runId ?? '');
      if (!sheet) { res.status(404).json({ error: 'no such run evidence' }); return; }
      await recordProductEvent(db, orgId, 'evidence_sheet_viewed', { surface: surfaceOf(req), projectId, threadId: sheet.source.thread_id, properties: { source_kind: 'run', outcome: sheet.outcome } });
      res.json(sheet);
    }),
  );

  router.get(
    '/api/projects/:projectId/cards/:cardId/evidence',
    asyncHandler(async (req, res) => {
      if (!checkoutGuardEnabled) { res.status(404).json({ error: "There's nothing at that address." }); return; }
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      if (!(await getPack(db, orgId, projectId))) { res.status(404).json({ error: 'no such project' }); return; }
      const sheet = await cardEvidenceSheet(db, orgId, projectId, req.params.cardId ?? '');
      if (!sheet) { res.status(404).json({ error: 'no such card evidence' }); return; }
      await recordProductEvent(db, orgId, 'evidence_sheet_viewed', { surface: surfaceOf(req), projectId, properties: { source_kind: 'card', outcome: sheet.outcome } });
      res.json(sheet);
    }),
  );

  async function activeRun(orgId: string, projectId: string) {
    const cutoff = new Date(Date.now() - STUCK_RUN_MS);
    const [row] = await db
      .select({ id: agentRuns.id, threadId: agentRuns.threadId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          eq(agentRuns.status, 'running'),
          gte(agentRuns.startedAt, cutoff),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The rail: every project with its edge, every thread under it, and the brief
   * pinned at the top. One request, because the rail is one glance — and a rail
   * that arrives in pieces is a rail that flickers.
   */
  router.get(
    '/api/inbox',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      // PUT-AWAY PLACES COME BACK IN THE PAYLOAD, FLAGGED.
      //
      // They are folded out of the rail, not withheld from it: the rail says
      // how many are away and opens them on one tap, with their health lines
      // intact. Fetching them only on demand would cost a second round trip to
      // show a list the owner already has in their hand — and would make the
      // count a separate query that could disagree with the list it counts.
      const [packs, subjectRows, threadRows, awayProjects] = await Promise.all([
        listPacks(db, orgId),
        listSubjects(db, orgId, { includeArchived: true }),
        db.select().from(threads).where(eq(threads.orgId, orgId)),
        mutedProjectIds(db, orgId),
      ]);

      // Last activity per thread, for "most-recent-first" — one grouped query
      // rather than one per thread.
      const lastRows = await db
        .select({ threadId: agentMessages.threadId, at: sql<string>`max(${agentMessages.createdAt})` })
        .from(agentMessages)
        .where(eq(agentMessages.orgId, orgId))
        .groupBy(agentMessages.threadId);
      const lastByThread = new Map(lastRows.map((r) => [r.threadId ?? '', r.at]));

      const running = await db
        .select({ threadId: agentRuns.threadId })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, 'running'), gte(agentRuns.startedAt, new Date(Date.now() - STUCK_RUN_MS))));
      const workingThreads = new Set(running.map((r) => r.threadId).filter(Boolean));

      const byProject = new Map<string, typeof threadRows>();
      const bySubject = new Map<string, typeof threadRows>();
      for (const t of threadRows) {
        if (t.archivedAt) continue;
        const bucket = t.projectId ? byProject : t.subjectId ? bySubject : null;
        const key = t.projectId ?? t.subjectId;
        if (!bucket || !key) continue; // filed nowhere: not a thing the rail can show
        bucket.set(key, [...(bucket.get(key) ?? []), t]);
      }

      const projects = packs.map((pack) => {
        const id = pack.identity.project_id;
        const threads = (byProject.get(id) ?? [])
          .map((t) => ({
            id: t.id,
            kind: t.kind,
            title: t.title,
            agent: t.agent,
            chip: agentById(t.agent)?.chip ?? t.agent.slice(0, 2).toUpperCase(),
            working: workingThreads.has(t.id),
            last_at: lastByThread.get(t.id) ?? t.createdAt.toISOString(),
          }))
          .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
        return {
          id,
          name: pack.identity.name,
          // Null where nothing has ever reported: no edge, no line, just the
          // name. An absence is not a blind spot, and dressing it as one made
          // every row in the rail apologise at once.
          status: hasHealthSignal(pack) ? edgeStatus(pack) : null,
          health: hasHealthSignal(pack) ? healthLine(pack) : null,
          threads,
          put_away: awayProjects.has(id),
        };
      });

      // The rail no longer carries a brief line (the brief is retired) or an
      // unsorted count (filing is settings work, not something to put beside
      // the work). Neither is looked up here any more — a payload nobody reads
      // is still a query somebody pays for.

      // Subjects come back in the same payload and are merged into one list
      // client-side: a subject is a project without a repo, and the owner
      // should not have to know which they are in before starting a
      // conversation. They carry no status, because there is nothing about a
      // subject to be right or wrong about.
      const subjectList = subjectRows.map((subject) => ({
        id: subject.id,
        name: subject.name,
        // A subject is put away by the column that already meant exactly that
        // — its own router calls archiving "put it away".
        put_away: subject.archivedAt !== null,
        threads: (bySubject.get(subject.id) ?? [])
          .map((t) => ({
            id: t.id,
            kind: t.kind,
            title: t.title,
            agent: t.agent,
            chip: agentById(t.agent)?.chip ?? t.agent.slice(0, 2).toUpperCase(),
            working: workingThreads.has(t.id),
            last_at: lastByThread.get(t.id) ?? t.createdAt.toISOString(),
          }))
          .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at))),
      }));

      res.json({
        projects,
        subjects: subjectList,
        engine_on: env() !== null,
      });
    }),
  );

  /**
   * PUT A PLACE AWAY, OR BRING IT BACK.
   *
   * One route for either kind of place, because the rail is one list and the
   * owner should not have to know whether a row has a repo behind it before
   * they can fold it away. See threads/putAway.ts for the resolution, and
   * shared/putAway.ts for what the gesture does and deliberately does not do.
   */
  router.patch(
    '/api/inbox/places/:id',
    asyncHandler(async (req, res) => {
      const away = (req.body ?? {}).put_away;
      if (typeof away !== 'boolean') {
        res.status(400).json({ error: 'put_away (boolean) is required' });
        return;
      }
      const result = await setPlacePutAway(db, orgIdOf(req), req.params.id ?? '', away);
      if (!result.ok) {
        res.status(404).json({ error: 'no such place' });
        return;
      }
      res.json({ ok: true, put_away: away, kind: result.kind });
    }),
  );

  /**
   * THE ROSTER — who could answer this conversation, and what handing it to
   * each of them would cost, quoted before anything is handed over.
   *
   * This is what turns the picker from a menu into a decision: every name
   * carries a price tag from the same code that will do the charging, and
   * anyone who can't run today says why rather than going missing.
   */
  router.get(
    '/api/threads/:threadId/agents',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      res.json({ answering: thread.agent, agents: await agentRoster(db, orgId, thread, env) });
    }),
  );

  /**
   * A LIGHTWEIGHT WAKE-UP STREAM. The thread remains the canonical response;
   * this channel only says "it changed" so web and native clients can fetch
   * the same tested representation immediately instead of guessing with a
   * timer. Heartbeats keep proxies from treating a quiet conversation as a
   * dead connection, and every client retains its polling fallback.
   */
  router.get(
    '/api/threads/:threadId/events',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      let closed = false;
      let checking = false;
      let previous = '';
      const unsubscribe = subscribeLiveChat(orgId, thread.id, (event) => {
        if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const check = async () => {
        if (closed || checking) return;
        checking = true;
        try {
          const [latest] = await db
            .select({ id: agentMessages.id, role: agentMessages.role, content: agentMessages.content, meta: agentMessages.meta })
            .from(agentMessages)
            .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
            .orderBy(desc(agentMessages.createdAt))
            .limit(1);
          const running = thread.projectId ? await activeRun(orgId, thread.projectId) : null;
          const signature = JSON.stringify([latest?.id ?? null, latest?.role ?? null, latest?.content ?? null, latest?.meta ?? null, running?.id ?? null]);
          if (signature !== previous) {
            previous = signature;
            res.write(`data: ${JSON.stringify({ changed: true })}\n\n`);
          }
        } finally {
          checking = false;
        }
      };

      await check();
      const changes = setInterval(() => void check(), 750);
      const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15_000);
      req.on('close', () => {
        closed = true;
        unsubscribe();
        clearInterval(changes);
        clearInterval(heartbeat);
      });
    }),
  );

  /** Everything one thread needs to be read and worked in. */
  router.get(
    '/api/visuals/:visualId/content',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const visual = await visualById(db, orgId, req.params.visualId ?? '');
      if (!visual || visual.status !== 'ready' || !visual.storageKey) {
        res.status(404).json({ error: 'no such visual' });
        return;
      }
      if (!visualStore) {
        res.status(503).json({ error: 'visual storage is not configured' });
        return;
      }
      res.redirect(302, await visualStore.signedGet(visual.storageKey));
    }),
  );

  router.get(
    '/api/threads/:threadId',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const [pack, build, messages, runs, running, orgRows, visuals] = await Promise.all([
        thread.projectId ? getPack(db, orgId, thread.projectId) : null,
        thread.projectId ? getBuild(db, orgId, thread.projectId) : null,
        db
          .select()
          .from(agentMessages)
          .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
          .orderBy(agentMessages.createdAt),
        db
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.threadId, thread.id)))
          .orderBy(desc(agentRuns.createdAt))
          .limit(20),
        thread.projectId ? activeRun(orgId, thread.projectId) : null,
        db.select({ technicalDetail: orgs.technicalDetail }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1),
        visualsForThread(db, orgId, thread.id),
      ]);
      const subjectName = thread.subjectId ? (await getSubject(db, orgId, thread.subjectId))?.name ?? null : null;
      const accountDetail = isTechnicalDetail(orgRows[0]?.technicalDetail) ? orgRows[0].technicalDetail : 'full';
      const threadDetail = isTechnicalDetail(thread.technicalDetail) ? thread.technicalDetail : null;

      // What this CONVERSATION has cost: sandbox turns in cents, model calls in
      // dollars. The two ledgers stay separate (they measure different things)
      // and are added only here, for display, where the label says what it is.
      let threadCents = 0;
      try {
        const [runCost] = await db
          .select({ cents: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)` })
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.threadId, thread.id)));
        const [chatCost] = await db
          .select({ usd: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
          .from(llmUsage)
          .where(and(eq(llmUsage.orgId, orgId), eq(llmUsage.threadId, thread.id)));
        threadCents = Number(runCost?.cents ?? 0) + Math.round(Number(chatCost?.usd ?? 0) * 100);
      } catch (err) {
        console.error(`thread cost failed for ${orgId}/${thread.id}:`, err);
      }

      const attByMessage = new Map<string, Array<{ id: string; mime: string }>>();
      const messageIds = messages.map((m) => m.id);
      if (messageIds.length) {
        try {
          const atts = await db
            .select({ id: agentMessageAttachments.id, mime: agentMessageAttachments.mime, agentMessageId: agentMessageAttachments.agentMessageId })
            .from(agentMessageAttachments)
            .where(and(eq(agentMessageAttachments.orgId, orgId), inArray(agentMessageAttachments.agentMessageId, messageIds)));
          for (const a of atts) {
            const list = attByMessage.get(a.agentMessageId) ?? [];
            list.push({ id: a.id, mime: a.mime });
            attByMessage.set(a.agentMessageId, list);
          }
        } catch (err) {
          console.error(`thread attachment lookup failed for ${orgId}/${thread.id}:`, err);
        }
      }

      const pending = await pendingHandoff(db, orgId, thread.id).catch(() => null);
      const recordByRun = new Map(messages.filter((m) => m.role === 'activity' && m.runId).map((m) => [m.runId!, m.meta as import('../../../shared/types/toolEvent.js').RunRecord | null]));

      res.json({
        thread: {
          id: thread.id,
          kind: thread.kind,
          title: thread.title,
          agent: thread.agent,
          model: thread.model,
          created_at: thread.createdAt.toISOString(),
          archived: thread.archivedAt !== null,
        },
        // A thread belongs to a project or to a subject; the pane says which.
        project: thread.projectId ? { id: thread.projectId, name: pack?.identity.name ?? thread.projectId } : null,
        subject: thread.subjectId ? { id: thread.subjectId, name: subjectName ?? thread.subjectId } : null,
        live_url: pack?.identity.links?.live_url ?? null,
        // The accounts behind this project, as one-click doors. Computed
        // server-side so both clients render the same strings — see
        // connectors/consoles.ts.
        console_links: pack ? consoleLinks(pack) : [],
        engine_on: env() !== null,
        working: running !== null,
        staged_changes_ready: build?.stagedChangesReady ?? false,
        // A cold sandbox means the first message of a workshop thread waits
        // while it wakes. The composer says so rather than pretending.
        sandbox: build?.sandboxId ? 'attached' : 'none',
        handoff_waiting: pending !== null,
        cost_cents: threadCents,
        // Presentation only: the full record remains attached to the message
        // in both modes. Null means this conversation follows the account.
        technical_detail: threadDetail,
        effective_technical_detail: threadDetail ?? accountDetail,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          at: m.createdAt.toISOString(),
          attachments: attByMessage.get(m.id) ?? [],
          run_id: m.runId,
          // WHO SAID IT. A consultation asks several agents the same question
          // and each answer records its author — which was worth nothing while
          // it stayed in the database. Two paragraphs both labelled "Selvedge"
          // is precisely the thing asking two agents was meant to avoid.
          // NAME AND SIZE, NOT THE TEXT. A thread is polled every few seconds;
          // re-sending a hundred kilobytes of pasted document each time would
          // make a conversation that carries one permanently expensive to
          // watch. The text is one request away, when somebody opens it.
          ...(m.role === 'owner' && Array.isArray((m.meta as { documents?: unknown } | null)?.documents)
            ? {
                documents: ((m.meta as { documents: Array<{ name: string; text: string }> }).documents ?? []).map((d, index) => ({
                  index,
                  name: d.name,
                  chars: d.text.length,
                })),
              }
            : {}),
          ...(m.role === 'agent' && (m.meta as { answered_by?: unknown } | null)?.answered_by
            ? { answered_by: (m.meta as { answered_by: string }).answered_by }
            : {}),
          ...(m.role === 'agent' && (m.meta as { consultation_lane?: unknown } | null)?.consultation_lane
            ? { consultation_lane: (m.meta as { consultation_lane: unknown }).consultation_lane }
            : {}),
          // A consultation is parallel, so chronology cannot prove which
          // answer belongs to which prompt. These JSONB correlations do. They
          // are exposed on every correlated row while the full marker record
          // remains below in `meta`.
          ...(typeof (m.meta as { consultation_id?: unknown } | null)?.consultation_id === 'string'
            ? { consultation_id: (m.meta as { consultation_id: string }).consultation_id }
            : {}),
          ...(typeof (m.meta as { in_reply_to?: unknown } | null)?.in_reply_to === 'string'
            ? { in_reply_to: (m.meta as { in_reply_to: string }).in_reply_to }
            : {}),
          ...(m.role === 'activity' || m.role === 'switch' ? { meta: m.meta } : {}),
        })),
        consultations: consultationStatuses(messages),
        visuals: visuals.map((visual) => ({
          id: visual.id,
          message_id: visual.messageId,
          consultation_id: visual.consultationId,
          directing_agent: visual.directingAgent,
          rendering_provider: visual.renderingProvider,
          rendering_model: visual.renderingModel,
          status: visual.status,
          mime: visual.mime,
          width: visual.width,
          height: visual.height,
          bytes: visual.bytes,
          direction_ms: visual.directionMs,
          render_ms: visual.renderMs,
          storage_ms: visual.storageMs,
          error: visual.error,
          parent_id: visual.parentId,
          ...(visual.status === 'ready' ? { content_url: `/api/visuals/${encodeURIComponent(visual.id)}/content` } : {}),
        })),
        runs: runs.map((r) => ({
          id: r.id,
          status: r.status,
          cost_cents: r.costCents,
          commit: r.commitSha,
          kind: r.prompt.startsWith('ship:') ? 'ship' : r.prompt.startsWith('undo:') ? 'undo' : r.prompt.startsWith('plan:') ? 'plan' : 'turn',
          at: r.createdAt.toISOString(),
          agent: r.agent,
          model: r.model,
          changed_paths: (r.changedPaths as string[] | null) ?? null,
          ...(checkoutGuardEnabled && r.prompt.startsWith('ship:') === false && r.prompt.startsWith('undo:') === false
            ? { evidence: { ...summarizeRunEvidence(r, recordByRun.get(r.id) ?? null), path: `/api/projects/${encodeURIComponent(r.projectId)}/runs/${encodeURIComponent(r.id)}/evidence` } }
            : {}),
        })),
      });
    }),
  );

  /**
   * Let one conversation temporarily depart from the account register. Null
   * means "follow my account" again; it never deletes or rewrites run data.
   */
  router.patch(
    '/api/threads/:threadId/technical-detail',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const threadId = req.params.threadId ?? '';
      const requested = (req.body as { technical_detail?: unknown } | undefined)?.technical_detail;
      if (requested !== null && !isTechnicalDetail(requested)) {
        res.status(400).json({ error: "technical_detail must be 'full', 'simple', or null" });
        return;
      }
      const thread = await getThread(db, orgId, threadId);
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      await db
        .update(threads)
        .set({ technicalDetail: requested })
        .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)));
      const [orgRow] = await db
        .select({ technicalDetail: orgs.technicalDetail })
        .from(orgs)
        .where(eq(orgs.orgId, orgId))
        .limit(1);
      const accountDetail = isTechnicalDetail(orgRow?.technicalDetail) ? orgRow.technicalDetail : 'full';
      res.json({
        technical_detail: requested,
        effective_technical_detail: requested ?? accountDetail,
      });
    }),
  );

  /** Start a new conversation on a project. One tap: kind, agent, type. */
  router.post(
    '/api/projects/:projectId/threads',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const body = (req.body ?? {}) as { kind?: unknown; agent?: unknown; title?: unknown };
      const kind: ThreadKind = isThreadKind(body.kind) ? body.kind : 'workshop';
      const agent = typeof body.agent === 'string' ? body.agent : undefined;
      if (agent !== undefined) {
        const descriptor = agentById(agent);
        if (!descriptor) {
          res.status(400).json({ error: "I don't know that agent." });
          return;
        }
      }
      const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 120) : kind === 'workshop' ? DEFAULT_WORKSHOP_TITLE : DEFAULT_GENERAL_TITLE;
      const thread = await createThread(db, orgId, projectId, { kind, title, ...(agent ? { agent: agent as AgentId } : {}) });
      res.status(201).json({ thread: { id: thread.id, kind: thread.kind, title: thread.title, agent: thread.agent } });
    }),
  );

  /** Start a conversation under a subject — no project, no sandbox, nothing to ship. */
  router.post(
    '/api/subjects/:subjectId/threads',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const subject = await getSubject(db, orgId, req.params.subjectId ?? '');
      if (!subject) {
        res.status(404).json({ error: 'no such subject' });
        return;
      }
      const body = (req.body ?? {}) as { title?: unknown; agent?: unknown };
      const agent = typeof body.agent === 'string' ? body.agent : undefined;
      if (agent !== undefined) {
        if (!agentById(agent)) {
          res.status(400).json({ error: "I don't know that agent." });
          return;
        }
      }
      const thread = await createSubjectThread(db, orgId, subject.id, {
        ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim().slice(0, 120) } : {}),
        ...(agent ? { agent: agent as AgentId } : {}),
      });
      res.status(201).json({ thread: { id: thread.id, kind: thread.kind, title: thread.title, agent: thread.agent } });
    }),
  );

  /**
   * THE MOVE, REACHABLE ON PURPOSE. The join-or-create choices used to exist
   * only inside the needs-project refusal — you could reach them by naming a
   * builder and being told no, and no other way. Somebody who already knows
   * they want a conversation in the workshop shouldn't have to trip the wall
   * to find the door. Same shape as the 409 carries, served on request.
   */
  router.get(
    '/api/threads/:threadId/build/options',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such conversation' });
        return;
      }
      if (thread.projectId) {
        res.json({ has_project: true, projects: [], can_create: false });
        return;
      }
      const packs = await listPacks(db, orgId);
      res.json({
        has_project: false,
        projects: packs.map((p) => ({ id: p.identity.project_id, name: p.identity.name })),
        can_create: Boolean(makeRepo),
      });
    }),
  );

  /** Rename, archive, or change who is answering. */
  router.patch(
    '/api/threads/:threadId',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const threadId = req.params.threadId ?? '';
      const body = (req.body ?? {}) as { title?: unknown; archived?: unknown; agent?: unknown; model?: unknown };

      if (typeof body.title === 'string') {
        if (!(await renameThread(db, orgId, threadId, body.title))) {
          res.status(400).json({ error: 'a thread needs a name' });
          return;
        }
      }
      if (typeof body.archived === 'boolean') {
        if (!(await setThreadArchived(db, orgId, threadId, body.archived))) {
          res.status(404).json({ error: 'no such thread' });
          return;
        }
      }
      if (typeof body.agent === 'string') {
        const out = await switchThreadAgent(db, orgId, threadId, body.agent);
        if (!out.ok) {
          res.status(out.reason === 'no_such_thread' ? 404 : 400).json({ error: out.message });
          return;
        }
        res.json({
          thread: { id: out.thread.id, kind: out.thread.kind, title: out.thread.title, agent: out.thread.agent, model: out.thread.model },
          switched: out.changed,
          line: out.line,
          handoff_tokens: out.handoff?.estimated_tokens ?? 0,
          receipt: out.receipt,
        });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'model')) {
        const current = await getThread(db, orgId, threadId);
        if (!current) {
          res.status(404).json({ error: 'no such thread' });
          return;
        }
        if (body.model !== null && (typeof body.model !== 'string' || !modelBelongsToAgent(current.agent as AgentId, body.model))) {
          res.status(400).json({ error: 'That model is not available for this agent.' });
          return;
        }
        await db.update(threads).set({ model: body.model as string | null }).where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)));
      }

      const thread = await getThread(db, orgId, threadId);
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      res.json({ thread: { id: thread.id, kind: thread.kind, title: thread.title, agent: thread.agent, archived: thread.archivedAt !== null } });
    }),
  );

  router.get(
    '/api/threads/:threadId/handoffs',
    asyncHandler(async (req, res) => {
      const receipts = await listThreadHandoffReceipts(db, orgIdOf(req), req.params.threadId ?? '');
      if (!receipts) { res.status(404).json({ error: 'no such thread' }); return; }
      res.json({ thread_id: req.params.threadId, receipts });
    }),
  );

  router.get(
    '/api/threads/:threadId/handoffs/:receiptId',
    asyncHandler(async (req, res) => {
      const receipt = await getHandoffReceipt(db, orgIdOf(req), req.params.threadId ?? '', req.params.receiptId ?? '');
      if (!receipt) { res.status(404).json({ error: 'no such handoff receipt' }); return; }
      res.json({ receipt });
    }),
  );

  /**
   * AN IDEA BECOMES A THING.
   *
   * The exit from a plain chat, and the reason to have had the idea here
   * rather than in a browser tab: the conversation does not restart, it MOVES.
   * Same thread id, same history — the argument about scraping versus asking,
   * the thing GPT said, what you decided — all of it becomes the project's
   * first thread, and the next turn is a build turn in the same place.
   *
   * Two ways in, and they end identically:
   *   { project_id } — join a project that exists.
   *   { create: { name, tier } } — make one, repo and all, then join it.
   *
   * THE CREATE BRANCH IS THE DANGEROUS ONE and it is deliberately explicit.
   * `create` carries a NAME the caller had to have been shown, because minting
   * a real repo on somebody's GitHub is irreversible and outward-facing, and
   * arriving at it by @-mentioning a builder mid-sentence is exactly how that
   * happens by accident. The client asks first; this endpoint is the answer to
   * the question, not the question.
   *
   * Everything about ordering — the plan gate before the repo, the repo before
   * the pack — lives in packs/create.ts, shared with the New Project form, so
   * the second door cannot drift from the first.
   */
  router.post(
    '/api/threads/:threadId/build',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const threadId = req.params.threadId ?? '';
      const body = (req.body ?? {}) as { project_id?: unknown; create?: unknown };

      const thread = await getThread(db, orgId, threadId);
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      // Already somewhere. Not an error — the conversation is where it needs to
      // be, and saying so beats moving it twice.
      if (thread.projectId) {
        res.json({ thread: { id: threadId, project_id: thread.projectId }, moved: false });
        return;
      }

      const projectId = typeof body.project_id === 'string' && body.project_id !== '' ? body.project_id : null;
      const create = body.create && typeof body.create === 'object' ? (body.create as { name?: unknown; tier?: unknown }) : null;
      if ((projectId === null) === (create === null)) {
        res.status(400).json({ error: 'Name a project for it, or the new one to make — one or the other.' });
        return;
      }

      let joined: string;
      if (projectId) {
        if (!(await getPack(db, orgId, projectId))) {
          res.status(404).json({ error: 'no such project' });
          return;
        }
        joined = projectId;
      } else {
        const name = typeof create!.name === 'string' ? create!.name.trim() : '';
        if (!name) {
          res.status(400).json({ error: 'A new project needs a name — it becomes the repo.' });
          return;
        }
        if (!makeRepo) {
          res.status(503).json({
            error: "This deployment can't create repos, so I can't start a project from nothing here. Point this conversation at a project you already have.",
          });
          return;
        }
        // Sandbox unless told otherwise: an idea that just became a project has
        // nothing in production, and claiming a higher tier would turn on
        // watching that has nothing true to say yet.
        const tier: StakesTier = create!.tier === 'personal' || create!.tier === 'live_small' || create!.tier === 'live_critical' ? create!.tier : 'sandbox';
        const made = await createProject(db, orgId, { name, repo: null, tier }, { createRepo: makeRepo });
        if (!made.ok) {
          if (made.kind === 'limit') {
            refuse(res, made.allowance);
            return;
          }
          res.status(made.status).json({ error: made.error });
          return;
        }
        joined = made.pack.identity.project_id;
      }

      // THE MOVE. Same id, same messages, same dates — only the filing changes.
      const moved = await fileThread(db, orgId, threadId, { projectId: joined });
      if (!moved) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      res.status(201).json({
        thread: { id: threadId, project_id: joined },
        moved: true,
        created_project: projectId ? null : joined,
      });
    }),
  );

  /**
   * PUT A CONVERSATION SOMEWHERE — the move the product did not have.
   *
   * Deliberately its own route rather than a field on the PATCH above. Filing
   * is the one thread edit that changes which list a conversation appears in,
   * and it is the one an import needs in bulk; a rename that quietly also moved
   * something would be a bad afternoon for anybody.
   *
   * Both destinations are checked against this org before anything moves. A
   * conversation is only ever in one place, so naming a project clears the
   * subject and naming a subject clears the project — never both, and never
   * neither, because a thread filed nowhere shows up in no list at all.
   */
  router.post(
    '/api/threads/:threadId/file',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const threadId = req.params.threadId ?? '';
      const body = (req.body ?? {}) as { project_id?: unknown; subject_id?: unknown };
      const projectId = typeof body.project_id === 'string' && body.project_id !== '' ? body.project_id : null;
      const subjectId = typeof body.subject_id === 'string' && body.subject_id !== '' ? body.subject_id : null;

      if ((projectId === null) === (subjectId === null)) {
        res.status(400).json({ error: 'Name one place for it — a project or a subject.' });
        return;
      }

      const thread = await getThread(db, orgId, threadId);
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      if (projectId && !(await getPack(db, orgId, projectId))) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      if (subjectId && !(await getSubject(db, orgId, subjectId))) {
        res.status(404).json({ error: 'no such subject' });
        return;
      }

      const moved = await fileThread(db, orgId, threadId, projectId ? { projectId } : { subjectId: subjectId! });
      if (!moved) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const after = await getThread(db, orgId, threadId);
      res.json({
        thread: {
          id: threadId,
          project_id: after?.projectId ?? null,
          subject_id: after?.subjectId ?? null,
          // Unchanged by filing, and returned so nothing downstream has to
          // assume it: where a conversation came from is a fact about the
          // conversation, not about where it now lives.
          imported_from: after?.importedFrom ?? null,
        },
      });
    }),
  );

  /**
   * One attached document, in full.
   *
   * Thread-scoped rather than project-scoped, unlike the image attachments it
   * sits beside: a conversation under a SUBJECT has no project, and a document
   * pasted into one is no less part of the record for that.
   */
  router.get(
    '/api/threads/:threadId/documents/:messageId/:index',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const [row] = await db
        .select({ meta: agentMessages.meta })
        .from(agentMessages)
        .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id), eq(agentMessages.id, req.params.messageId ?? '')))
        .limit(1);
      const documents = (row?.meta as { documents?: Array<{ name: string; text: string }> } | null)?.documents;
      const found = documents?.[Number(req.params.index ?? -1)];
      if (!found) {
        res.status(404).json({ error: 'no such document' });
        return;
      }
      res.json({ name: found.name, text: found.text });
    }),
  );

  /**
   * Everything that can be put after a `#`. One call, because the picker opens
   * on a keystroke and a list that arrives in pieces is a list that flickers.
   */
  router.get(
    '/api/references',
    asyncHandler(async (req, res) => {
      res.json({ items: await listReferenceCandidates(db, orgIdOf(req)) });
    }),
  );

  /**
   * Stop what this thread's project has in flight.
   *
   * The one control the workbench was missing: a turn could be started and
   * then only waited out. It suspends the sandbox — which is what actually
   * halts the compute and the meter — closes the run, and says in the thread
   * that files already written are still there and nothing was shipped.
   *
   * Idempotent by design. Pressing stop on a thread that has already finished
   * is a 200 saying nothing was running, because the honest answer to "stop"
   * when there is nothing to stop is not an error.
   */
  router.post(
    '/api/threads/:threadId/stop',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const visualsStopped = cancelVisualJobs(orgId, thread.id);
      if (!thread.projectId) {
        res.json({ stopped: visualsStopped > 0 });
        return;
      }
      const outcome = await stopActiveRun(db, orgId, thread.projectId);
      res.json({ stopped: outcome.stopped || visualsStopped > 0 });
    }),
  );

  /** Say something in a thread. Workshop threads build; general threads answer. */
  router.post(
    '/api/sandbox-capacity/free',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const body = (req.body ?? {}) as { project_id?: unknown };
      if (typeof body.project_id !== 'string' || body.project_id === '') { res.status(400).json({ error: 'Choose one inactive workshop to archive.' }); return; }
      const [candidate] = await db.select().from(projectBuild).where(and(eq(projectBuild.orgId, orgId), eq(projectBuild.projectId, body.project_id))).limit(1);
      if (!candidate?.sandboxId) { res.status(404).json({ error: 'That workshop has no sandbox to archive.' }); return; }
      if (candidate.stagedChangesReady) { res.status(409).json({ error: 'That workshop has unshipped changes, so Selvedge will not archive it.' }); return; }
      const active = await db.select({ id: agentRuns.id }).from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, body.project_id), inArray(agentRuns.status, ['queued', 'running']))).limit(1);
      if (active.length) { res.status(409).json({ error: 'That workshop is still working, so Selvedge will not archive it.' }); return; }
      await deleteSandbox(db, orgId, body.project_id);
      res.json({ freed: true, project_id: body.project_id, recoverable: 'The repository and conversation remain; its workshop will be recreated next time.' });
    }),
  );

  router.get(
    '/api/sandbox-capacity/candidates',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const exclude = typeof req.query.project_id === 'string' ? req.query.project_id : null;
      const builds = await db.select().from(projectBuild).where(eq(projectBuild.orgId, orgId)).orderBy(projectBuild.updatedAt);
      const active = new Set((await db.select({ projectId: agentRuns.projectId }).from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.status, ['queued', 'running'])))).map((row) => row.projectId));
      const packs = await listPacks(db, orgId);
      const names = new Map(packs.map((pack) => [pack.identity.project_id, pack.identity.name]));
      res.json({ candidates: builds
        .filter((build) => build.sandboxId && build.projectId !== exclude && !build.stagedChangesReady && !active.has(build.projectId))
        .map((build) => ({ project_id: build.projectId, name: names.get(build.projectId) ?? build.projectId, last_used_at: build.updatedAt.toISOString() })) });
    }),
  );

  router.post(
    '/api/threads/:threadId/consultations/:consultationId/retry',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) { res.status(404).json({ error: 'no such conversation' }); return; }
      const consultationId = req.params.consultationId ?? '';
      const body = (req.body ?? {}) as { agent?: unknown };
      if (!isAgentId(body.agent)) {
        res.status(400).json({ error: 'Choose one agent to retry.' });
        return;
      }
      const rows = await db.select().from(agentMessages)
        .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
        .orderBy(agentMessages.createdAt);
      const marker = rows.find((row) => row.role === 'switch'
        && (row.meta as { consultation_id?: unknown } | null)?.consultation_id === consultationId);
      const consultation = (marker?.meta as { consultation?: { prompt_id?: unknown; agents?: unknown } } | null)?.consultation;
      if (!marker || typeof consultation?.prompt_id !== 'string' || !Array.isArray(consultation.agents) || !consultation.agents.includes(body.agent)) {
        res.status(404).json({ error: 'That consultation lane is not here.' });
        return;
      }
      const prompt = rows.find((row) => row.id === consultation.prompt_id && row.role === 'owner');
      const capsule = (prompt?.meta as { context_capsule?: unknown } | null)?.context_capsule as TaskContextCapsule | undefined;
      if (!prompt || !capsule || typeof capsule.capsule_id !== 'string') {
        res.status(409).json({ error: 'That older consultation did not retain a frozen context capsule, so it cannot be retried exactly.' });
        return;
      }
      const alreadyAnswered = rows.some((row) => row.role === 'agent'
        && (row.meta as { consultation_id?: unknown; answered_by?: unknown; consultation_lane?: { status?: unknown } } | null)?.consultation_id === consultationId
        && (row.meta as { answered_by?: unknown } | null)?.answered_by === body.agent
        && (row.meta as { consultation_lane?: { status?: unknown } } | null)?.consultation_lane?.status === 'answered');
      if (alreadyAnswered) { res.status(409).json({ error: `${agentById(body.agent)?.name ?? body.agent} already answered this consultation.` }); return; }

      if (changesFiles(body.agent)) {
        if (!thread.projectId) { res.status(409).json({ error: 'That builder needs a project to work in.' }); return; }
        const resolved = await configFor(db, orgId, thread.projectId, env, undefined, lookup);
        if ('error' in resolved) { res.status(resolved.status).json({ error: resolved.error }); return; }
        void runTurn(db, orgId, thread.projectId, prompt.content, { ...resolved.cfg, agent: body.agent }, {
          mode: 'build', threadId: thread.id, recordOwnerMessage: false,
          consultation: { id: consultationId, promptId: prompt.id }, contextCapsule: capsule,
        }).catch(async (error) => {
          console.error(`builder consultation retry failed for ${orgId}/${thread.id}/${body.agent}:`, error);
          await failActiveRun(db, orgId, thread.projectId!).catch(() => undefined);
          await db.insert(agentMessages).values({ id: ulid(), orgId, projectId: thread.projectId, threadId: thread.id, role: 'agent', content:
            isSandboxCapacityError(error) ? 'The sandbox host is still out of storage. Free another inactive workshop, then retry Codex only.' : "That builder retry didn't start. Nothing was changed.",
            meta: { answered_by: body.agent, consultation_id: consultationId, in_reply_to: prompt.id,
              context_capsule_id: capsule.capsule_id, context_capsule_hash: capsule.content_hash,
              consultation_lane: { status: 'failed', failure_code: isSandboxCapacityError(error) ? 'sandbox_capacity' : 'builder_failed', retryable: true,
                ...(isSandboxCapacityError(error) ? { recovery: 'free_sandbox_storage' } : {}) } } }).catch(() => undefined);
        });
      } else {
        const provider = agentById(body.agent)?.provider ?? null;
        const fuel = provider ? await resolveFuelFor(db, orgId, provider).catch(() => null) : null;
        void chatTurn(db, orgId, thread, prompt.content, {
          client: fuel?.client ?? null, recordOwnerMessage: false, answeringAs: body.agent, asTake: true,
          consultation: { id: consultationId, promptId: prompt.id }, contextCapsule: capsule,
        }).catch((error) => console.error(`consultation retry failed for ${orgId}/${thread.id}/${body.agent}:`, error));
      }
      res.status(202).json({ started: true, consultation_id: consultationId, agent: body.agent, context_capsule_id: capsule.capsule_id });
    }),
  );

  router.post(
    '/api/threads/:threadId/message',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      let thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const body = (req.body ?? {}) as { text?: unknown; mode?: unknown; documents?: unknown; images?: unknown; files?: unknown; checkout_resolution?: unknown; raise_cap?: unknown; acknowledge_stale?: unknown; search_everywhere?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'say what you want' });
        return;
      }

      /**
       * THE FIRST THING SAID NAMES THE ROOM.
       *
       * Threads are created as "Workshop" or "New thread" and nothing ever
       * renamed them. Invisible while the rail showed only project names — and
       * the moment the rail started showing what a place IS, it showed twelve
       * rows reading "Workshop", as useful as the blank line it replaced.
       *
       * Here rather than beside any one insert, because there are three paths
       * that write an owner message and this must not depend on which one ran.
       * Only while the title is still a default, and only when the thread has
       * nothing in it yet: this fills a blank, it never overwrites a name
       * somebody chose.
       */
      if (isDefaultTitle(thread.title)) {
        const [{ count } = { count: 0 }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(agentMessages)
          .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id), eq(agentMessages.role, 'owner')));
        if (count === 0) {
          const named = titleFromFirstMessage(text);
          // A rename that fails changes nothing about the turn — the message
          // is the point, the title is a courtesy.
          if (named && (await renameThread(db, orgId, thread.id, named).catch(() => false))) {
            thread = { ...thread, title: named };
          }
        }
      }

      /**
       * WHO ANSWERS — read out of the sentence, not out of a mode chosen
       * before anyone knew what the conversation would become.
       */
      const intent = mentionIntent(text);

      // A paste too long to be a sentence rides beside the message rather than
      // inside it — see shared/documents.ts. Bounded here, where the request
      // arrives, because everything downstream trusts what this route accepted.
      const documents = boundDocuments(Array.isArray(body.documents) ? (body.documents as Array<{ name?: unknown; text?: unknown }>) : []);

      // ATTACHMENTS, AT THE DOOR EVERYONE USES. This route quietly dropped
      // `images` and `files` while only the old workshop route read them — the
      // composer offered the buttons and the server read neither key. Same
      // validators as that route now (web/attachments.ts), same meaning.
      const images = validateImages(body.images);
      if ('error' in images) {
        res.status(400).json({ error: images.error });
        return;
      }
      const fileRefs = validateFileRefs(body.files);
      if ('error' in fileRefs) {
        res.status(400).json({ error: fileRefs.error });
        return;
      }

      /**
       * WHAT THEY POINTED AT — resolved once, here, from the stored text.
       *
       * Every branch below needs the same answer, and resolving it three times
       * would be three chances to drift. `missed` is carried too: a name that
       * matched nothing is reported to the model so it can say so, rather than
       * quietly answering as though half the question wasn't asked.
       */
      const named = await resolveReferences(db, orgId, text).catch(() => ({ resolved: [], missed: [] }));
      /**
       * AND WHAT THEY MEANT WITHOUT SAYING IT.
       *
       * Nobody types punctuation when they are thinking. "refer to our chats
       * about moving to a monthly fee" is how the question actually arrives,
       * and answering that with "no such thing as that" while the conversation
       * sits in the database is the product being pedantic at somebody who is
       * right.
       *
       * Skipped entirely when a `#` is present: they named it, there is
       * nothing left to guess.
       */
      /**
       * AND WHERE IT LOOKS FIRST DEPENDS ON WHERE YOU ARE STANDING.
       *
       * A conversation filed under a subject is a conversation ABOUT that
       * subject — "Claude history" is not a label on a drawer, it is the three
       * hundred and sixty chats you are sitting inside. So a question asked
       * there searches those first, and brings back more of them than an
       * account-wide sweep would, because the owner has already narrowed it by
       * choosing where to ask.
       *
       * It falls back to the whole account when nothing under the subject
       * matched, rather than answering "I found nothing" while the answer sits
       * in a project. Either way the reference line names every conversation
       * used and marks it as something the database found rather than
       * something the owner pointed at.
       */
      // Where the guess was made, reported back in the reference line. Set by
      // the search below so the sentence describes what actually happened
      // rather than what was intended.
      const scope: SearchScope = { searched: null, widened: false };
      const found = named.resolved.length
        ? []
        : await (async () => {
            /**
             * HOME FIRST. A conversation that belongs somewhere searches there
             * before it searches everywhere — and a project is the narrowest
             * and most obvious somewhere there is.
             *
             * The project half of this was missing, and it showed. Asking the
             * builder sitting inside an app to get familiar with that app
             * searched the entire account and came back with three imported
             * chats about selling apparel and migrating an unrelated repo,
             * under the words "which seemed to be what you meant". Every one
             * of those was a confident answer to a question nobody asked.
             */
            const home = thread.projectId
              ? { projectId: thread.projectId }
              : thread.subjectId
                ? { subjectId: thread.subjectId }
                : null;
            if (home) {
              // The project id IS the name on screen ("ringrunner · builds in
              // the sandbox"), so it needs no lookup. A subject id is a ulid
              // and does — fetched only on this path, never on a plain turn.
              scope.searched = thread.projectId ?? (await getSubject(db, orgId, thread.subjectId!).catch(() => null))?.name ?? null;
              const inHome = await findRelatedConversations(db, orgId, text, {
                excludeThreadId: thread.id,
                ...home,
                limit: MAX_IN_HOME_THREAD,
              }).catch(() => []);
              if (inHome.length) return inHome;
              if (body.search_everywhere !== true) return [];
              scope.widened = true; // explicitly requested, and said below
            }
            return findRelatedConversations(db, orgId, text, { excludeThreadId: thread.id }).catch(() => []);
          })();
      // A continuation's reviewed conversations travel on every turn. They are
      // exact links, not fuzzy search results, and imported provenance remains
      // visible in both the prompt and the thread's reference line.
      const boundIds = await boundContextThreadIds(db, orgId, thread.id).catch(() => []);
      const bound = (await Promise.all(boundIds.map((id) => conversationReferenceById(db, orgId, id)))).filter((item) => item !== null);
      const continuationSources = await boundContinuationSources(db, orgId, thread.id).catch(() => []);
      let supportingChars = 0;
      const supporting = continuationSources.filter((source) => source.kind !== 'repository' && source.kind !== 'imported_thread').flatMap((source) => {
        const remaining = 24_000 - supportingChars;
        if (remaining <= 0) return [];
        const content = source.content?.trim() || 'No contents were supplied.';
        const excerpt = content.slice(0, Math.min(8_000, remaining));
        supportingChars += excerpt.length;
        return [{
          kind: 'continuation_source' as const,
          id: source.id,
          label: source.title,
          found: false,
          note: `${source.kind.replaceAll('_', ' ')} · observed ${source.observedAt.toISOString().slice(0, 10)}`,
          text: [
            `Reviewed continuation source: ${source.title} (${source.kind.replaceAll('_', ' ')}).`, excerpt,
            ...(Array.isArray(source.limitations) ? source.limitations.filter((item): item is string => typeof item === 'string').map((item) => `Limitation: ${item}`) : []),
          ].join('\n\n'),
        }];
      });
      const resolvedById = new Map([...bound, ...supporting, ...named.resolved, ...found].map((item) => [item.id, item]));
      const references = { resolved: [...resolvedById.values()], missed: named.missed };
      const referenced = renderReferences(references);
      const askedForPriorContext = /\b(refer|chats?|conversations?|imports?|discussed|talked about|history)\b/i.test(text);
      const referenceNote = references.resolved.length
        ? referenceLine(
            references.resolved.map((r) => ({ label: r.label, ...(r.note ? { note: r.note } : {}), ...(r.found ? { found: true } : {}) })),
            scope,
          )
        : askedForPriorContext && scope.searched && body.search_everywhere !== true
          ? `⇄ found nothing matching that in ${scope.searched}; account-wide search was not used, so unrelated projects did not enter the answer.`
          : undefined;

      // A CONSULTATION. Everyone named answers the same question, on their own
      // model and without the sandbox, and the conversation does not change
      // hands. Two agents cannot build at once — one project, one sandbox —
      // and asking for two takes was never a request for two builds anyway.
      if (intent.kind === 'consult') {
        const asked = intent.agents.slice(0, MAX_CONSULTED);
        // Whoever was named and didn't fit. Said on the thread rather than
        // dropped in silence — see consultationLine.
        const skipped = intent.agents.slice(MAX_CONSULTED);
        const builders = asked.filter((agent) => changesFiles(agent));
        const consultationMode = executionModeFor(text, body.mode);
        const visualRequest = wantsVisual(text);
        if (visualRequest && builders.length > 0) {
          res.status(400).json({ error: 'Visual comparisons currently use conversational models. Ask Claude and GPT, then hand the chosen direction to a builder.' });
          return;
        }
        const imageKey = visualRequest ? await imageApiKeyFor(db, orgId) : null;
        if (visualRequest && (!visualStore || !imageKey)) {
          res.status(503).json({ error: 'Visual responses need an OpenAI image key and visual object storage configured.' });
          return;
        }
        if (builders.length > 1) {
          res.status(409).json({
            error: 'Two builders cannot safely change one project at the same time. Pick which one should go first.',
            code: 'choose_builder_order',
            builders,
          });
          return;
        }

        let mixedBuild: {
          agent: AgentId;
          projectId: string;
          cfg: AgentTurnConfig;
          handoff?: string;
          handoffMessageId?: string;
          files: AttachedFile[];
          paired: Awaited<ReturnType<typeof withFreshness>> | null;
          mode: ExecutionMode;
        } | null = null;
        if (builders[0]) {
          const builder = builders[0];
          const projectId = thread.projectId;
          if (!projectId) {
            res.status(409).json({ error: `${agentById(builder)?.name ?? 'That builder'} needs a project to build in.`, code: 'needs_project', agent: builder });
            return;
          }
          const mode = consultationMode;
          if (checkoutGuardEnabled) {
            const guard = await inspectCheckout(db, orgId, projectId, { threadId: thread.id, goal: text });
            if (!canResolveCheckout(guard, body.checkout_resolution)) {
              res.status(409).json({ error: 'This checkout needs a deliberate choice before another change starts.', code: 'checkout_conflict', checkout_guard: guard });
              return;
            }
          } else if (await activeRun(orgId, projectId)) {
            res.status(409).json({ error: "I'm already working on this project — let me finish that first." });
            return;
          }
          const resolved = await configFor(db, orgId, projectId, env, undefined, lookup);
          if ('error' in resolved) {
            res.status(resolved.status).json({ error: resolved.error });
            return;
          }
          const minutes = await canStartBuild(db, orgId);
          if (!minutes.allowed) {
            refuse(res, minutes);
            return;
          }
          const ceiling = await threadCeiling(db, orgId, thread);
          if (ceiling.reached && body.raise_cap !== true) {
            res.status(409).json({ error: ceiling.note, spend_ceiling: { spent_cents: ceiling.spentCents, cap_cents: ceiling.capCents, raises: ceiling.raises } });
            return;
          }
          if (ceiling.reached) await raiseCeiling(db, orgId, thread, ceiling);
          const brief = await briefForThread(db, orgId, thread.id).catch(() => null);
          const paired = brief && brief.buildingThreadId === thread.id ? await withFreshness(db, orgId, brief) : null;
          if (paired?.freshness.state === 'stale' && body.acknowledge_stale !== true) {
            res.status(409).json({
              error: `${paired.freshness.note} Refresh the decision, or send again to build from it as it stands.`,
              stale_decision: { brief_id: paired.brief.id, behind: paired.freshness.behind, thinking_thread_id: paired.brief.thinkingThreadId },
            });
            return;
          }
          const handoff = await pendingHandoff(db, orgId, thread.id).catch(() => null);
          const consumed: Array<{ path: string }> = [];
          const files: AttachedFile[] = [];
          for (const id of fileRefs.ids) {
            const staged = consumeStagedUpload(orgId, projectId, id);
            if (!staged) {
              await Promise.all(consumed.map((file) => fsp.unlink(file.path).catch(() => undefined)));
              res.status(400).json({ error: "one of those files wasn't found — try attaching it again" });
              return;
            }
            consumed.push(staged);
            files.push({ name: staged.name, mime: staged.mime, localPath: staged.path });
          }
          mixedBuild = {
            agent: builder,
            projectId,
            cfg: { ...resolved.cfg, agent: builder, model: defaultChatModelFor(builder) },
            ...(handoff ? { handoff: handoff.text } : {}),
            ...(handoff ? { handoffMessageId: handoff.messageId } : {}),
            files,
            paired,
            mode,
          };
        }
        const ownerMessageId = ulid();
        const consultationId = ulid();
        // Compile ONCE before fan-out. Every consulted model receives these
        // exact bytes and records the same receipt; no lane can observe a
        // later worktree and pretend the comparison was apples-to-apples.
        const executionState = thread.projectId ? await captureExecutionState(db, orgId, thread.projectId).catch(() => null) : null;
        const contextCapsule = await compileContext(db, {
          orgId,
          projectId: thread.projectId,
          threadId: thread.id,
          userRequest: text,
          executionState,
          referencedPriorAnswers: referenced
            ? [{ value: referenced, source: 'thread', observed_at: new Date().toISOString(), freshness: 'current' }]
            : [],
        });
        // The batch is ordered deliberately. Database defaults give every row
        // in one INSERT the same timestamp, and ordering equal timestamps is
        // not a contract. Replies start only after this insert completes.
        // Count backwards so the system rows have a stable order without
        // placing them in the future: a no-key answer can be written almost
        // immediately after this batch.
        const askedAt = new Date(Date.now() - (referenceNote ? 2 : 1));
        await db.insert(agentMessages).values([
          {
            id: ownerMessageId,
            orgId,
            projectId: thread.projectId,
            threadId: thread.id,
            role: 'owner',
            content: text,
            meta: { ...(documents.length ? { documents } : {}), consultation_id: consultationId,
              context_capsule_id: contextCapsule.capsule_id, context_capsule_hash: contextCapsule.content_hash,
              context_capsule: contextCapsule },
            createdAt: askedAt,
          },
          {
            id: ulid(),
            orgId,
            projectId: thread.projectId,
            threadId: thread.id,
            role: 'switch',
            content: consultationLine(asked, (id) => agentById(id)?.name ?? id, skipped, consultationMode),
            meta: {
              consulted: asked,
              ...(skipped.length ? { skipped } : {}),
              consultation_id: consultationId,
              consultation: { id: consultationId, prompt_id: ownerMessageId, agents: asked },
              context_capsule_id: contextCapsule.capsule_id,
              context_capsule_hash: contextCapsule.content_hash,
            },
            createdAt: new Date(askedAt.getTime() + 1),
          },
          ...(referenceNote
            ? [{
                id: ulid(),
                orgId,
                projectId: thread.projectId,
                threadId: thread.id,
                role: 'switch',
                content: referenceNote,
                meta: { consultation_id: consultationId, in_reply_to: ownerMessageId },
                createdAt: new Date(askedAt.getTime() + 2),
              }]
            : []),
        ]);

        const consulted = thread;
        if (mixedBuild?.paired?.freshness.state === 'stale' && body.acknowledge_stale === true) {
          await db.insert(agentMessages).values({
            id: ulid(), orgId, projectId: mixedBuild.projectId, threadId: consulted.id, role: 'switch',
            content: `⇄ built from the decision as it stood — ${mixedBuild.paired.freshness.behind} later message${mixedBuild.paired.freshness.behind === 1 ? '' : 's'} in the thinking were not part of it.`,
            meta: { consultation_id: consultationId, in_reply_to: ownerMessageId },
          }).catch(() => undefined);
        }
        for (const agent of asked.filter((candidate) => !changesFiles(candidate))) {
          const provider = agentById(agent)?.provider ?? null;
          const fuel = provider ? await resolveFuelFor(db, orgId, provider).catch(() => null) : null;
          if (visualRequest && fuel?.client && imageKey && visualStore) {
            void runVisualJob(db, orgId, {
              threadId: consulted.id, consultationId, promptId: ownerMessageId,
              directingAgent: agent, directingModel: defaultChatModelFor(agent), request: text,
              director: fuel.client, renderer: new OpenAIVisualRenderer(imageKey), objectStore: visualStore,
              contextCapsule,
            });
          } else {
            void chatTurn(db, orgId, consulted, text, {
              client: fuel?.client ?? null,
              recordOwnerMessage: false,
              ...(documents.length ? { documents } : {}),
              answeringAs: agent,
              asTake: true,
              consultation: { id: consultationId, promptId: ownerMessageId },
              contextCapsule,
            }).catch((err) => {
              console.error(`take from ${agent} failed for ${orgId}/${consulted.id}:`, err);
            });
          }
        }
        if (mixedBuild) {
          const buildTurnId = ulid();
          const buildLive = { turnId: buildTurnId, agent: mixedBuild.agent, consultationId, capability: 'build' as const };
          publishLiveChat(orgId, consulted.id, { type: 'reply_started', ...buildLive });
          const decisionPreamble = mixedBuild.paired
            ? [mixedBuild.paired.freshness.state === 'stale' ? staleWarningFor(mixedBuild.paired.freshness) : null, briefAsText(mixedBuild.paired.brief)].filter(Boolean).join('\n\n')
            : null;
          void runTurn(db, orgId, mixedBuild.projectId, text, mixedBuild.cfg, {
            mode: mixedBuild.mode,
            threadId: thread.id,
            recordOwnerMessage: false,
            consultation: { id: consultationId, promptId: ownerMessageId },
            contextCapsule,
            ...(mixedBuild.handoff || decisionPreamble || referenced
              ? { handoff: [decisionPreamble, referenced, mixedBuild.handoff].filter(Boolean).join('\n\n---\n\n') }
              : {}),
            ...(documents.length ? { documents } : {}),
            ...(images.images.length ? { images: images.images } : {}),
            ...(mixedBuild.files.length ? { files: mixedBuild.files } : {}),
          }).then(() => {
            publishLiveChat(orgId, consulted.id, { type: 'reply_finished', ...buildLive });
          }).catch(async (err) => {
            publishLiveChat(orgId, consulted.id, { type: 'reply_cancelled', ...buildLive });
            console.error(`mixed builder turn failed for ${orgId}/${consulted.id}:`, err);
            await failActiveRun(db, orgId, mixedBuild!.projectId).catch(() => undefined);
            await db.insert(agentMessages).values({
              id: ulid(), orgId, projectId: mixedBuild!.projectId, threadId: consulted.id, role: 'agent',
              content: isSandboxCapacityError(err)
                ? 'Codex could not start because the sandbox account is out of storage. Free an inactive workshop below, then retry Codex only. Nothing was changed.'
                : `I couldn't get started on that — ${err instanceof Error ? err.message : 'something went wrong'}. Nothing was changed.`,
              meta: { answered_by: mixedBuild!.agent, consultation_id: consultationId, in_reply_to: ownerMessageId,
                context_capsule_id: contextCapsule.capsule_id, context_capsule_hash: contextCapsule.content_hash,
                consultation_lane: isSandboxCapacityError(err)
                  ? { status: 'failed', failure_code: 'sandbox_capacity', retryable: true, recovery: 'free_sandbox_storage' }
                  : { status: 'failed', failure_code: 'builder_failed', retryable: true } },
            }).catch(() => undefined);
          });
          if (mixedBuild.handoffMessageId) await markHandoffSpent(db, orgId, mixedBuild.handoffMessageId).catch(() => undefined);
        }
        res.status(202).json({ started: true, warming: false, consulted: asked, consultation_id: consultationId });
        return;
      }

      /**
       * A BUILDER NEEDS SOMEWHERE TO PUT THE CODE, and this is asked BEFORE the
       * conversation changes hands.
       *
       * The order matters more than it looks. This check used to sit after the
       * switch, which meant naming Claude Code in an idea handed the thread to
       * a builder that could not build, wrote a switch line onto the record,
       * and then refused — leaving the conversation on the wrong agent with the
       * message unsent and nothing to do but retype it.
       *
       * Refusing first leaves everything exactly as it was. The answer is
       * `POST /threads/:id/build`, and the same message is sent again after the
       * move — at which point this passes and the switch happens for real.
       */
      if (changesFiles(intent.kind === 'direct' ? intent.agent : thread.agent) && !thread.projectId) {
        const packs = await listPacks(db, orgId);
        const wanted = intent.kind === 'direct' ? intent.agent : (thread.agent as AgentId);
        const agentName = agentById(wanted)?.name ?? 'A builder';
        res.status(409).json({
          error: `${agentName} builds inside a project — it needs somewhere to put the code.`,
          code: 'needs_project',
          agent: wanted,
          projects: packs.map((p) => ({ id: p.identity.project_id, name: p.identity.name })),
          // Whether "start a new one" can work here at all. Said rather than
          // discovered: offering to make a repo on a deployment that cannot is
          // a dead end dressed as a choice.
          can_create: Boolean(makeRepo),
        });
        return;
      }

      // ONE NAME DIRECTS THE TURN — and because that is a switch, it is priced
      // and recorded exactly like one, handover and all.
      if (intent.kind === 'direct' && intent.agent !== thread.agent) {
        const switched = await switchThreadAgent(db, orgId, thread.id, intent.agent);
        if (!switched.ok) {
          res.status(400).json({ error: switched.message });
          return;
        }
        thread = switched.thread;
      }

      /**
       * WHAT HAPPENS is decided by what the answering agent can DO. There used
       * to be a `thread.kind` here deciding it instead, and that was the wall:
       * it meant moving from working out what to build to building it required
       * a second conversation.
       */
      if (!changesFiles(thread.agent)) {
        // A talker has no sandbox to put a file in and no eyes for an image
        // yet — said now, before the send, with the way through. Refusing
        // beats accepting-and-ignoring: an attachment that silently vanishes
        // reads as "it saw the screenshot and had nothing to say".
        if (images.images.length > 0 || fileRefs.ids.length > 0) {
          res.status(400).json({
            error: `${agentById(thread.agent as AgentId)?.name ?? 'This agent'} can't take attachments yet — a builder can. Name @claudecode or @codex and the files ride along.`,
          });
          return;
        }
        const provider = chatProviderFor(thread.agent as AgentId);
        const fuel = provider ? await resolveFuelFor(db, orgId, provider).catch(() => null) : null;
        if (wantsVisual(text)) {
          const imageKey = await imageApiKeyFor(db, orgId);
          if (!fuel?.client || !visualStore || !imageKey) {
            res.status(503).json({ error: 'Visual responses need the selected model, an OpenAI image key, and visual object storage configured.' });
            return;
          }
          const promptId = ulid();
          await db.insert(agentMessages).values({
            id: promptId, orgId, projectId: thread.projectId, threadId: thread.id,
            role: 'owner', content: text, meta: { ...(documents.length ? { documents } : {}) },
          });
          if (referenceNote) {
            await db.insert(agentMessages).values({
              id: ulid(), orgId, projectId: thread.projectId, threadId: thread.id,
              role: 'switch', content: referenceNote, meta: { in_reply_to: promptId },
            });
          }
          const directingAgent = thread.agent as AgentId;
          void runVisualJob(db, orgId, {
            threadId: thread.id, promptId, directingAgent,
            directingModel: defaultChatModelFor(directingAgent), request: text,
            director: fuel.client, renderer: new OpenAIVisualRenderer(imageKey), objectStore: visualStore,
          });
          res.status(202).json({ started: true, visual: true, warming: false });
          return;
        }
        // The turn runs in the background like every other turn, so a slow
        // model never holds the composer.
        const talking = thread;
        void chatTurn(db, orgId, talking, text, {
          client: fuel?.client ?? null,
          ...(referenceNote ? { referenceNote } : {}),
          ...(documents.length ? { documents } : {}),
        }).catch((err) => {
          console.error(`chat turn failed for ${orgId}/${talking.id}:`, err);
        });
        res.status(202).json({ started: true, warming: false });
        return;
      }

      const mode = executionModeFor(text, body.mode);
      /**
       * Unreachable: the builder guard above returns for exactly this case.
       * Written as a narrowing rather than a `!` so that a future edit which
       * moves or weakens that guard fails loudly here, instead of reaching a
       * sandbox call with a null project id.
       */
      const buildIn = thread.projectId;
      if (!buildIn) {
        res.status(409).json({ error: 'That conversation has no project to build in.', code: 'needs_project' });
        return;
      }
      if (checkoutGuardEnabled && mode === 'build') {
        const guard = await inspectCheckout(db, orgId, buildIn, { threadId: thread.id, goal: text });
        if (!canResolveCheckout(guard, body.checkout_resolution)) {
          await recordProductEvent(db, orgId, 'checkout_conflict', { surface: surfaceOf(req), projectId: buildIn, threadId: thread.id, properties: { state: guard.state } });
          res.status(409).json({
            error: guard.state === 'active_mutation'
              ? "I'm already working on this project — let me finish that first."
              : 'This checkout already contains work that needs a deliberate choice before another change starts.',
            code: 'checkout_conflict',
            checkout_guard: guard,
          });
          return;
        }
      }
      const resolved = await configFor(db, orgId, buildIn, env, undefined, lookup);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      if (!checkoutGuardEnabled && await activeRun(orgId, buildIn)) {
        res.status(409).json({ error: "I'm already working on this project — let me finish that first." });
        return;
      }

      /**
       * BUILD MINUTES. Checked before a sandbox is asked for and nowhere after:
       * a run that starts with minutes left is allowed to finish even if it
       * crosses zero on the way. Killing a build mid-sentence to save thirty
       * seconds of quota loses the owner's work to save us nothing.
       *
       * Plan mode is checked too. It changes nothing in the repo, but it runs
       * in the same sandbox on the same wall clock, and wall clock is what this
       * costs.
       */
      const minutes = await canStartBuild(db, orgId);
      if (!minutes.allowed) {
        refuse(res, minutes);
        return;
      }

      /**
       * THE SPEND CEILING. A conversation stops where it said it would, the
       * same way a work card does — this is the half of "nothing spends past
       * what you approved" that the workbench used not to have.
       *
       * Like the stale-decision guard below, it is a refusal WITH A WAY
       * THROUGH: the number is named, the way on is one word, and taking it is
       * written onto the conversation so a lifted ceiling is never invisible.
       */
      const ceiling = await threadCeiling(db, orgId, thread);
      if (ceiling.reached) {
        if ((req.body as { raise_cap?: unknown })?.raise_cap !== true) {
          res.status(409).json({
            error: ceiling.note,
            spend_ceiling: { spent_cents: ceiling.spentCents, cap_cents: ceiling.capCents, raises: ceiling.raises },
          });
          return;
        }
        await raiseCeiling(db, orgId, thread, ceiling);
      }

      // THE STALE-DECISION GUARD. A building thread paired to a decision brief
      // must not act on one that has fallen behind the thinking it came from:
      // that is the failure this feature was warned about, and the only way it
      // becomes a confidently wrong verdict later. The owner can still proceed —
      // it is their decision — but only deliberately, and the thread records
      // that they did.
      const brief = await briefForThread(db, orgId, thread.id).catch(() => null);
      const paired = brief && brief.buildingThreadId === thread.id ? await withFreshness(db, orgId, brief) : null;
      const acknowledged = (req.body as { acknowledge_stale?: unknown })?.acknowledge_stale === true;
      if (paired && paired.freshness.state === 'stale' && !acknowledged) {
        res.status(409).json({
          error: `${paired.freshness.note} Refresh the decision, or send again to build from it as it stands.`,
          stale_decision: { brief_id: paired.brief.id, behind: paired.freshness.behind, thinking_thread_id: paired.brief.thinkingThreadId },
        });
        return;
      }

      // A handover parked by a switch is spent here, on the first message after
      // it — marked spent only once the turn has actually been handed it, so a
      // failed start never silently eats the handover.
      const handoff = await pendingHandoff(db, orgId, thread.id).catch(() => null);
      const build = await getBuild(db, orgId, buildIn);
      const agent = thread.agent as AgentId;

      // The decision opens the work: on the FIRST turn the builder is handed
      // what was decided (and, when it has fallen behind, told so in the same
      // breath). Later turns don't repeat it — the agent's own session carries
      // it — but the guard above still runs on every one of them.
      const [priorRun] = paired
        ? await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.threadId, thread.id))).limit(1)
        : [];
      const decisionPreamble =
        paired && !priorRun
          ? [paired.freshness.state === 'stale' ? staleWarningFor(paired.freshness) : null, briefAsText(paired.brief)].filter(Boolean).join('\n\n')
          : null;
      if (paired && paired.freshness.state === 'stale' && acknowledged) {
        // On the record: this turn was built from a decision the thinking had
        // already moved past. Nothing reading this thread later can mistake it
        // for work that matched the current decision.
        await db
          .insert(agentMessages)
          .values({
            id: ulid(),
            orgId,
            projectId: buildIn,
            threadId: thread.id,
            role: 'switch',
            content: `⇄ built from the decision as it stood — ${paired.freshness.behind} later message${paired.freshness.behind === 1 ? '' : 's'} in the thinking were not part of it.`,
            meta: { decision: { brief_id: paired.brief.id, freshness: paired.freshness, acknowledged: true } },
          })
          .catch(() => undefined);
      }

      const projectId = buildIn;
      // A builder always starts from a freshly compiled projection. This is
      // what lets an owner consult GPT/Gemini, accept one answer in the next
      // sentence, and hand Claude Code the referenced answer plus worktree as
      // they stand NOW—without promoting that opinion into durable knowledge.
      const executionState = await captureExecutionState(db, orgId, projectId).catch(() => null);
      const contextCapsule = await compileContext(db, {
        orgId,
        projectId,
        threadId: thread.id,
        userRequest: text,
        executionState,
        referencedPriorAnswers: referenced
          ? [{ value: referenced, source: 'thread', observed_at: new Date().toISOString(), freshness: 'current' }]
          : [],
      });
      // Staged uploads are checked out right before firing — nothing consumed
      // by a request that was going to fail an earlier check. Any missing id
      // fails the whole message; already-consumed temp files are cleaned up.
      const consumed: Array<{ path: string }> = [];
      const attachedFiles: AttachedFile[] = [];
      for (const id of fileRefs.ids) {
        const staged = consumeStagedUpload(orgId, buildIn, id);
        if (!staged) {
          await Promise.all(consumed.map((f) => fsp.unlink(f.path).catch(() => undefined)));
          res.status(400).json({ error: "one of those files wasn't found — try attaching it again" });
          return;
        }
        consumed.push(staged);
        attachedFiles.push({ name: staged.name, mime: staged.mime, localPath: staged.path });
      }

      void runTurn(
        db,
        orgId,
        projectId,
        text,
        { ...resolved.cfg, agent, ...(thread.model ? { model: thread.model } : {}) },
        {
          mode,
          threadId: thread.id,
          contextCapsule,
          // One seam for "start this agent with this context", whether the
          // context is a handover from another agent, the decision this work
          // exists to carry out, or another project the owner pointed at.
          ...(handoff || decisionPreamble || referenced
            ? { handoff: [decisionPreamble, referenced, handoff?.text].filter(Boolean).join('\n\n---\n\n') }
            : {}),
          ...(referenceNote ? { referenceNote } : {}),
          ...(documents.length ? { documents } : {}),
          ...(images.images.length ? { images: images.images } : {}),
          ...(attachedFiles.length ? { files: attachedFiles } : {}),
        },
      ).catch(async (err) => {
        console.error(`thread turn failed to start for ${orgId}/${thread.id}:`, err);
        // The run row is written before the sandbox is touched, so a turn that
        // dies on the way in leaves the project locked to a run that isn't
        // happening. Unlock it: the failure costs one sentence, not an hour of
        // a conversation that won't take work.
        await failActiveRun(db, orgId, projectId).catch(() => undefined);
        await db
          .insert(agentMessages)
          .values({
            id: ulid(),
            orgId,
            projectId: buildIn,
            threadId: thread.id,
            role: 'agent',
            content: `I couldn't get started on that — ${err instanceof Error ? err.message : 'something went wrong'}. Nothing was changed.`,
          })
          .catch(() => undefined);
      });
      if (handoff) await markHandoffSpent(db, orgId, handoff.messageId).catch(() => undefined);

      res.status(202).json({
        started: true,
        // Honest liveness: a cold sandbox (or a builder whose CLI still has to
        // install) means a wait before anything happens, and the thread says so
        // instead of looking stuck.
        warming: build?.sandboxId == null || (agent === 'codex' && build?.codexSessionId == null),
      });
    }),
  );

  return router;
}
