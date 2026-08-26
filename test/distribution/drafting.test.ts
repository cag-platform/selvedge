import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {batchEligible,draftOpportunity,responseModes} from '../../src/server/distribution/drafting.js';
import {canTransitionOpportunity} from '../../src/server/distribution/domain.js';
import {createOpportunity,ensureSelvedgeDistributionProgram,transitionOpportunity} from '../../src/server/distribution/store.js';
import {createTestDb,type TestDb} from '../helpers/testDb.js';
import type {LlmClient} from '../../src/server/llm/types.js';
import {distributionDrafts,distributionOpportunities} from '../../src/server/db/schema/index.js';
import {eq} from 'drizzle-orm';

describe('distribution drafting rules',()=>{
  it('defaults the safe review path to help and point of view modes',()=>{expect(responseModes.slice(0,2)).toEqual(['HELP_ONLY','POINT_OF_VIEW']);});
  it('permits the drafting lifecycle without treating approval as posting',()=>{expect(canTransitionOpportunity('READY','DRAFTED')).toBe(true);expect(canTransitionOpportunity('DRAFTED','APPROVED')).toBe(true);expect(canTransitionOpportunity('APPROVED','ACTED')).toBe(true);expect(canTransitionOpportunity('DRAFTED','ACTED')).toBe(false);});
  it('batch-approves only high-score low-risk help-first drafts',()=>{expect(batchEligible({overallScore:90,riskScore:10},{responseMode:'HELP_ONLY'})).toBe(true);expect(batchEligible({overallScore:90,riskScore:10},{responseMode:'DIRECT_PRODUCT_MENTION'})).toBe(false);expect(batchEligible({overallScore:84,riskScore:10},{responseMode:'POINT_OF_VIEW'})).toBe(false);expect(batchEligible({overallScore:90,riskScore:21},{responseMode:'POINT_OF_VIEW'})).toBe(false);});
});

describe('draft persistence and guardrails',()=>{let db:TestDb,close:()=>Promise<void>;beforeEach(async()=>{const t=await createTestDb();db=t.db;close=t.close;await ensureSelvedgeDistributionProgram(db);});afterEach(async()=>close());
  const llm=(responseMode:string,body:string):LlmClient=>({complete:async()=>({ok:true,json:{response_mode:responseMode,body},tokensIn:1,tokensOut:1,model:'fake',provider:'test'})});
  async function ready(){const o=await createOpportunity(db,{opportunityType:'CONVERSATION',audienceType:'DEVELOPER',problemSummary:'Context is lost',intentType:'PAIN',scores:{fit:90,intent:90,freshness:90,audience:90,engagement:90},reasoning:'Specific current pain',recommendedActionType:'REPLY'});await transitionOpportunity(db,o.id,'READY');return o;}
  it('preserves the initial draft separately and records model/prompt metadata',async()=>{const o=await ready();const d=await draftOpportunity(db,llm('HELP_ONLY','Start by writing down the decision and its constraints.'),o.id);expect(d.initialBody).toBe(d.body);expect(d.finalBody).toBeNull();expect(d.editedByHuman).toBe(false);expect(d.promptVersion).toBe('greg-voice-v1');expect((await db.select().from(distributionOpportunities).where(eq(distributionOpportunities.id,o.id)))[0]?.state).toBe('DRAFTED');expect(await db.select().from(distributionDrafts)).toHaveLength(1);});
  it('rejects a forced product mention when classification says it is inappropriate',async()=>{const o=await ready();await expect(draftOpportunity(db,llm('DIRECT_PRODUCT_MENTION','Use Selvedge.'),o.id)).rejects.toThrow('inappropriate product mention');expect(await db.select().from(distributionDrafts)).toHaveLength(0);});
});
