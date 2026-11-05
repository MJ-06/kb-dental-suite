import {readFileSync,existsSync} from 'node:fs';
const base=process.argv[2]??'http://127.0.0.1:8300',url=new URL(base);
if(!((url.hostname==='127.0.0.1'&&url.port==='8300')||(url.protocol==='https:'&&url.hostname.endsWith('.trycloudflare.com'))))throw Error('Unexpected review URL');
const state=JSON.parse(readFileSync(new URL('../.organization-demo-runtime/realdata-review/state.json',import.meta.url),'utf8'));
const expectedPatients=JSON.parse(readFileSync(new URL('../.organization-demo-runtime/realdata-review/verification-summary.json',import.meta.url),'utf8')).selectedPatients;
let checks=0;const check=(ok:unknown,label:string)=>{if(!ok)throw Error('FAIL: '+label);console.log('PASS: '+label);checks++;};
async function session(username:string){
 const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clinic:'kb-review',username,password:state.userPasswords?.[username]??state.loginPassword})});check(login.ok,username+' login');
 const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');let clinic='',revision=1;
 const headers=()=>({cookie,'content-type':'application/json',...(clinic?{'x-kb-clinic':clinic,'x-kb-clinic-revision':String(revision)}:{})});
 const call=async(action:string,params:Record<string,unknown>={})=>(await fetch(base+'/exec',{method:'POST',headers:headers(),body:JSON.stringify({action,...params})})).json() as Promise<any>;
 const context=await call('getWorkingClinics');clinic=context.clinic_id;revision=context.revision;
 return {call,context,headers,async close(){await fetch(base+'/api/v1/auth/logout',{method:'POST',headers:headers()});}};
}
check((await fetch(base+'/health')).ok,'review health');
const anonymous=await (await fetch(base+'/exec?action=getAllPatients')).json() as any;check(anonymous.authRequired&&!anonymous.patients,'anonymous requests cannot read patients');
check((await fetch(base+'/roles-access.js')).ok,'native staff access asset loads');
const admin=await session('admin');
try{
 const all=await admin.call('getAllPatients');check(all.success&&all.patients.length===expectedPatients,'expected migrated patient cohort available');
 const recent=await admin.call('getRecentPatients');check(recent.success&&recent.patients.length===20,'default patient list capped at20');
 const overview=await admin.call('getClinicOverview');check(overview.success&&overview.patients===expectedPatients,'dashboard uses organization patient count');
 const provenance=new URL('../.organization-demo-runtime/realdata-review/recovered-patient-verification.json',import.meta.url);
 if(existsSync(provenance)){const plans=JSON.parse(readFileSync(provenance,'utf8')).treatmentPlanProvenance;
  check(overview.treatmentPlans===plans.total-plans.financeopeningestimates&&overview.openingEstimates===plans.financeopeningestimates,'unverified opening estimates are separate from clinical plan counts');}
 const policy=await (await fetch(base+'/api/v1/capabilities',{headers:admin.headers()})).json() as any;check(policy.mode==='full'&&Object.values(policy.features).every(Boolean),'all tier capabilities enabled for review');
 check((await admin.call('verifyReportsPassword',{password:''})).correct,'administrator reports require no extra password');
 for(const action of ['getAppointments','getDailyRegister','getFinanceSummary','getExpenses','getCrmData','getCghsBills','getOrganizationReports'])check((await admin.call(action)).success,action+' contract');
 const patient=recent.patients[0],uhid=patient.uhid;for(const action of ['getPatient','getCarePlan','getTreatmentPlan','getPatientDocuments','getTreatmentProgress'])check((await admin.call(action,{uhid})).success,action+' opens migrated patient');
 check((await admin.call('getPatientHistory',{organizationPatientId:patient.organization_patient_id})).success,'linked history opens');
 check((await admin.call('verifyMasterPassword',{password:state.screenPassword})).correct,'existing Master gate works');
 check((await admin.call('getOrganizationProfile')).success,'organization profile opens');
 for(const path of ['/roles','/staff','/permissions','/activity'])check((await fetch(base+'/api/v1/access'+path,{headers:admin.headers()})).ok,'native access '+path);
 check(admin.context.clinics.length===2,'two authorized clinics');
}finally{await admin.close();}
const doctor=await session('doctor');try{check((await doctor.call('getAllPatients')).success,'doctor can read patient directory');check((await doctor.call('getFinanceSummary')).forbidden,'doctor cannot read clinic finance');check((await fetch(base+'/api/v1/access/roles',{headers:doctor.headers()})).status===403,'doctor cannot manage roles');}finally{await doctor.close();}
console.log(checks+' real-data API checks passed. No patient rows or credentials printed.');
