import { Router, type Request } from 'express';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { agentMessages, agentMessageAttachments, agentRuns, llmUsage, threads } from '../../db/schema/index.js';
import { getPack, listPacks, mutedProjectIds } from '../../packs/store.js';
import { edgeStatus, hasHealthSignal, healthLine } from '../../packs/healthLine.js';
import { getBuild } from '../../build/store.js';
import { configFor, engineEnv, type EngineEnv } from '../../build/engineConfig.js';
import { runAgentTurn } from '../../build/agent.js';
import { failActiveRun, stopActiveRun } from '../../build/stopRun.js';
import { runChatTurn, chatProviderFor } from '../../chat/turn.js';
import { resolveFuelFor } from '../../connectors/fuel/resolve.js';
import { createSubjectThread, createThread, ensureWorkshopThread, fileThread, getThread, listThreads, renameThread, setThreadArchived } from '../../threads/store.js';
import { getSubject, listSubjects } from '../../threads/subjects.js';
import { setPlacePutAway } from '../../threads/putAway.js';
import { markHandoffSpent, pendingHandoff, switchThreadAgent } from '../../threads/switch.js';
import { agentRoster } from '../../threads/roster.js';
import { raiseCeiling, threadCeiling } from '../../threads/ceiling.js';
import { briefAsText, briefForThread, withFreshness } from '../../decisions/store.js';
import { staleWarningFor } from '../../decisions/freshness.js';
import { agentById, changesFiles, type AgentId } from '../../../shared/agents.js';
import { consultationLine, mentionIntent, MAX_CONSULTED } from '../../../shared/mentions.js';
import { referenceLine, type SearchScope } from '../../../shared/references.js';
import { boundDocuments } from '../../../shared/documents.js';
import { findRelatedConversations, listReferenceCandidates, renderReferences, resolveReferences } from '../../references/resolve.js';
import { isThreadKind, DEFAULT_GENERAL_TITLE, DEFAULT_WORKSHOP_TITLE, type ThreadKind } from '../../../shared/types/thread.js';
import { canStartBuild } from '../../billing/entitlements.js';
import { createProject } from '../../packs/create.js';
import type { StakesTier } from '../../../shared/types/pack.js';
import { refuse } from '../middleware/limit.js';

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
  /**
   * Make a fresh private repo for an idea that turned into a thing. Absent
   * when the deployment has no GITHUB_TOKEN — in which case "start a new one"
   * is not offered at all rather than offered and then refused.
   */
  createRepo?: (name: string, description: string) => Promise<{ fullName: string }>;
};

export function createThreadsRouter(db: Db, deps: ThreadsDeps = {}) {
  const router = Router();
  const runTurn = deps.runTurn ?? runAgentTurn;
  const chatTurn = deps.chatTurn ?? runChatTurn;
  const env = deps.env ?? engineEnv;
  // WIRED BY THE APP, never reached for here — the same way the packs router
  // gets it. A router that reaches into process.env for a capability is a
  // router that behaves differently in a test than in production, and this one
  // decides whether to offer somebody a real repo.
  const makeRepo = deps.createRepo;

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
      ]);
      const subjectName = thread.subjectId ? (await getSubject(db, orgId, thread.subjectId))?.name ?? null : null;

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
        // A thread belongs to a project or to a subject; the pane says which.
        project: thread.projectId ? { id: thread.projectId, name: pack?.identity.name ?? thread.projectId } : null,
        subject: thread.subjectId ? { id: thread.subjectId, name: subjectName ?? thread.subjectId } : null,
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
      if (!thread.projectId) {
        res.json({ stopped: false });
        return;
      }
      const outcome = await stopActiveRun(db, orgId, thread.projectId);
      res.json({ stopped: outcome.stopped });
    }),
  );

  /** Say something in a thread. Workshop threads build; general threads answer. */
  router.post(
    '/api/threads/:threadId/message',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      let thread = await getThread(db, orgId, req.params.threadId ?? '');
      if (!thread) {
        res.status(404).json({ error: 'no such thread' });
        return;
      }
      const body = (req.body ?? {}) as { text?: unknown; mode?: unknown; documents?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'say what you want' });
        return;
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
              // Nothing here. Whatever the wider search turns up is a weaker
              // claim, and the line will say so.
              scope.widened = true;
            }
            return findRelatedConversations(db, orgId, text, { excludeThreadId: thread.id }).catch(() => []);
          })();
      const references = { resolved: [...named.resolved, ...found], missed: named.missed };
      const referenced = renderReferences(references);
      const referenceNote = references.resolved.length
        ? referenceLine(
            references.resolved.map((r) => ({ label: r.label, ...(r.note ? { note: r.note } : {}), ...(r.found ? { found: true } : {}) })),
            scope,
          )
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
        await db.insert(agentMessages).values([
          {
            id: ulid(),
            orgId,
            projectId: thread.projectId,
            threadId: thread.id,
            role: 'owner',
            content: text,
            ...(documents.length ? { meta: { documents } } : {}),
          },
          {
            id: ulid(),
            orgId,
            projectId: thread.projectId,
            threadId: thread.id,
            role: 'switch',
            content: consultationLine(asked, (id) => agentById(id)?.name ?? id, skipped),
            meta: { consulted: asked, ...(skipped.length ? { skipped } : {}) },
          },
          ...(referenceNote
            ? [{ id: ulid(), orgId, projectId: thread.projectId, threadId: thread.id, role: 'switch', content: referenceNote }]
            : []),
        ]);

        const consulted = thread;
        for (const agent of asked) {
          const provider = agentById(agent)?.provider ?? null;
          const fuel = provider ? await resolveFuelFor(db, orgId, provider).catch(() => null) : null;
          void chatTurn(db, orgId, consulted, text, {
            client: fuel?.client ?? null,
            recordOwnerMessage: false,
            ...(documents.length ? { documents } : {}),
            answeringAs: agent,
            asTake: true,
          }).catch((err) => {
            console.error(`take from ${agent} failed for ${orgId}/${consulted.id}:`, err);
          });
        }
        res.status(202).json({ started: true, warming: false, consulted: asked });
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
        const provider = chatProviderFor(thread.agent as AgentId);
        const fuel = provider ? await resolveFuelFor(db, orgId, provider).catch(() => null) : null;
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

      const mode = body.mode === undefined || body.mode === 'build' ? 'build' : body.mode === 'plan' ? 'plan' : null;
      if (mode === null) {
        res.status(400).json({ error: "mode must be 'build' or 'plan'" });
        return;
      }
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
      const resolved = await configFor(db, orgId, buildIn, env);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      if (await activeRun(orgId, buildIn)) {
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
      void runTurn(
        db,
        orgId,
        projectId,
        text,
        { ...resolved.cfg, agent, ...(thread.model && agent === 'claude-code' ? { model: thread.model } : {}) },
        {
          mode,
          threadId: thread.id,
          // One seam for "start this agent with this context", whether the
          // context is a handover from another agent, the decision this work
          // exists to carry out, or another project the owner pointed at.
          ...(handoff || decisionPreamble || referenced
            ? { handoff: [decisionPreamble, referenced, handoff?.text].filter(Boolean).join('\n\n---\n\n') }
            : {}),
          ...(referenceNote ? { referenceNote } : {}),
          ...(documents.length ? { documents } : {}),
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
