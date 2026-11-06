// Explicit local events only: never request bodies, patient IDs, URLs, titles,
// clinical text, credentials, screenshots, keystrokes or session recordings.
import {createHmac} from 'node:crypto';
import type {Actor} from './db/index.js';
export const USAGE_SCREENS=['dashboard','search','appointments','daysheet','registration','careplan','treatmentplan','records','clinical_records','clinical_sheets','finance','feecollection','consent','crm','chatbot','master','reports','progress','folder_picker','patient_history','prescription','daily_register','documents','cghs','followups'] as const;
export interface UsageConfig {url:string;website:string;salt:string}
export function usageConfig():UsageConfig|null{
 try{const url=new URL(process.env.UMAMI_LOCAL_URL??'');if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
  const website=process.env.UMAMI_WEBSITE_ID??'',salt=process.env.UMAMI_EVENT_SALT??'';if(!/^[0-9a-f-]{36}$/.test(website)||salt.length<32)return null;return {url:url.origin,website,salt};
 }catch{return null;}
}
export function usagePayload(config:UsageConfig,actor:Pick<Actor,'organizationId'|'principalId'|'userId'|'clinicId'>,kind:'screen'|'action',name:string,duration:number,success:boolean,allowedActions:ReadonlySet<string>){
 if(kind==='screen'?!USAGE_SCREENS.includes(name as typeof USAGE_SCREENS[number]):!allowedActions.has(name))return null;
 const hash=(v:string)=>createHmac('sha256',config.salt).update(v).digest('hex');
 return {type:'event',payload:{website:config.website,hostname:'kb-dental-local',url:kind==='screen'?'/screens/'+name:'/actions/'+name,title:'Clinical Suite',referrer:'',language:'en-IN',screen:'0x0',
  id:hash((actor.organizationId??'')+':'+(actor.principalId??actor.userId)).slice(0,40),name:kind==='screen'?'screen_opened':success?'action_succeeded':'action_failed',
  data:{[kind]:name,clinic:hash(actor.clinicId).slice(0,16),duration_ms:Math.max(0,Math.min(600000,Math.round(duration))),success}}};
}
let inFlight=0;
export function emitUsage(actor:Actor,kind:'screen'|'action',name:string,duration:number,success:boolean,allowedActions:ReadonlySet<string>){
 const config=usageConfig();if(!config||inFlight>=32)return;
 const event=usagePayload(config,actor,kind,name,duration,success,allowedActions);if(!event)return;
 inFlight++;
 void fetch(config.url+'/api/send',{method:'POST',headers:{'content-type':'application/json','user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'},body:JSON.stringify(event),signal:AbortSignal.timeout(2000)}).catch(()=>{}).finally(()=>{inFlight--;});
}
