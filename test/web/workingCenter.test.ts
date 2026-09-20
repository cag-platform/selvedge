import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb } from '../helpers/testDb.js';
import type { Db } from '../../src/server/db/client.js';
import { agentMessages, projectBuild } from '../../src/server/db/schema/index.js';
import { createProjectsRouter } from '../../src/server/web/routes/projects.js';
import { appWithOrg } from './helpers.js';
import { createRun, recordRunEvent } from '../../src/server/workspace/coordinator.js';
import { compileTaskContext } from '../../src/server/context/compiler.js';

describe('Working Center API and context handoff', () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let runId: string;
  beforeEach(async () => {
    fixture = await createTestDb(); db = fixture.db as unknown as Db;
    const { run } = await createRun(db, { orgId: 'org', projectId: 'project', threadId: 'thread', requestKey: 'request', capsuleId: 'frozen', prompt: 'Build', agent: 'codex' });
    runId = run.id;
    await recordRunEvent(db, 'org', runId, { key: 'starting', kind: 'starting', source: 'coordinator' });
    await recordRunEvent(db, 'org', runId, { key: 'working', kind: 'activity', source: 'agent' });
  });
  afterEach(async () => fixture.close());
  it('replays authoritative events in sequence and denies another organization', async () => {
    const app = appWithOrg('org', createProjectsRouter(db));
    const path = `/api/projects/project/runs/${runId}/events`;
    const first = await request(app).get(path);
    const reopened = await request(app).get(path);
    expect(first.body.events.map((e: { sequence: number }) => e.sequence)).toEqual([1, 2, 3]);
    expect(reopened.body).toEqual(first.body);
    expect((await request(appWithOrg('other', createProjectsRouter(db))).get(path)).status).toBe(404);
  });
  it('records owner acceptance exactly once and refreshes context without promoting the opinion to knowledge', async () => {
    const app = appWithOrg('org', createProjectsRouter(db));
    await db.insert(agentMessages).values({ id: 'gpt-answer', orgId: 'org', projectId: 'project', threadId: 'thread', role: 'agent', content: 'Use an idempotency key.', meta: { answered_by: 'gpt', consultation_id: 'compare' } });
    const before = await compileTaskContext(db, { orgId: 'org', projectId: 'project', threadId: 'thread', userRequest: 'Compare suggestions' });
    const path = `/api/projects/project/runs/${runId}/respond`;
    const body = { text: 'Accept this suggestion.', accepted_answer_id: 'gpt-answer' };
    expect((await request(app).post(path).set('Idempotency-Key', 'accept-once').send(body)).body.execution_resumed).toBe(false);
    expect((await request(app).post(path).set('Idempotency-Key', 'accept-once').send(body)).status).toBe(200);
    const after = await compileTaskContext(db, { orgId: 'org', projectId: 'project', threadId: 'thread', userRequest: 'Continue building' });
    expect(before.known_already.accepted_decisions).toHaveLength(0);
    expect(after.known_already.accepted_decisions).toHaveLength(1);
    expect(after.known_already.graduated_project_knowledge).toHaveLength(0);
    expect(after.observed_now.referenced_prior_answers.some(f => f.reference === 'gpt-answer')).toBe(true);
    expect(after.capsule_id).not.toBe(before.capsule_id);
    expect((await db.select().from(projectBuild))[0].sandboxId).toBeNull();
  });
  it('does not report unsupported recovery as a live or replacement process', async () => {
    const app = appWithOrg('org', createProjectsRouter(db));
    const res = await request(app).post(`/api/projects/project/runs/${runId}/recover`);
    expect(res.status).toBe(200);
    expect(res.body.observation.state).toBe('unknown');
    expect((await db.select().from(projectBuild))[0].leaseOwner).toBe(runId);
  });
});
