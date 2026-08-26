import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, generatedVisuals, orgs } from '../../src/server/db/schema/index.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import { runVisualJob, type VisualRenderer } from '../../src/server/visuals/render.js';
import type { VisualObjectStore } from '../../src/server/visuals/storage.js';

describe('a directed visual job', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const test = await createTestDb(); db = test.db; close = test.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('stores pixels in object storage and a signed, attributed message in the consultation', async () => {
    const puts: Array<{ key: string; bytes: number; mime: string }> = [];
    const objectStore: VisualObjectStore = {
      put: async (key, bytes, mime) => { puts.push({ key, bytes: bytes.byteLength, mime }); },
      signedGet: async () => 'https://signed.test/image',
      delete: async () => undefined,
    };
    const renderer: VisualRenderer = { render: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 1024, height: 1024, model: 'image-test' }) };
    const director = new FakeLlmClient((request) => ({
      ok: true, json: { reply: 'I made this quieter and more editorial.', render_prompt: 'editorial brass checkout card' },
      tokensIn: 10, tokensOut: 20, model: request.model,
    }));

    await runVisualJob(db, 'org_1', {
      threadId: 'thread_1', consultationId: 'consult_1', promptId: 'prompt_1', directingAgent: 'claude',
      directingModel: 'claude-sonnet-5', request: 'give me a visual', director, renderer, objectStore,
    });

    expect(puts).toEqual([{ key: expect.stringMatching(/^generated\/org_1\/.+\.png$/), bytes: 3, mime: 'image/png' }]);
    const [visual] = await db.select().from(generatedVisuals).where(eq(generatedVisuals.orgId, 'org_1'));
    expect(visual).toMatchObject({ status: 'ready', directingAgent: 'claude', width: 1024, bytes: 3 });
    const [reply] = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, 'org_1'), eq(agentMessages.role, 'agent')));
    expect(reply?.meta).toMatchObject({ answered_by: 'claude', consultation_id: 'consult_1', in_reply_to: 'prompt_1', visual_id: visual!.id });
  });

  it('records a renderer failure without writing a false completed reply', async () => {
    const director = new FakeLlmClient((request) => ({ ok: true, json: { reply: 'x', render_prompt: 'x' }, tokensIn: 1, tokensOut: 1, model: request.model }));
    await runVisualJob(db, 'org_1', {
      threadId: 'thread_1', promptId: 'prompt_1', directingAgent: 'gpt', directingModel: 'gpt-5.6-terra', request: 'visual', director,
      renderer: { render: async () => { throw new Error('renderer down'); } },
      objectStore: { put: async () => undefined, signedGet: async () => '', delete: async () => undefined },
    });
    const [visual] = await db.select().from(generatedVisuals);
    expect(visual).toMatchObject({ status: 'failed', error: 'renderer down' });
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });
});
