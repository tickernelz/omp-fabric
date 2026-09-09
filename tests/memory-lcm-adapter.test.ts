import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LcmLedger } from "../src/storage/lcm-ledger.js";
import { openLedger, releaseTemp, tempRoot } from "./fixtures/lcm-temp.js";
import { LcmMemoryAdapter, type LcmSummaryNode } from "../src/memory/lcm-adapter.js";

const capability = (ledger: LcmLedger) => ({
  projectKey: ledger.project.key,
  readRaw: (sessionId?: string) => ledger.readRaw(ledger.project.key, sessionId),
  readRawPage: (sessionId?: string, offset?: number, limit?: number) => ledger.readRawPage(ledger.project.key, sessionId, offset, limit),
  readRawEntry: (sessionId: string, entryId: string, revision: number) => ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision),
});

afterEach(releaseTemp);

describe("LCM memory retrieval",()=>{
 it("does not expose a mutable database capability",()=>{const d=tempRoot("lcm-memory-");const ledger=openLedger({dbPath:path.join(d,"a.sqlite"),project:{liveCwd:d}});const adapter=new LcmMemoryAdapter({ledger: capability(ledger),summaries:{listNodes:()=>[],getNode:()=>undefined}}); expect("db" in (adapter as unknown as {options:{ledger:Record<string,unknown>}}).options.ledger).toBe(false); expect("readOnly" in (adapter as unknown as {options:{ledger:Record<string,unknown>}}).options.ledger).toBe(false); });
 it("merges bounded raw and ready summary hits deterministically",()=>{const d=tempRoot("lcm-memory-");const ledger=openLedger({dbPath:path.join(d,"a.sqlite"),project:{liveCwd:d}});const raw=ledger.appendRaw({projectKey:ledger.project.key,sessionId:"s",entryId:"e",role:"user",content:"alpha exact",payloadJson:JSON.stringify({type:"message",id:"e",parentId:null,timestamp:"2026-01-01T00:00:00.000Z",message:{role:"user",content:[{type:"text",text:"alpha exact"}]}})});const node:LcmSummaryNode={nodeId:"n",projectKey:ledger.project.key,sessionId:"s",branch:null,sourceHash:"summary-hash",state:"ready",text:"alpha summary",children:[],sources:[{entryId:raw.entryId,revision:raw.revision,contentHash:raw.contentHash}],createdAt:1};const adapter=new LcmMemoryAdapter({ledger: capability(ledger),currentSessionId:"s",branchForSession:()=>({activeSourceKeys:[`s:e:${raw.revision}`],ready:true}),summaries:{listNodes:()=>[node],getNode:id=>id==="n"?node:undefined}});const result=adapter.recall({query:"alpha",pageSize:1});expect(result.total).toBe(2);expect(result.hits[0]?.kind).toBe("lcm.raw");expect(result.next?.args.offset).toBe(1);const expanded=adapter.expand(result.hits[0]!.follow.args);expect((expanded.entries as Array<{text:string}>)[0]?.text).toContain("alpha exact");});
 it("reports incomplete coverage and stale pointers",()=>{const d=tempRoot("lcm-memory-");const ledger=openLedger({dbPath:path.join(d,"a.sqlite"),project:{liveCwd:d}});const adapter=new LcmMemoryAdapter({ledger: capability(ledger),currentSessionId:"s",branchForSession:()=>({activeSourceKeys:[],ready:true}),summaries:{listNodes:()=>[{nodeId:"n",projectKey:ledger.project.key,sessionId:"s",branch:null,sourceHash:"h",state:"failed",text:"alpha",children:[],sources:[],createdAt:1}],getNode:()=>undefined}});const result=adapter.recall({query:"no-match"});expect(result.hits).toHaveLength(0);expect(result.coverage.complete).toBe(false);expect(result.coverage.reasons).toContain("summary_failed");expect(adapter.expand({session:"lcm.raw:s:e:1"})).toMatchObject({error:{code:"stale_pointer"}});});
});
