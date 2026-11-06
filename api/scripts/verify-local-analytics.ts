// Local services only. Never prints passwords, tokens or clinical responses.
import {readFileSync} from 'node:fs';import pg from 'pg';
const root=new URL('../.organization-demo-runtime/',import.meta.url);
const analytics=JSON.parse(readFileSync(new URL('analytics/state.json',root),'utf8'));
if(analytics.database!=='kb_umami_review'||analytics.marker!=='kb-dental-local-analytics-v1')throw Error('Unexpected analytics target');
let checks=0;const check=(ok:unknown,label:string)=>{if(!ok)throw Error('FAIL: '+label);checks++;console.log('PASS: '+label);};
const local='http://127.0.0.1:8091',review='http://127.0.0.1:8300';
check((await fetch(local+'/login')).ok,'local analytics sign-in page');
const login=await fetch(local+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:analytics.adminPassword})});
check(login.ok&&!!(await login.json() as any).token,'private analytics account signs in');
const c=new pg.Client({host:'localhost',database:analytics.database,user:analytics.role,password:analytics.password});await c.connect();
let cookie='';
try{
 const website=(await c.query('SELECT recorder_enabled FROM website WHERE website_id=$1',[analytics.websiteId])).rows[0];check(website?.recorder_enabled===false,'session replay disabled');
 const before=Number((await c.query("SELECT count(*) FROM website_event WHERE website_id=$1 AND event_name='screen_opened'",[analytics.websiteId])).rows[0].count);
 const state=JSON.parse(readFileSync(new URL('realdata-review/state.json',root),'utf8'));
 const signed=await fetch(review+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clinic:'kb-review',username:'admin',password:state.userPasswords?.admin??state.loginPassword})});check(signed.ok,'existing clinical account still signs in');
 cookie=signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const context=await (await fetch(review+'/exec',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'getWorkingClinics'})})).json() as any;
 const headers={cookie,'content-type':'application/json','x-kb-clinic':context.clinic_id,'x-kb-clinic-revision':String(context.revision)};
 check((await fetch(review+'/api/v1/usage/screen',{method:'POST',headers,body:JSON.stringify({screen:'dashboard'})})).ok,'authenticated allowlisted screen accepted');
 check((await fetch(review+'/api/v1/usage/screen',{method:'POST',headers,body:JSON.stringify({screen:'dashboard',patient:'FICTIONAL-MUST-BE-REJECTED'})})).status===400,'extra data rejected');
 const status=await (await fetch(review+'/api/v1/usage/status',{headers})).json() as any;check(status.enabled&&status.patientData===false&&status.sessionReplay===false,'clinical analytics configuration enabled');
 let after=before;for(let n=0;n<10&&after<=before;n++){await new Promise(r=>setTimeout(r,250));after=Number((await c.query("SELECT count(*) FROM website_event WHERE website_id=$1 AND event_name='screen_opened'",[analytics.websiteId])).rows[0].count);}
 check(after>before,'screen event persisted in isolated analytics database');
 const invalid=Number((await c.query("SELECT count(*) FROM website_event WHERE website_id=$1 AND (hostname <> 'kb-dental-local' OR coalesce(url_query,'')<>'' OR url_path !~ '^/(screens|actions)/[A-Za-z_]+$')",[analytics.websiteId])).rows[0].count);check(invalid===0,'stored paths contain only explicit labels');
 const keys=(await c.query('SELECT DISTINCT data_key FROM event_data WHERE website_id=$1',[analytics.websiteId])).rows.map(r=>r.data_key);check(keys.length>0&&keys.every(k=>['screen','action','clinic','duration_ms','success'].includes(k)),'stored properties match privacy allowlist');
}finally{if(cookie)await fetch(review+'/api/v1/auth/logout',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});await c.end();}
console.log(checks+' local analytics checks passed; no credentials or clinical values printed.');
