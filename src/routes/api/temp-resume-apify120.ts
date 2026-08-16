import { createFileRoute } from "@tanstack/react-router";

const APIFY_BASE = "https://api.apify.com/v2";
const ONE_SHOT = "resume120-20260816-1449-x7p4";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";
const EXPIRES_AT = Date.parse("2026-08-16T08:30:00Z");

function secret(name:string){ const v=process.env[name]; if(!v) throw new Error(`${name} missing`); return v; }
async function apify(path:string, init:RequestInit={}){
  const res=await fetch(`${APIFY_BASE}${path}`,{...init,headers:{authorization:`Bearer ${secret("APIFY_TOKEN")}`,accept:"application/json","content-type":"application/json",...(init.headers??{})}});
  const text=await res.text(); let p:any; try{p=JSON.parse(text)}catch{p={raw:text}};
  if(!res.ok) throw new Error(`Apify ${path} ${res.status}: ${text.slice(0,1200)}`); return p.data??p;
}

export const Route=createFileRoute("/api/temp-resume-apify120")({server:{handlers:{POST:async({request})=>{
  try{
    if(Date.now()>EXPIRES_AT) return Response.json({ok:false,error:"expired"},{status:410});
    if(request.headers.get("x-one-shot")!==ONE_SHOT) return Response.json({ok:false},{status:401});
    const [schedules,actors,limitsBefore,stores]=await Promise.all([
      apify("/schedules?limit=1000"),apify("/acts?limit=1000"),apify("/users/me/limits"),apify("/key-value-stores?limit=1000")
    ]);
    if(Number(limitsBefore?.limits?.maxMonthlyUsageUsd??0)<120){
      await apify("/users/me/limits",{method:"PUT",body:JSON.stringify({maxMonthlyUsageUsd:120})});
    }
    const limits=await apify("/users/me/limits");
    const schedule=(schedules.items??[]).find((s:any)=>s.name==="source-scan-native-autopilot");
    const orchestrator=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-orchestrator");
    const worker=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-worker");
    if(!schedule||!orchestrator||!worker) throw new Error("native schedule/actors missing");
    const action=schedule.actions?.[0];
    const oldInput=action?.runInput?.body?JSON.parse(action.runInput.body):{};
    const runInput={...oldInput,workerActorId:worker.id,dailyBudgetUsd:60,projectBudgetUsd:120,maxConcurrentJobs:Math.max(2,Number(limits?.limits?.maxConcurrentActorJobs??32)),displayBaseUrl:DISPLAY_BASE_URL,displayToken:secret("SOURCE_WORKER_TOKEN")};
    const scheduleBody={name:schedule.name,title:schedule.title,description:schedule.description,isEnabled:true,isExclusive:true,cronExpression:"*/15 * * * *",timezone:"Asia/Ho_Chi_Minh",actions:[{...action,runInput:{body:JSON.stringify(runInput),contentType:"application/json; charset=utf-8"}}]};
    const updated=await apify(`/schedules/${encodeURIComponent(schedule.id)}`,{method:"PUT",body:JSON.stringify(scheduleBody)});
    const runtime=(stores.items??[]).find((s:any)=>s.name==="source-scan-native-runtime-v1");
    const budget=runtime?await apify(`/key-value-stores/${runtime.id}/records/BUDGET`).catch(()=>null):null;
    const params=new URLSearchParams({memory:"256",timeout:"10800",build:"latest",maxTotalChargeUsd:"0.75",forcePermissionLevel:"FULL_PERMISSIONS"});
    const run=await apify(`/acts/${encodeURIComponent(orchestrator.id)}/runs?${params.toString()}`,{method:"POST",body:JSON.stringify({...runInput,forceLease:true})});
    return Response.json({ok:true,dailyBudgetUsd:60,projectBudgetUsd:120,budget,monthly:{beforeLimitUsd:limitsBefore?.limits?.maxMonthlyUsageUsd,currentUsageUsd:limits?.current?.monthlyUsageUsd,afterLimitUsd:limits?.limits?.maxMonthlyUsageUsd},schedule:{id:updated.id,enabled:updated.isEnabled,nextRunAt:updated.nextRunAt},limits:{max:limits?.limits?.maxConcurrentActorJobs,active:limits?.current?.activeActorJobCount},run:{id:run.id,status:run.status}});
  }catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500})}
}}}});
