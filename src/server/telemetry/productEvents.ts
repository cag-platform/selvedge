import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { productEvents } from '../db/schema/index.js';

export type ProductSurface = 'desktop_web' | 'responsive_web' | 'ios_native' | 'unknown';

export async function recordProductEvent(
  db: Db,
  orgId: string,
  name: string,
  fields: { surface?: ProductSurface; continuationId?: string; projectId?: string | null; threadId?: string | null; properties?: Record<string, string | number | boolean | null> } = {},
): Promise<void> {
  await db.insert(productEvents).values({
    id: ulid(), orgId, name, surface: fields.surface ?? 'unknown', continuationId: fields.continuationId ?? null,
    projectId: fields.projectId ?? null, threadId: fields.threadId ?? null, properties: fields.properties ?? {},
  });
}
