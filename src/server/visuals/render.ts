import OpenAI from 'openai';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentMessages } from '../db/schema/index.js';
import type { LlmClient } from '../llm/types.js';
import { recordUsage } from '../llm/metering.js';
import { completeVisual, failVisual, queueVisual } from './store.js';
import { visualStorageKey, type VisualObjectStore } from './storage.js';
import { publishLiveChat } from '../chat/live.js';
import { beginVisualJob } from './live.js';

const DIRECTION_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    render_prompt: { type: 'string' },
  },
  required: ['reply', 'render_prompt'],
  additionalProperties: false,
};

export type RenderedImage = { bytes: Uint8Array; mime: string; width: number; height: number; model: string };
export type VisualRenderer = { render(prompt: string, signal?: AbortSignal): Promise<RenderedImage> };

export class OpenAIVisualRenderer implements VisualRenderer {
  private readonly client: OpenAI;
  constructor(apiKey: string, private readonly model = process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1') {
    this.client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 1 });
  }
  async render(prompt: string, signal?: AbortSignal): Promise<RenderedImage> {
    const result = await this.client.images.generate({ model: this.model, prompt, size: '1024x1024', output_format: 'png' }, { signal });
    const encoded = result.data?.[0]?.b64_json;
    if (!encoded) throw new Error('the image renderer returned no image');
    return { bytes: Buffer.from(encoded, 'base64'), mime: 'image/png', width: 1024, height: 1024, model: this.model };
  }
}

export async function runVisualJob(db: Db, orgId: string, input: {
  threadId: string;
  consultationId?: string;
  promptId: string;
  directingAgent: string;
  directingModel: string;
  request: string;
  director: LlmClient;
  renderer: VisualRenderer;
  objectStore: VisualObjectStore;
}) {
  const visual = await queueVisual(db, orgId, {
    threadId: input.threadId,
    ...(input.consultationId ? { consultationId: input.consultationId } : {}),
    directingAgent: input.directingAgent,
    renderingProvider: 'openai',
    renderingModel: process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1',
    request: input.request,
  });
  const turnId = ulid();
  const lifecycle = beginVisualJob(orgId, input.threadId);
  const live = { turnId, agent: input.directingAgent, ...(input.consultationId ? { consultationId: input.consultationId } : {}), capability: 'visual' as const };
  publishLiveChat(orgId, input.threadId, { type: 'reply_started', ...live });
  try {
    if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
    const directionStarted = Date.now();
    const direction = await input.director.complete({
      model: input.directingModel,
      maxTokens: 700,
      system: 'Interpret the visual request in your own design voice. Return a short explanation for the owner and a precise standalone image-generation prompt. Do not claim you rendered the pixels.',
      userContent: input.request,
      schema: DIRECTION_SCHEMA,
    });
    const directionMs = Date.now() - directionStarted;
    await recordUsage(db, orgId, 'chat', direction, undefined, input.threadId);
    if (!direction.ok) throw new Error(`art direction failed (${direction.reason})`);
    const json = direction.json as { reply?: unknown; render_prompt?: unknown };
    if (typeof json.reply !== 'string' || typeof json.render_prompt !== 'string') throw new Error('art direction was incomplete');
    if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
    const renderStarted = Date.now();
    const rendered = await input.renderer.render(json.render_prompt, lifecycle.signal);
    const renderMs = Date.now() - renderStarted;
    if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
    const key = visualStorageKey(orgId, visual.id, rendered.mime);
    const storageStarted = Date.now();
    await input.objectStore.put(key, rendered.bytes, rendered.mime);
    const storageMs = Date.now() - storageStarted;
    const messageId = ulid();
    await db.insert(agentMessages).values({
      id: messageId, orgId, threadId: input.threadId, role: 'agent', content: json.reply,
      meta: {
        answered_by: input.directingAgent,
        ...(input.consultationId ? { consultation_id: input.consultationId, in_reply_to: input.promptId } : {}),
        visual_id: visual.id,
      },
    });
    await completeVisual(db, orgId, visual.id, {
      messageId, renderPrompt: json.render_prompt, storageKey: key, mime: rendered.mime,
      width: rendered.width, height: rendered.height, bytes: rendered.bytes.byteLength,
      directionMs, renderMs, storageMs,
    });
    publishLiveChat(orgId, input.threadId, { type: 'reply_finished', ...live });
    return visual.id;
  } catch (error) {
    await failVisual(db, orgId, visual.id, lifecycle.signal.aborted ? 'Stopped by owner' : error instanceof Error ? error.message : 'visual generation failed');
    publishLiveChat(orgId, input.threadId, { type: 'reply_cancelled', ...live });
    return visual.id;
  } finally {
    lifecycle.done();
  }
}
