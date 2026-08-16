import { createFileRoute } from "@tanstack/react-router";

const APIFY_BASE = "https://api.apify.com/v2";
const ONE_SHOT = "continuous-20260816-v1";
const DISPLAY_BASE_URL = "https://source-scan-hub.lovable.app";
const EXPIRES_AT = Date.parse("2026-08-16T09:00:00Z");

function secret(name:string){ const v=process.env[name]; if(!v) throw new Error(`${name} missing`); return v; }
async function raw(path:string, init:RequestInit={}){
  return fetch(`${APIFY_BASE}${path}`,{...init,headers:{authorization:`Bearer ${secret("APIFY_TOKEN")}`,accept:"application/json","content-type":"application/json",...(init.headers??{})}});
}
async function apify(path:string, init:RequestInit={}){
  const res=await raw(path,init); const text=await res.text(); let p:any; try{p=JSON.parse(text)}catch{p={raw:text}};
  if(!res.ok) throw new Error(`Apify ${path} ${res.status}: ${text.slice(0,1600)}`); return p.data??p;
}
async function waitBuild(id:string){
  const until=Date.now()+7*60_000;
  while(Date.now()<until){ const b=await apify(`/actor-builds/${encodeURIComponent(id)}`); if(["SUCCEEDED","FAILED","ABORTED","TIMED-OUT"].includes(b.status)) return b; await new Promise(r=>setTimeout(r,3500)); }
  throw new Error(`build timeout ${id}`);
}

export const Route=createFileRoute("/api/temp-deploy-apify-continuous")({server:{handlers:{POST:async({request})=>{
  try{
    if(Date.now()>EXPIRES_AT) return Response.json({ok:false,error:"expired"},{status:410});
    if(request.headers.get("x-one-shot")!==ONE_SHOT) return Response.json({ok:false,error:"unauthorized"},{status:401});
    const body=await request.json().catch(()=>({})) as any;
    const files=Array.isArray(body.orchestratorFiles)?body.orchestratorFiles:[];
    if(files.length<4) throw new Error("orchestratorFiles missing");
    const [actors,schedules,limits,user,stores]=await Promise.all([
      apify("/acts?limit=1000"),apify("/schedules?limit=1000"),apify("/users/me/limits"),apify("/users/me"),apify("/key-value-stores?limit=1000")
    ]);
    const worker=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-worker");
    const orch=(actors.items??[]).find((a:any)=>a.name==="source-scan-native-orchestrator");
    const schedule=(schedules.items??[]).find((s:any)=>s.name==="source-scan-native-autopilot");
    if(!worker||!orch||!schedule) throw new Error("native actor/schedule missing");

    await Promise.all([
      apify(`/actors/${encodeURIComponent(worker.id)}`,{method:"PUT",body:JSON.stringify({actorPermissionLevel:"FULL_PERMISSIONS"})}),
      apify(`/actors/${encodeURIComponent(orch.id)}`,{method:"PUT",body:JSON.stringify({actorPermissionLevel:"FULL_PERMISSIONS"})}),
    ]);

    const version={versionNumber:"1.0",buildTag:"latest",sourceType:"SOURCE_FILES",sourceFiles:files};
    await apify(`/acts/${encodeURIComponent(orch.id)}/versions/1.0`,{method:"PUT",body:JSON.stringify(version)});
    const build=await apify(`/acts/${encodeURIComponent(orch.id)}/builds?version=1.0&tag=latest`,{method:"POST"});
    const finished=await waitBuild(build.id); if(finished.status!=="SUCCEEDED") throw new Error(`orchestrator build ${finished.status}`);

    const maxJobs=Math.max(2,Number(limits?.limits?.maxConcurrentActorJobs??32));
    const action=schedule.actions?.[0];
    const oldInput=action?.runInput?.body?JSON.parse(action.runInput.body):{};
    const runInput={...oldInput,workerActorId:worker.id,mode:"master",localConcurrency:10,maxWorkerItems:1200,maxWorkerRunMinutes:30,maxCycleMinutes:170,dailyBudgetUsd:1000000,projectBudgetUsd:1000000,maxConcurrentJobs:maxJobs,displayBaseUrl:DISPLAY_BASE_URL,displayToken:secret("SOURCE_WORKER_TOKEN")};
    const scheduleBody={name:schedule.name,title:schedule.title,description:"Apify-native continuous Source Hunter. Internal budget caps disabled; billing account is final stop. Lovable is display-only.",isEnabled:true,isExclusive:true,cronExpression:"*/15 * * * *",timezone:"Asia/Ho_Chi_Minh",actions:[{...action,runInput:{body:JSON.stringify(runInput),contentType:"application/json; charset=utf-8"},runOptions:{...(action?.runOptions??{}),build:"latest",timeoutSecs:10800,memoryMbytes:256,maxTotalChargeUsd:1,restartOnError:true}}]};
    const updated=await apify(`/schedules/${encodeURIComponent(schedule.id)}`,{method:"PUT",body:JSON.stringify(scheduleBody)});

    const [wr,or]=await Promise.all([apify(`/acts/${encodeURIComponent(worker.id)}/runs?desc=1&limit=100`),apify(`/acts/${encodeURIComponent(orch.id)}/runs?desc=1&limit=30`)]);
    const active=[...(wr.items??[]),...(or.items??[])].filter((r:any)=>["RUNNING","READY"].includes(r.status));
    for(const r of active){ await apify(`/actor-runs/${encodeURIComponent(r.id)}/abort?gracefully=false`,{method:"POST"}).catch(()=>null); }
    await new Promise(r=>setTimeout(r,2500));

    const params=new URLSearchParams({memory:"256",timeout:"10800",build:"latest",maxTotalChargeUsd:"1",forcePermissionLevel:"FULL_PERMISSIONS"});
    const run=await apify(`/acts/${encodeURIComponent(orch.id)}/runs?${params.toString()}`,{method:"POST",body:JSON.stringify({...runInput,forceLease:true})});
    const runtime=(stores.items??[]).find((s:any)=>s.name==="source-scan-native-runtime-v1");
    const budget=runtime?await apify(`/key-value-stores/${runtime.id}/records/BUDGET`).catch(()=>null):null;
    return Response.json({ok:true,build:{id:finished.id,status:finished.status},account:{plan:user?.plan?.id??user?.plan?.name??null,monthlyCreditsUsd:user?.plan?.monthlyUsageCreditsUsd??null,maxMonthlyUsageUsd:limits?.limits?.maxMonthlyUsageUsd,currentMonthlyUsageUsd:limits?.current?.monthlyUsageUsd,maxConcurrentActorJobs:maxJobs},internalCaps:{dailyBudgetUsd:runInput.dailyBudgetUsd,projectBudgetUsd:runInput.projectBudgetUsd},nativeBudget:budget,schedule:{id:updated.id,enabled:updated.isEnabled,nextRunAt:updated.nextRunAt},abortedActiveRuns:active.length,run:{id:run.id,status:run.status}});
  }catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:500})}
}}}});
