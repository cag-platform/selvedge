import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { appleRuntimeHosts, appleRuntimeJobs, companionTokens, orgs } from '../../src/server/db/schema/index.js';
import {
  assignedAppleRuntimeJob, availableAppleRuntime, checkAppleRuntimeRegistration, claimAppleRuntimeJob, connectAppleRuntime,
  disconnectAppleRuntime, finishAppleRuntimeJob, heartbeatAppleRuntime, queueAppleChatTurn, queueAppleRuntimeTest,
  storeAppleWorkspaceCheckpoint,
} from '../../src/server/companion/appleRuntime.js';
import { getBuild } from '../../src/server/build/store.js';

const orgId = 'org_apple_runtime_test';
const tokenId = 'token_apple_runtime_test';
const registration = {
  name: 'Greg’s Mac', xcodeVersion: 'Xcode 18.0\nBuild version 18A1', macosVersion: '16.0',
  capabilities: { xcode: true as const, iosSimulator: true as const },
};

describe('Apple runtime connection', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const test = await createTestDb();
    db = test.db;
    close = test.close;
    await db.insert(orgs).values({ orgId });
    await db.insert(companionTokens).values({ id: tokenId, orgId, name: 'test Mac', tokenHash: 'apple-runtime-test-hash' });
  });
  afterEach(async () => close());

  it('accepts only an Xcode and Simulator-capable Mac', () => {
    expect(checkAppleRuntimeRegistration(registration)).toEqual(registration);
    expect(checkAppleRuntimeRegistration({ ...registration, capabilities: { xcode: true } })).toBeNull();
  });

  it('connects, heartbeats and explicitly disconnects a Mac', async () => {
    const connected = await connectAppleRuntime(db, orgId, tokenId, registration);
    expect(connected.name).toBe('Greg’s Mac');
    expect((await availableAppleRuntime(db, orgId))?.id).toBe(connected.id);
    expect(await heartbeatAppleRuntime(db, orgId, tokenId)).not.toBeNull();
    await disconnectAppleRuntime(db, orgId, tokenId);
    expect(await availableAppleRuntime(db, orgId)).toBeNull();
  });

  it('moves a bounded toolchain test through the connected Mac', async () => {
    const host = await connectAppleRuntime(db, orgId, tokenId, registration);
    const queued = await queueAppleRuntimeTest(db, orgId);
    expect(queued?.state).toBe('queued');
    const claimed = await claimAppleRuntimeJob(db, orgId, tokenId);
    expect(claimed).toMatchObject({ id: queued?.id, hostId: host.id, state: 'running', kind: 'toolchain_check' });
    const finished = await finishAppleRuntimeJob(db, orgId, tokenId, claimed!.id, {
      ok: true, xcodeVersion: 'Xcode 18', macosVersion: '16.0', simulatorName: 'iPhone 18',
    });
    expect(finished?.state).toBe('succeeded');
    const [stored] = await db.select().from(appleRuntimeJobs).where(eq(appleRuntimeJobs.id, claimed!.id));
    expect(stored?.result).toMatchObject({ simulatorName: 'iPhone 18' });
  });

  it('hands a selected coding agent a bounded chat turn and saves its returned workspace', async () => {
    await connectAppleRuntime(db, orgId, tokenId, registration);
    const request = {
      version: 1 as const, runId: 'run_apple', threadId: 'thread_apple', repoFullName: 'cag-platform/ducky',
      branch: 'main', emptyRepo: false, agent: 'codex' as const, model: 'gpt-5.6-terra', prompt: 'Build the SwiftUI screen.',
    };
    const queued = await queueAppleChatTurn(db, orgId, 'ducky', request);
    expect(queued).toMatchObject({ kind: 'chat_turn', state: 'queued', projectId: 'ducky', request });
    const claimed = await claimAppleRuntimeJob(db, orgId, tokenId);
    expect((await assignedAppleRuntimeJob(db, orgId, tokenId, claimed!.id))?.id).toBe(claimed!.id);

    const archive = Buffer.from('bounded workspace checkpoint');
    await storeAppleWorkspaceCheckpoint(db, orgId, 'ducky', request.runId, request.threadId, request.agent, archive);
    expect(await getBuild(db, orgId, 'ducky')).toMatchObject({
      checkpointBytes: archive.byteLength, stagedChangesReady: true, dirtyRunId: request.runId,
      dirtyThreadId: request.threadId, dirtyAgent: 'codex', sandboxId: null,
    });
    const finished = await finishAppleRuntimeJob(db, orgId, tokenId, claimed!.id, {
      ok: true, narrative: 'Built the SwiftUI screen.', changedPaths: ['Ducky/App.swift'], simulatorName: 'iPhone 18',
    });
    expect(finished).toMatchObject({ state: 'succeeded', result: { narrative: 'Built the SwiftUI screen.' } });
  });
});
