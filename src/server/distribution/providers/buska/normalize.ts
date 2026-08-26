import { createHash } from 'node:crypto';
import type { BuskaMention } from './client.js';

export function normalizeBuskaMention(mention: BuskaMention, fallbackPlatform: string, keyword: string) {
  const content = typeof mention.contentPreview === 'string' ? mention.contentPreview : '';
  const url = typeof mention.postUrl === 'string' ? mention.postUrl : null;
  const fingerprint = url ?? JSON.stringify([mention.channel ?? fallbackPlatform, mention.name ?? '', content, mention.publishedAt ?? '']);
  return {
    provider: 'buska', providerExternalId: url, platform: typeof mention.channel === 'string' ? mention.channel : fallbackPlatform,
    url, authorName: typeof mention.name === 'string' ? mention.name : null, authorHandle: typeof mention.link === 'string' ? mention.link : null,
    content, publishedAt: typeof mention.publishedAt === 'string' && !Number.isNaN(Date.parse(mention.publishedAt)) ? new Date(mention.publishedAt) : null,
    rawPayload: { ...mention, selvedgeSearchKeyword: keyword }, dedupeKey: `buska:${createHash('sha256').update(fingerprint).digest('hex')}`,
  };
}
