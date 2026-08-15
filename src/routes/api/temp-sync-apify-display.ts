import { createFileRoute } from "@tanstack/react-router";

const APIFY_BASE = "https://api.apify.com/v2";
const ONE_SHOT = "9sTcuUbRnSlKRewYEhJ9TNdxoGqpaN24";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";

function secret(name:string){ const v=process.env[name]; if(!v) throw new Error(`${name} missing`); return v; }
async function apify(path:string, init:RequestInit={}){
  const res=await fetch(`${APIFY_BASE}${path}`,{...init,headers:{authorization:`Bearer ${secret("APIFY_TOKEN")}`,accept:"application/json","content-type":"application/json",...(init.headers??{})}});
  const text=await res.text(); let p:any; try{p=JSON.parse(text)}catch{p={raw:text}};
  if(!res.ok) throw new Error(`Apify ${path} ${res.status}: ${text.slice(0,1200)}`); return p.data??p;
}
export const Route=createFileRoute("/api/temp-sync-apify-display")({server:{handlers:{POST:async({request})=>{
  try{
    if(request.headers.get("x-one-shot")!==ONE_SHOT) return Response.json({ok:false},{status:401});
    const [schedules,actors,limits,queues,stores]=await Promise.all([
      apify("/schedules?limit=1000"),apify("/acts?limit=1000"),apify("/users/me/limits"),apify("/request-queues?limit=1000"),apify("/key-value-stores?limit=1000")
    ]);
    const schedule=(schedules.items??[]).find((s:any)=>s.name==="source-scan-native-autopilot");
    const orchestrator=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-orchestrator");
    const worker=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-worker");
    if(!schedule||!orchestrator||!worker) throw new Error("native schedule/actors missing");
    const action=schedule.actions?.[0]; const oldInput=action?.runInput?.body?JSON.parse(action.runInput.body):{};
    const runInput={...oldInput,workerActorId:worker.id,dailyBudgetUsd:40,projectBudgetUsd:50,maxConcurrentJobs:Math.max(2,Number(limits?.limits?.maxConcurrentActorJobs??32)),displayBaseUrl:DISPLAY_BASE_URL,displayToken:secret("SOURCE_WORKER_TOKEN")};
    const body={name:schedule.name,title:schedule.title,description:schedule.description,isEnabled:true,isExclusive:true,cronExpression:schedule.cronExpression||"*/15 * * * *",timezone:schedule.timezone||"Asia/Ho_Chi_Minh",actions:[{...action,runInput:{body:JSON.stringify(runInput),contentType:"application/json; charset=utf-8"}}]};
    const updated=await apify(`/schedules/${encodeURIComponent(schedule.id)}`,{method:"PUT",body:JSON.stringify(body)});
    const masterQ=(queues.items??[]).find((q:any)=>q.name==="source-scan-native-master-v1");
    const taskQ=(queues.items??[]).find((q:any)=>q.name==="source-scan-native-tasks-v1");
    const masterInfo=masterQ?await apify(`/request-queues/${encodeURIComponent(masterQ.id)}`).catch(()=>null):null;
    const taskInfo=taskQ?await apify(`/request-queues/${encodeURIComponent(taskQ.id)}`).catch(()=>null):null;
    const runtime=(stores.items??[]).find((s:any)=>s.name==="source-scan-native-runtime-v1");
    const budget=runtime?await apify(`/key-value-stores/${runtime.id}/records/BUDGET`).catch(()=>null):null;
    const runs=await apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?desc=1&limit=5`);
    return Response.json({ok:true,schedule:{id:updated.id,enabled:updated.isEnabled,nextRunAt:updated.nextRunAt},limits:{max:limits?.limits?.maxConcurrentActorJobs,active:limits?.current?.activeActorJobCount},masterQueue:masterInfo?{total:masterInfo.totalRequestCount,pending:masterInfo.pendingRequestCount,handled:masterInfo.handledRequestCount}:null,taskQueue:taskInfo?{total:taskInfo.totalRequestCount,pending:taskInfo.pendingRequestCount,handled:taskInfo.handledRequestCount}:null,budget,orchestratorRuns:(runs.items??[]).map((r:any)=>({id:r.id,status:r.status,startedAt:r.startedAt,finishedAt:r.finishedAt,usageTotalUsd:r.usageTotalUsd}))});
  }catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500})}
}}}});
