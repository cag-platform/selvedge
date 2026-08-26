import { z } from 'zod';
import type { LlmClient } from '../llm/types.js';

export const CLASSIFIER_VERSION = 'conversation-v1';
export const classificationSchema = z.object({
  relevant: z.boolean(), hypothesis: z.enum(['H1','H2','H3','H4','H5','OTHER']),
  audience: z.enum(['NONTECH_FOUNDER','TECHNICAL_FOUNDER','DEVELOPER','AGENCY','PRODUCT_TEAM','UNKNOWN']),
  intent: z.enum(['ACTIVE_SEARCH','PAIN','QUESTION','COMPETITOR_DISSATISFACTION','DISCUSSION','CASUAL_MENTION','PROMOTION','SPAM']),
  problem_summary: z.string().max(300), fit_score: z.number().int().min(0).max(100), intent_score: z.number().int().min(0).max(100),
  audience_score: z.number().int().min(0).max(100), actionability_score: z.number().int().min(0).max(100), risk_score: z.number().int().min(0).max(100),
  recommended_action: z.enum(['REPLY','OBSERVE','IGNORE']), reasoning: z.string().max(500), can_help_without_pitching: z.boolean(), product_mention_appropriate: z.boolean(),
});
export type ConversationClassification = z.infer<typeof classificationSchema>;

const jsonSchema = { type:'object', additionalProperties:false, required:Object.keys(classificationSchema.shape), properties: {
  relevant:{type:'boolean'}, hypothesis:{type:'string',enum:['H1','H2','H3','H4','H5','OTHER']}, audience:{type:'string',enum:['NONTECH_FOUNDER','TECHNICAL_FOUNDER','DEVELOPER','AGENCY','PRODUCT_TEAM','UNKNOWN']},
  intent:{type:'string',enum:['ACTIVE_SEARCH','PAIN','QUESTION','COMPETITOR_DISSATISFACTION','DISCUSSION','CASUAL_MENTION','PROMOTION','SPAM']}, problem_summary:{type:'string',maxLength:300},
  fit_score:{type:'integer',minimum:0,maximum:100}, intent_score:{type:'integer',minimum:0,maximum:100}, audience_score:{type:'integer',minimum:0,maximum:100}, actionability_score:{type:'integer',minimum:0,maximum:100}, risk_score:{type:'integer',minimum:0,maximum:100},
  recommended_action:{type:'string',enum:['REPLY','OBSERVE','IGNORE']}, reasoning:{type:'string',maxLength:500}, can_help_without_pitching:{type:'boolean'}, product_mention_appropriate:{type:'boolean'},
}};

export async function classifyConversation(llm: LlmClient, signal: { platform:string; content:string; publishedAt:Date|null; authorName:string|null }) {
  const result = await llm.complete({ model: process.env.DISTRIBUTION_CLASSIFIER_MODEL?.trim() || 'gpt-5.6-terra', maxTokens: 900, schema: jsonSchema,
    system: `You classify public conversations for Selvedge, a product that preserves software-project context, decisions, provenance, and continuity across AI coding agents. Reject aggressively. Generic AI enthusiasm, news, promotion, unrelated context, stale chatter, and socially inappropriate product insertion are not opportunities. Assess helping without pitching separately from whether mentioning the product is appropriate. Never inflate scores to fill a queue.`,
    userContent: JSON.stringify(signal), });
  if (!result.ok) throw new Error(`classifier failed: ${result.reason}`);
  const parsed = classificationSchema.safeParse(result.json); if (!parsed.success) throw new Error('classifier returned an invalid shape');
  return { classification: parsed.data, model: result.model, provider: result.provider ?? 'unknown' };
}

export function freshnessScore(publishedAt: Date | null, now = new Date()): number {
  if (!publishedAt) return 35; const hours = Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
  if (hours <= 6) return 100; if (hours <= 24) return 90; if (hours <= 72) return 70; if (hours <= 168) return 45; if (hours <= 720) return 20; return 0;
}
