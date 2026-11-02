// Synthetic runtime only. Never print login/session credentials or patient rows.
import {readFileSync} from "node:fs";
const base=process.argv[2] ?? "http://127.0.0.1:8200";
const url=new URL(base);
if(!((url.hostname==="127.0.0.1" && url.port==="8200") || (url.protocol==="https:" && url.hostname.endsWith(".trycloudflare.com")))) throw Error("Expected the dedicated demo address");
const state=JSON.parse(readFileSync(new URL("../.organization-demo-runtime/public-clinical/state.json",import.meta.url),"utf8"));
let checks=0;
function check(ok:unknown,label:string){if(!ok)throw Error(`FAIL: ${label}`);console.log(`PASS: ${label}`);checks++;}
async function session(username:string){
 const r=await fetch(`${base}/api/v1/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clinic:"demo-one",username,password:state.loginPassword})});
 check(r.status===200,`${username} sign-in`);
 const cookie=r.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
 let clinic="",revision=1;
 async function call(action:string,params:Record<string,unknown>={}){
  const r=await fetch(`${base}/exec`,{method:"POST",headers:{"content-type":"application/json",cookie,...(clinic?{"x-kb-clinic":clinic,"x-kb-clinic-revision":String(revision)}:{})},body:JSON.stringify({action,...params})});
  return r.json() as Promise<any>;
 }
 const s=await call("getWorkingClinics");clinic=s.clinic_id;revision=s.revision;
 return {call,initialClinic:clinic,clinics:s.clinics,set(id:string,rev:number){clinic=id;revision=rev;},async logout(){await fetch(`${base}/api/v1/auth/logout`,{method:"POST",headers:{cookie}});}};
}
check((await fetch(`${base}/health`)).ok,"public backend health");
const page=await fetch(base);check(page.ok && (await page.text()).includes("KB_SCRIPT_URL_OVERRIDE"),"familiar clinical page and local API binding");
check((await fetch(`${base}/exec?action=saveRegistration`)).status===405,"URL writes blocked");
const admin=await session("admin");
try {
 check(admin.clinics.length===2,"administrator has two clinics");
 const first=await admin.call("searchOrganizationPatients",{query:"Aster Demo"});
 check(first.success && first.patients.length===1,"central synthetic patient found");
 const id=first.patients[0].organization_patient_id;
 const history=await admin.call("getPatientHistory",{organizationPatientId:id});
 check(history.success && new Set(history.events.map((e:any)=>e.clinicId)).size===2,"patient history contains both clinics");
 check(history.events.some((e:any)=>e.doctor) && history.events.some((e:any)=>e.details.Material),"history includes recorded doctor and material");
 const locked=await admin.call("getOrganizationProfile");check(locked.locked,"organization profile requires Master unlock");
 const unlock=await admin.call("verifyMasterPassword",{password:state.screenPassword});check(unlock.correct,"existing Master password unlocks organization");
 check((await admin.call("getOrganizationProfile")).success,"organization profile loads");
 for(const action of ["getOccupationsList","getSafetyFlagsList","getReferralSourcesList","getPatientTypesList"])check((await admin.call(action)).success,`${action} supported`);
 const target=admin.clinics.find((c:any)=>c.id!==admin.initialClinic);
 const changed=await admin.call("switchWorkingClinic",{clinicId:target.id});check(changed.success,"clinic switch accepted");
 admin.set(changed.clinicId,changed.revision);
 const second=await admin.call("searchOrganizationPatients",{query:"Aster Demo"});check(second.patients[0].organization_patient_id===id,"clinic switch preserves central patient identity");
 check((await admin.call("getOrganizationProfile")).locked,"switch clears Master unlock");
 const ai=await admin.call("chatbotReply");check(ai.success===false && /disabled/.test(ai.error),"external AI disabled");
} finally {await admin.logout();}
const limited=await session("doctor-one");
try {
 check(limited.clinics.length===1,"restricted doctor sees one clinic");
 const result=await limited.call("searchOrganizationPatients",{query:"Aster Demo"});
 const history=await limited.call("getPatientHistory",{organizationPatientId:result.patients[0].organization_patient_id});
 check(history.success && new Set(history.events.map((e:any)=>e.clinicId)).size===1,"restricted doctor receives only permitted history");
 const denied=await limited.call("switchWorkingClinic",{clinicId:admin.clinics.find((c:any)=>c.id!==limited.clinics[0].id).id});check(denied.forbidden,"forged clinic switch denied");
} finally {await limited.logout();}
console.log(`${checks} public synthetic checks passed. Browser acceptance remains separate.`);
