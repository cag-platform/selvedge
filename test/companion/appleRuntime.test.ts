import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { appleRuntimeHosts, companionTokens, orgs } from '../../src/server/db/schema/index.js';
import {
  availableAppleRuntime, checkAppleRuntimeRegistration, connectAppleRuntime,
  disconnectAppleRuntime, heartbeatAppleRuntime,
} from '../../src/server/companion/appleRuntime.js';

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
});
