import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {createTestDb,type TestDb} from '../helpers/testDb.js';
import {distributionHypotheses,distributionPrograms} from '../../src/server/db/schema/index.js';
import {createOpportunity,ensureSelvedgeDistributionProgram,ingestSignal,transitionOpportunity} from '../../src/server/distribution/store.js';
import {planDistributionDay} from '../../src/server/distribution/planner.js';
import {DISTRIBUTION_SCOPE} from '../../src/server/distribution/domain.js';

describe('distribution planner',()=>{let db:TestDb,close:()=>Promise<void>;
 beforeEach(async()=>{const t=await createTestDb();db=t.db;close=t.close;await ensureSelvedgeDistributionProgram(db);});afterEach(async()=>close());
 async function ready(platform:string,hypothesis:string,key:string){const signal=(await ingestSignal(db,{provider:'test',platform,content:`Pain conversation ${key}`,rawPayload:{},dedupeKey:key,publishedAt:new Date()})).signal;const [h]=await db.select().from(distributionHypotheses).where(and(eq(distributionHypotheses.orgId,DISTRIBUTION_SCOPE),eq(distributionHypotheses.code,hypothesis)));const row=await createOpportunity(db,{signalId:signal.id,hypothesisId:h!.id,opportunityType:'CONVERSATION',audienceType:'FOUNDER',problemSummary:'Current pain',intentType:'PAIN',scores:{fit:95,intent:95,freshness:95,audience:95,engagement:95},reasoning:'Direct, current problem with enough context to help.',recommendedActionType:'REPLY'});await transitionOpportunity(db,row.id,'READY');return row;}
 it('preserves exploration and explains every allocation',async()=>{await ready('reddit','H1','one');await ready('reddit','H2','two');const plan=await planDistributionDay(db);expect(plan.recommendations.some(x=>x.allocationType==='EXPLORATION')).toBe(true);for(const row of plan.recommendations){expect(row.whyOpportunity).toBeTruthy();expect(row.whyHypothesis).toBeTruthy();expect(row.whyChannel).toBeTruthy();expect(row.evidence).toContain('Smoothed');}});
 it('obeys daily and platform caps from explicit policy',async()=>{await db.update(distributionPrograms).set({policy:{daily_action_cap:2,per_platform_action_cap:1,minimum_opportunity_score:75,maximum_risk:40,allowed_channels:{reddit:true,twitter:true,hackernews:false},hypothesis_allocation:{H1:2,H2:2,EXPLORATION:1}}}).where(eq(distributionPrograms.orgId,DISTRIBUTION_SCOPE));await ready('reddit','H1','r1');await ready('reddit','H2','r2');await ready('twitter','H2','x1');await ready('hackernews','H1','hn1');const plan=await planDistributionDay(db);expect(plan.recommendations).toHaveLength(2);expect(plan.recommendations.filter(x=>x.platform==='reddit')).toHaveLength(1);expect(plan.recommendations.some(x=>x.platform==='hackernews')).toBe(false);});
});
