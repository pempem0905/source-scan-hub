import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const APIFY_BASE = "https://api.apify.com/v2";
const ONE_SHOT = "9sTcuUbRnSlKRewYEhJ9TNdxoGqpaN24";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";
const RADAR_TYPES = new Set(["AFFILIATE_NETWORK","AFFILIATE_PUBLISHER","COUPON_AGGREGATOR","DEAL_AGGREGATOR","BLOG"]);

function secret(name:string){ const v=process.env[name]; if(!v) throw new Error(`${name} missing`); return v; }
async function apify(path:string, init:RequestInit={}){
  const res=await fetch(`${APIFY_BASE}${path}`,{...init,headers:{authorization:`Bearer ${secret("APIFY_TOKEN")}`,accept:"application/json","content-type":"application/json",...(init.headers??{})}});
  const text=await res.text(); let p:any; try{p=JSON.parse(text)}catch{p={raw:text}};
  if(!res.ok) throw new Error(`Apify ${path} ${res.status}: ${text.slice(0,1200)}`); return p.data??p;
}

async function backfillFromMasterDataset(){
  const datasets=await apify("/datasets?limit=1000");
  const dataset=(datasets.items??[]).find((d:any)=>d.name==="source-scan-native-master-events-v1");
  if(!dataset) return {datasetFound:false,scanned:0,eligible:0,inserted:0};
  const {data:lastRows}=await supabaseAdmin.from("sources").select("created_at").order("created_at",{ascending:false}).limit(1);
  const cutoffMs=new Date(lastRows?.[0]?.created_at??0).getTime()-5*60_000;
  const map=new Map<string,any>(); let scanned=0;
  for(let offset=0;offset<30000;offset+=1000){
    const items=await apify(`/datasets/${encodeURIComponent(dataset.id)}/items?clean=true&format=json&limit=1000&offset=${offset}&desc=1`);
    if(!Array.isArray(items)||!items.length) break;
    scanned+=items.length;
    let oldest=Date.now();
    for(const item of items){
      const t=new Date(item?.at??0).getTime(); if(Number.isFinite(t)) oldest=Math.min(oldest,t);
      if(t<cutoffMs) continue;
      if(!["MASTER_SOURCE_ADDED","MASTER_SOURCE_MIGRATED"].includes(String(item?.event??""))) continue;
      if(typeof item?.url!=="string"||!item.url.startsWith("http")) continue;
      map.set(item.url,item);
    }
    if(oldest<cutoffMs) break;
  }
  const records=[...map.values()]; let inserted=0;
  for(let i=0;i<records.length;i+=300){
    const chunk=records.slice(i,i+300); const urls=chunk.map((r:any)=>r.url);
    const {data:existing,error:readErr}=await supabaseAdmin.from("sources").select("normalized_url").in("normalized_url",urls);
    if(readErr) throw readErr;
    const have=new Set((existing??[]).map((r:any)=>r.normalized_url));
    const rows=chunk.filter((r:any)=>!have.has(r.url)).map((r:any)=>{
      const type=String(r.sourceType??"BRAND_OFFICIAL"); const radar=RADAR_TYPES.has(type); const at=r.at??new Date().toISOString();
      return {domain:r.domain??new URL(r.url).hostname.replace(/^www\./,""),url:r.url,normalized_url:r.url,canonical_url:r.url,canonical_domain:r.domain??new URL(r.url).hostname.replace(/^www\./,""),source_type:type,market:"VN",status:"verified",authority_score:Number(r.authorityScore??(radar?40:100)),discovered_via:`apify_native_backfill:${r.discoveredVia??"native"}`,discovered_at:at,verified_at:at,last_scan_at:at,is_official:!radar,is_radar:radar,resolution_status:"resolved",http_status:Number(r.httpStatus??200),error_count:0,yield_score:0,notes:r.notes??null,created_at:at,updated_at:new Date().toISOString()};
    });
    if(rows.length){ const {error}=await supabaseAdmin.from("sources").insert(rows); if(error) throw error; inserted+=rows.length; }
  }
  return {datasetFound:true,scanned,eligible:records.length,inserted};
}

