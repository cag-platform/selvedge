import { Router, type Request } from 'express';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { agentMessages, agentMessageAttachments, agentRuns, digests, llmUsage, orgs, threads } from '../../db/schema/index.js';
import { getPack, listPacks } from '../../packs/store.js';
import { edgeStatus, healthLine } from '../../packs/healthLine.js';
import { localDateString } from '../../digest/timezone.js';
import { getBuild } from '../../build/store.js';
import { configFor, engineEnv, type EngineEnv } from '../../build/engineConfig.js';
import { runAgentTurn } from '../../build/agent.js';
import { runChatTurn, chatProviderFor } from '../../chat/turn.js';
import { resolveFuelFor } from '../../connectors/fuel/resolve.js';
import { createThread, ensureWorkshopThread, getThread, listThreads, renameThread, setThreadArchived } from '../../threads/store.js';
import { markHandoffSpent, pendingHandoff, switchThreadAgent } from '../../threads/switch.js';
import { agentById, type AgentId } from '../../../shared/agents.js';
import { isThreadKind, DEFAULT_GENERAL_TITLE, DEFAULT_WORKSHOP_TITLE, type ThreadKind } from '../../../shared/types/thread.js';
import { listUnsortedEvents } from '../../resolution/unsortedTray.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
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

/** A run this old still marked running is a crashed process, not real work. */
const STUCK_RUN_MS = 45 * 60 * 1000;

export type ThreadsDeps = {
  runTurn?: typeof runAgentTurn;
  chatTurn?: typeof runChatTurn;
  env?: () => EngineEnv | null;
};

export function createThreadsRouter(db: Db, deps: ThreadsDeps = {}) {
  const router = Router();
  const runTurn = deps.runTurn ?? runAgentTurn;
  const chatTurn = deps.chatTurn ?? runChatTurn;
  const env = deps.env ?? engineEnv;

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
      const [packs, threadRows, org] = await Promise.all([
        listPacks(db, orgId),
        db.select().from(threads).where(eq(threads.orgId, orgId)),
        db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1),
      ]);
      const timezone = org[0]?.timezone ?? 'UTC';

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
      for (const t of threadRows) {
        if (t.archivedAt) continue;
        const list = byProject.get(t.projectId) ?? [];
        list.push(t);
        byProject.set(t.projectId, list);
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
          status: edgeStatus(pack),
          health: healthLine(pack),
          threads,
        };
      });

      const [digest] = await db
        .select({ date: digests.digestDate, headline: digests.headline })
        .from(digests)
        .where(and(eq(digests.orgId, orgId), eq(digests.digestDate, localDateString(new Date(), timezone))))
        .limit(1);

      // The tray's count is a quiet line on the rail, not a destination.
      const unsorted = await listUnsortedEvents(db, orgId).catch(() => []);

      res.json({
        projects,
        brief: digest ? { date: digest.date, headline: digest.headline } : null,
        unsorted_count: unsorted.length,
        engine_on: env() !== null,
      });
    }),
  );

  /** Everything one thread needs to be read and worked in. */
  router.get(
    '/api/threads/:threadId',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const [pack, build, messages, runs, running] = await Promise.all([
        getPack(db, orgId, thread.projectId),
        getBuild(db, orgId, thread.projectId),
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
        activeRun(orgId, thread.projectId),
      ]);

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
        project: { id: thread.projectId, name: pack?.identity.name ?? thread.projectId },
        live_url: pack?.identity.links?.live_url ?? null,
        engine_on: env() !== null,
        working: running !== null,
        staged_changes_ready: build?.stagedChangesReady ?? false,
        // A cold sandbox means the first message of a workshop thread waits
        // while it wakes. The composer says so rather than pretending.
        sandbox: build?.sandboxId ? 'attached' : 'none',
        handoff_waiting: pending !== null,
        cost_cents: threadCents,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          at: m.createdAt.toISOString(),
          attachments: attByMessage.get(m.id) ?? [],
          run_id: m.runId,
          ...(m.role === 'activity' || m.role === 'switch' ? { meta: m.meta } : {}),
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
        })),
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
        if (!descriptor.kinds.includes(kind)) {
          res.status(400).json({ error: `${descriptor.name} can't run a ${kind} thread.` });
          return;
        }
      }
      const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 120) : kind === 'workshop' ? DEFAULT_WORKSHOP_TITLE : DEFAULT_GENERAL_TITLE;
      const thread = await createThread(db, orgId, projectId, { kind, title, ...(agent ? { agent: agent as AgentId } : {}) });
      res.status(201).json({ thread: { id: thread.id, kind: thread.kind, title: thread.title, agent: thread.agent } });
    }),
  );

  /** Rename, archive, or change who is answering. */
  router.patch(
    '/api/threads/:threadId',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const threadId = req.params.threadId ?? '';
      const body = (req.body ?? {}) as { title?: unknown; archived?: unknown; agent?: unknown };

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
        });
        return;
      }

      const thread = await getThread(db, orgId, threadId);
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      res.json({ thread: { id: thread.id, kind: thread.kind, title: thread.title, agent: thread.agent, archived: thread.archivedAt !== null } });
    }),
  );

  /** Say something in a thread. Workshop threads build; general threads answer. */
  router.post(
    '/api/threads/:threadId/message',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const body = (req.body ?? {}) as { text?: unknown; mode?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'say what you want' });
        return;
      }

      if (thread.kind === 'general') {
        const provider = chatProviderFor(thread.agent as AgentId);
        const fuel = provider ? await resolveFuelFor(db, orgId, provider).catch(() => null) : null;
        // The turn runs in the background like every other turn, so a slow
        // model never holds the composer.
        void chatTurn(db, orgId, thread, text, { client: fuel?.client ?? null }).catch((err) => {
          console.error(`chat turn failed for ${orgId}/${thread.id}:`, err);
        });
        res.status(202).json({ started: true, warming: false });
        return;
      }

      const mode = body.mode === undefined || body.mode === 'build' ? 'build' : body.mode === 'plan' ? 'plan' : null;
      if (mode === null) {
        res.status(400).json({ error: "mode must be 'build' or 'plan'" });
        return;
      }
      const resolved = await configFor(db, orgId, thread.projectId, env);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      if (await activeRun(orgId, thread.projectId)) {
        res.status(409).json({ error: "I'm already working on this project — let me finish that first." });
        return;
      }

      // A handover parked by a switch is spent here, on the first message after
      // it — marked spent only once the turn has actually been handed it, so a
      // failed start never silently eats the handover.
      const handoff = await pendingHandoff(db, orgId, thread.id).catch(() => null);
      const build = await getBuild(db, orgId, thread.projectId);
      const agent = thread.agent as AgentId;

      void runTurn(
        db,
        orgId,
        thread.projectId,
        text,
        { ...resolved.cfg, agent, ...(thread.model && agent === 'claude-code' ? { model: thread.model } : {}) },
        { mode, threadId: thread.id, ...(handoff ? { handoff: handoff.text } : {}) },
      ).catch(async (err) => {
        console.error(`thread turn failed to start for ${orgId}/${thread.id}:`, err);
        await db
          .insert(agentMessages)
          .values({
            id: ulid(),
            orgId,
            projectId: thread.projectId,
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
