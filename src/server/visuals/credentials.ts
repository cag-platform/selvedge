import type { Db } from '../db/client.js';
import { useCredentialWithKind } from '../connectors/credentials/store.js';

export async function imageApiKeyFor(db: Db, orgId: string): Promise<string | null> {
  const connected = await useCredentialWithKind(db, orgId, 'openai');
  if (connected && connected.kind !== 'subscription') return connected.secret;
  return process.env.OPENAI_API_KEY?.trim() || null;
}
