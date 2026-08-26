import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js'; import type { LlmClient } from '../llm/types.js';
import { distributionHypotheses, distributionOpportunities, distributionSignals } from '../db/schema/index.js';
import { CLASSIFIER_VERSION, classifyConversation, freshnessScore } from './classifier.js'; import { DISTRIBUTION_SCOPE, overallScore } from './domain.js'; import { SELVEDGE_PROGRAM_ID } from './store.js'; import { ulid } from 'ulid';

export async function processDistributionSignals(db: Db, llm: LlmClient, limit = 100) {
  const signals = await db.select().from(distributionSignals).where(and(eq(distributionSignals.orgId,DISTRIBUTION_SCOPE),eq(distributionSignals.processingStatus,'NEW'))).limit(limit);
  let ready=0,rejected=0,failed=0;
  for (const signal of signals) { try {
    const answer=await classifyConversation(llm,{platform:signal.platform,content:signal.content,publishedAt:signal.publishedAt,authorName:signal.authorName}); const c=answer.classification; const fresh=freshnessScore(signal.publishedAt);
    const score=overallScore({fit:c.fit_score,intent:c.intent_score,freshness:fresh,audience:c.audience_score,engagement:c.actionability_score});
    const strong=c.relevant&&c.recommended_action==='REPLY'&&c.can_help_without_pitching&&c.risk_score<=40&&score>=75;
    if(strong){const [hyp]=c.hypothesis==='OTHER'?[]:await db.select().from(distributionHypotheses).where(and(eq(distributionHypotheses.programId,SELVEDGE_PROGRAM_ID),eq(distributionHypotheses.code,c.hypothesis))).limit(1);
      await db.insert(distributionOpportunities).values({id:ulid(),orgId:DISTRIBUTION_SCOPE,signalId:signal.id,programId:SELVEDGE_PROGRAM_ID,opportunityType:'CONVERSATION',hypothesisId:hyp?.id??null,audienceType:c.audience,problemSummary:c.problem_summary,intentType:c.intent,fitScore:c.fit_score,intentScore:c.intent_score,freshnessScore:fresh,audienceScore:c.audience_score,engagementScore:c.actionability_score,actionabilityScore:c.actionability_score,riskScore:c.risk_score,canHelpWithoutPitching:c.can_help_without_pitching,productMentionAppropriate:c.product_mention_appropriate,scoringVersion:CLASSIFIER_VERSION,overallScore:score,reasoning:c.reasoning,recommendedActionType:c.recommended_action,state:'READY'}).onConflictDoNothing(); ready++; }
    else rejected++;
    await db.update(distributionSignals).set({processingStatus:strong?'OPPORTUNITY':'REJECTED',classification:{...c,overall_score:score,scoring_version:CLASSIFIER_VERSION,model:answer.model,provider:answer.provider},processedAt:new Date()}).where(eq(distributionSignals.id,signal.id));
  } catch { failed++; /* Leave NEW so a transient provider/model failure is retryable on the next run. */ }}
  return {processed:signals.length,ready,rejected,failed};
}
