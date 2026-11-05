// Read-only API baseline for the single patient selected for UI comparison.
import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url),state=JSON.parse(readFileSync(new URL('state.json',root),'utf8')),selection=JSON.parse(readFileSync(new URL('private-ui-comparison-selection.json',root),'utf8'));
const base=process.argv[2]??'https://site-neighbors-jon-cooling.trycloudflare.com';
if(!['http://127.0.0.1:8300','https://site-neighbors-jon-cooling.trycloudflare.com'].includes(base))throw Error('Unexpected review destination');
async function main(){
 const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clinic:'kb-review',username:'admin',password:state.userPasswords.admin})});if(!login.ok)throw Error('Login failed');
 const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');let context:any;
 const headers=()=>({cookie,'content-type':'application/json',...(context?{'x-kb-clinic':context.clinic_id,'x-kb-clinic-revision':String(context.revision)}:{})});
 const call=async(action:string,params:Record<string,unknown>={})=>(await fetch(base+'/exec',{method:'POST',headers:headers(),body:JSON.stringify({action,...params})})).json() as Promise<any>;
 try{context=await call('getWorkingClinics');if(!context.success)throw Error('No clinic context');
  const norm=(v:unknown)=>String(v??'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const recordedDoctor=Object.entries(selection.record.fields).find(([k,v])=>/doctor|operator|surgeon/i.test(k)&&String(v??'').trim())?.[1];
  const chosen=selection.appointments.find((a:any)=>recordedDoctor&&norm(a.doctor_name)===norm(recordedDoctor))??selection.appointments[0];if(!chosen)throw Error('No appointment in selected snapshot');
  const result=await call('getAppointments',{date:chosen.date});if(!result.success)throw Error('Appointment baseline failed');
  const visible=result.appointments.filter((a:any)=>a.status!=='Cancelled'),patient=visible.filter((a:any)=>String(a.uhid).toUpperCase()===selection.patient.uhid.toUpperCase());
  const doctor=patient.find((a:any)=>recordedDoctor&&norm(a.doctor)===norm(recordedDoctor))?.doctor??patient[0]?.doctor??chosen.doctor_name;
  const expected={date:chosen.date,visibleRows:visible.length,patientRows:patient.length,doctor,doctorRows:visible.filter((a:any)=>a.doctor===doctor).length,patientDoctorRows:patient.filter((a:any)=>a.doctor===doctor).length,recordedAndPlannedDoctorMatch:!!recordedDoctor&&norm(doctor)===norm(recordedDoctor)};
  writeFileSync(new URL('private-ui-comparison-api.json',root),JSON.stringify(expected,null,2),{mode:0o600});console.log(JSON.stringify({visibleRows:expected.visibleRows,patientRows:expected.patientRows,doctorRows:expected.doctorRows,patientDoctorRows:expected.patientDoctorRows,recordedAndPlannedDoctorMatch:expected.recordedAndPlannedDoctorMatch}));
 }finally{await fetch(base+'/api/v1/auth/logout',{method:'POST',headers:headers()});}
}
main().catch(()=>{console.error('Daysheet comparison API baseline failed; no credentials or patient values printed.');process.exitCode=1;});