export const Route=createFileRoute("/api/temp-sync-apify-display")({server:{handlers:{POST:async({request})=>{
  try{
    if(request.headers.get("x-one-shot")!==ONE_SHOT) return Response.json({ok:false},{status:401});
    const bodyIn=await request.json().catch(()=>({})) as any;
    const [schedules,actors,limits,queues,stores]=await Promise.all([apify("/schedules?limit=1000"),apify("/acts?limit=1000"),apify("/users/me/limits"),apify("/request-queues?limit=1000"),apify("/key-value-stores?limit=1000")]);
    const schedule=(schedules.items??[]).find((s:any)=>s.name==="source-scan-native-autopilot");
    const orchestrator=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-orchestrator");
    const worker=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-worker");
    if(!schedule||!orchestrator||!worker) throw new Error("native schedule/actors missing");
    const action=schedule.actions?.[0]; const oldInput=action?.runInput?.body?JSON.parse(action.runInput.body):{};
    const runInput={...oldInput,workerActorId:worker.id,dailyBudgetUsd:40,projectBudgetUsd:50,maxConcurrentJobs:Math.max(2,Number(limits?.limits?.maxConcurrentActorJobs??32)),displayBaseUrl:DISPLAY_BASE_URL,displayToken:secret("SOURCE_WORKER_TOKEN")};
    const scheduleBody={name:schedule.name,title:schedule.title,description:schedule.description,isEnabled:true,isExclusive:true,cronExpression:schedule.cronExpression||"*/15 * * * *",timezone:schedule.timezone||"Asia/Ho_Chi_Minh",actions:[{...action,runInput:{body:JSON.stringify(runInput),contentType:"application/json; charset=utf-8"}}]};
    const updated=await apify(`/schedules/${encodeURIComponent(schedule.id)}`,{method:"PUT",body:JSON.stringify(scheduleBody)});
    const backfill=bodyIn.action==="backfillRun"?await backfillFromMasterDataset():null;
    let run:any=null;
    if(bodyIn.action==="backfillRun"){
      const params=new URLSearchParams({memory:"256",timeout:"10800",build:"latest",maxTotalChargeUsd:"0.5",forcePermissionLevel:"FULL_PERMISSIONS"});
      run=await apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?${params.toString()}`,{method:"POST",body:JSON.stringify({...runInput,forceLease:true})});
    }
    const masterQ=(queues.items??[]).find((q:any)=>q.name==="source-scan-native-master-v1"); const taskQ=(queues.items??[]).find((q:any)=>q.name==="source-scan-native-tasks-v1");
    const masterInfo=masterQ?await apify(`/request-queues/${encodeURIComponent(masterQ.id)}`).catch(()=>null):null; const taskInfo=taskQ?await apify(`/request-queues/${encodeURIComponent(taskQ.id)}`).catch(()=>null):null;
    const runtime=(stores.items??[]).find((s:any)=>s.name==="source-scan-native-runtime-v1"); const budget=runtime?await apify(`/key-value-stores/${runtime.id}/records/BUDGET`).catch(()=>null):null;
    return Response.json({ok:true,schedule:{id:updated.id,enabled:updated.isEnabled,nextRunAt:updated.nextRunAt},limits:{max:limits?.limits?.maxConcurrentActorJobs,active:limits?.current?.activeActorJobCount},masterQueue:masterInfo?{total:masterInfo.totalRequestCount,pending:masterInfo.pendingRequestCount,handled:masterInfo.handledRequestCount}:null,taskQueue:taskInfo?{total:taskInfo.totalRequestCount,pending:taskInfo.pendingRequestCount,handled:taskInfo.handledRequestCount}:null,budget,backfill,run:run?{id:run.id,status:run.status}:null});
  }catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500})}
}}}});
