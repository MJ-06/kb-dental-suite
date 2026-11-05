// Private rehearsal -> new isolated review DB. Never prints source rows or secrets.
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from "node:fs";
import {homedir} from "node:os";
import {join,resolve,dirname,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import pg from "pg";
// PostgreSQL DATE has no timezone. Preserve its literal value through JSON copy.
import {preservePostgresDates} from '../src/migration/pg-dates.js';
preservePostgresDates();
import {migrate} from "../src/migrator.js";
import {createClinic,createUser} from "../src/admin.js";
import {hashPassword} from "../src/auth/password.js";
const full=process.argv.includes('--all');
const root=fileURLToPath(new URL(full?'../.organization-demo-runtime/realdata-full-rehearsal/':'../.organization-demo-runtime/realdata-review/',import.meta.url));
const database=full?'kb_realdata_full_rehearsal':'kb_realdata_review',stateFile=join(root,'state.json');
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"',literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const secret=()=>randomBytes(24).toString('base64url');
const masters=['panels','doctors','chairs','staff','treatments','medicines','implant_brands','appointment_reasons','pick_lists','holidays','panel_rates','procedure_library'];
const dependent=['patient_registrations','treatment_cases','appointments','daily_register','clinical_records','clinical_sheets','care_plans','treatment_plans','consents','receipts','patient_documents'];
let phase='preflight';
async function main(){
 if(!process.argv.includes('--apply')){console.log('Dry run: create marked isolated real-data review database from existing private rehearsal; select latest 2000 patients and linked rows; source remains read-only.');return;}
 mkdirSync(root,{recursive:true,mode:0o700});
 if(process.platform==='win32'){const sid=execFileSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-[0-9-]+/)?.[0];if(!sid)throw Error('No SID');execFileSync('icacls',[root,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],{stdio:'ignore',windowsHide:true});}
 const env=Object.fromEntries(readFileSync(join(homedir(),'.kb-pms/owner.env'),'utf8').split(/\r?\n/).filter(l=>!l.startsWith('#')&&l.includes('=')).map(l=>{const p=l.indexOf('=');return [l.slice(0,p).trim(),l.slice(p+1).trim()];}));
 const sourceUrl=new URL(env.REHEARSAL_OWNER_DATABASE_URL!);if(!['localhost','127.0.0.1'].includes(sourceUrl.hostname)||sourceUrl.pathname!=='/kb_rehearsal')throw Error('Unexpected source');
 const source=new pg.Client({connectionString:sourceUrl.href});await source.connect();
 const admin=new pg.Client({host:'localhost',database:'postgres',user:'postgres',password:readFileSync(join(homedir(),'.kb-pms/postgres-superuser.txt'),'utf8').trim()});await admin.connect();
 try{
  const prior=(await admin.query('SELECT shobj_description(oid,\'pg_database\') AS marker FROM pg_database WHERE datname=$1',[database])).rows[0];
  if(prior||existsSync(stateFile)){if(!prior||!existsSync(stateFile))throw Error('Unmarked target');const st=JSON.parse(readFileSync(stateFile,'utf8'));if(st.marker!==prior.marker||!st.complete)throw Error('Incomplete existing review needs owner review');console.log('Existing completed real-data review retained; no records or credentials changed.');return;}
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const clinics=(await source.query('SELECT id,uhid_scheme,uhid_prefix,timezone,receipt_scheme FROM clinics')).rows;if(clinics.length!==1)throw Error('Expected one source clinic; attribution review required');
  await source.query("SELECT set_config('app.clinic_id',$1,true)",[clinics[0].id]);
  const patients=(await source.query('SELECT * FROM patients WHERE deleted_at IS NULL ORDER BY registered_on DESC,id DESC'+(full?'':' LIMIT 2000'))).rows;if(!full&&patients.length!==2000)throw Error('Source does not contain 2000 selectable patients');
  const ids=patients.map(p=>p.id),uhids=patients.map(p=>String(p.uhid).toUpperCase());
  const snapshot:Record<string,any[]>={patients};const report:any={source:'private-rehearsal-from-local-exports',selection:full?'all accepted source patients and source-table rows':'latest registered_on descending, stable UUID tie-break',selectedPatients:patients.length,sourcePatients:Number((await source.query('SELECT count(*) AS n FROM patients WHERE deleted_at IS NULL')).rows[0].n),tables:{},files:{copied:0,missing:0},notes:['Source clinic attribution retained; second clinic starts empty. No historical care is invented or reassigned.']};
  const columns=async(c:pg.Client,t:string)=>(await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",[t])).rows.map(r=>r.column_name as string);
  for(const table of [...masters,...dependent,'expenses','uhid_counters','receipt_counters','receipt_label_counters',...(full?['crm_records','crm_lead_inbox','pending_registrations']:[])]){
   const cols=await columns(source,table);if(!cols.length)continue;
   const filter=!full&&dependent.includes(table)?(cols.includes('patient_id')&&cols.includes('uhid')?' WHERE patient_id=ANY($1::uuid[]) OR (patient_id IS NULL AND upper(uhid)=ANY($2::text[]))':cols.includes('patient_id')?' WHERE patient_id=ANY($1::uuid[])':' WHERE upper(uhid)=ANY($2::text[])'):'';
   snapshot[table]=(await source.query(`SELECT * FROM ${q(table)}${filter}`,filter?(filter.includes('$2')?[ids,uhids]:[ids]):[])).rows;
  }
  snapshot.clinic_settings=(await source.query("SELECT * FROM clinic_settings WHERE key=ANY($1::text[])",[['clinic_profile','clinic_timings','week_off','progress_shows_payments']])).rows;
  phase='isolated provisioning';const suffix=randomBytes(5).toString('hex');
  const loginPassword=secret();
  const state={marker:'kb-realdata-review:'+randomUUID(),owner:'kb_data_owner_'+suffix,app:'kb_data_app_'+suffix,ownerPassword:secret(),appPassword:secret(),loginPassword,userPasswords:{admin:loginPassword,doctor:secret(),reception:secret(),accounts:secret()} as Record<string,string>,screenPassword:secret(),complete:false};
  writeFileSync(stateFile,JSON.stringify(state),{mode:0o600,flag:'wx'});
  for(const [role,pw]of [[state.owner,state.ownerPassword],[state.app,state.appPassword]])await admin.query(`CREATE ROLE ${q(role!)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD ${literal(pw!)}`);
  await admin.query(`CREATE DATABASE ${q(database)} OWNER ${q(state.owner)}`);await admin.query(`COMMENT ON DATABASE ${q(database)} IS ${literal(state.marker)}`);await admin.query(`REVOKE ALL ON DATABASE ${q(database)} FROM PUBLIC,kb_app`);
  const url=(user:string,pw:string)=>{const u=new URL('postgresql://localhost:5432/'+database);u.username=user;u.password=pw;return u.href;};
  const ownerUrl=url(state.owner,state.ownerPassword);await migrate(ownerUrl,()=>{},{applyGrants:false});
  const clinicIds:string[]=[];for(const [code,name]of [['kb-review','KB Main Clinic'],['kb-review-second','KB Second Clinic']])clinicIds.push(await createClinic(ownerUrl,{code:code!,name:name!,uhidScheme:clinics[0].uhid_scheme,uhidPrefix:clinics[0].uhid_prefix,timezone:clinics[0].timezone}));
  for(const cid of clinicIds)for(const [username,displayName,role]of [['admin','Review Administrator','admin'],['doctor','Review Doctor','doctor'],['reception','Review Reception','reception'],['accounts','Review Accounts','accounts']])await createUser(ownerUrl,cid,{username:username!,displayName:displayName!,role:role!,password:state.userPasswords[username!]!});
  const target=new pg.Client({connectionString:ownerUrl});await target.connect();
  try{
   await target.query('BEGIN');await target.query("SELECT set_config('app.clinic_id',$1,true)",[clinicIds[0]]);
   await target.query('UPDATE clinics SET receipt_scheme=$1 WHERE id=ANY($2::uuid[])',[clinics[0].receipt_scheme,clinicIds]);
   const users=(await target.query("SELECT id,username::text FROM app_users")).rows;const actor=users.find(u=>u.username==='admin')!.id;await target.query("SELECT set_config('app.user_id',$1,true)",[actor]);
   const copy=async(table:string,rows:any[])=>{
    if(!rows.length){report.tables[table]={expected:0,imported:0};return;}
    const cols=(await columns(target,table)).filter(col=>Object.prototype.hasOwnProperty.call(rows[0],col));
    const prepared=rows.map(row=>({...row,...('clinic_id'in row?{clinic_id:clinicIds[0]}:{}),...('created_by'in row?{created_by:actor}:{}),...('updated_by'in row?{updated_by:actor}:{})}));
    for(let i=0;i<prepared.length;i+=100)await target.query(`INSERT INTO ${q(table)} (${cols.map(q).join(',')}) SELECT ${cols.map(q).join(',')} FROM jsonb_populate_recordset(NULL::${q(table)},$1::jsonb)`,[JSON.stringify(prepared.slice(i,i+100))]);
    const count=Number((await target.query(`SELECT count(*) AS n FROM ${q(table)}`)).rows[0].n);report.tables[table]={expected:rows.length,imported:count};if(count!==rows.length)throw Error('Table count mismatch');
   };
   phase='copy masters and patients';for(const table of masters)if(snapshot[table])await copy(table,snapshot[table]);await copy('patients',patients);
   phase='copy linked history';for(const table of dependent)if(snapshot[table])await copy(table,snapshot[table]);
   for(const table of ['expenses','uhid_counters','receipt_counters','receipt_label_counters','clinic_settings',...(full?['crm_records','crm_lead_inbox','pending_registrations']:[])])if(snapshot[table])await copy(table,snapshot[table]);
   phase='document transfer';const docsRoot=join(root,'documents');mkdirSync(docsRoot,{recursive:true,mode:0o700});const sourceRoot=resolve(join(homedir(),'.kb-pms/documents-rehearsal'));
   for(const d of snapshot.patient_documents??[]){const from=resolve(sourceRoot,...String(d.storage_key).split('/'));if(!from.startsWith(sourceRoot+sep))throw Error('Invalid source file key');if(!existsSync(from)){report.files.missing++;continue;}const key=clinicIds[0]+'/'+d.id;const to=join(docsRoot,...key.split('/'));mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(from,to);const bytes=readFileSync(to);await target.query("UPDATE patient_documents SET storage_key=$1,storage_backend='local',storage_ref=NULL,checksum_sha256=$2,size_bytes=$3 WHERE id=$4",[key,createHash('sha256').update(bytes).digest('hex'),bytes.length,d.id]);report.files.copied++;}
   phase='organization identity';const org=(await target.query("INSERT INTO org_identity(id,code,name,hostname) VALUES(uuidv7(),'kb-real-review','KB Review Organization','kb-review') RETURNING id")).rows[0].id;await target.query("SELECT set_config('app.organization_id',$1,true)",[org]);
   const master=await hashPassword(state.screenPassword);
   await target.query("INSERT INTO org_settings(key,value) VALUES('clinical_master_password',$1::jsonb),('subscription_policy','{\"plan\":\"enterprise\",\"mode\":\"full\"}')",[JSON.stringify(master)]);
   for(const [i,cid]of clinicIds.entries()){
    const unit=(await target.query("INSERT INTO org_units(code,name) VALUES($1,$2) RETURNING id",['clinic-'+i,i===0?'KB Main Clinic':'KB Second Clinic'])).rows[0].id;await target.query('INSERT INTO org_clinical_units VALUES($1,$2,$3)',[org,unit,cid]);
    await target.query("SELECT set_config('app.clinic_id',$1,true)",[cid]);const targets=(await target.query('SELECT id,username::text FROM app_users')).rows;
    for(const user of users){const member=targets.find(t=>t.username===user.username)!;await target.query('INSERT INTO org_clinical_access VALUES($1,$2,$3,$4,$5,$6)',[org,clinicIds[0],user.id,cid,member.id,user.username==='admin']);}
    for(const key of ['finance_password','reports_password_1','reports_password_2'])await target.query('INSERT INTO clinic_settings(key,value) VALUES($1,$2::jsonb)',[key,JSON.stringify(master)]);
   }
   await target.query("SELECT set_config('app.clinic_id',$1,true),set_config('app.user_id',$2,true)",[clinicIds[0],actor]);await target.query('SELECT clinical_publish_patient(id) FROM patients');
   report.identityLinks=Number((await target.query('SELECT count(*) AS n FROM org_clinical_patient_links')).rows[0].n);if(report.identityLinks!==patients.length)throw Error('Identity reconciliation mismatch');
   report.financial={};for(const [t,expr]of [['receipts','amount1+amount2'],['expenses','amount']]){const expected=(snapshot[t!]??[]).reduce((sum,r)=>sum+Math.round(Number(t==='receipts'?Number(r.amount1)+Number(r.amount2):r.amount)*100),0);const actual=Number((await target.query(`SELECT coalesce(sum(${expr}),0)*100 AS cents FROM ${q(t!)}`)).rows[0].cents);report.financial[t!]={expectedCents:expected,importedCents:actual};if(expected!==actual)throw Error('Financial reconciliation mismatch');}
   await target.query('COMMIT');
   report.complete=report.files.missing===0;writeFileSync(join(root,'verification-summary.json'),JSON.stringify(report,null,2),{mode:0o600});
   if(report.files.missing)throw Error('Missing documents prevent completion');
  }catch(e){await target.query('ROLLBACK');throw e;}finally{await target.end();}
  phase='dedicated runtime grants';const grants=new pg.Client({host:'localhost',database,user:'postgres',password:readFileSync(join(homedir(),'.kb-pms/postgres-superuser.txt'),'utf8').trim()});await grants.connect();try{await grants.query(readFileSync(fileURLToPath(new URL('../migrations/grants.sql',import.meta.url)),'utf8').replace(/\bkb_app\b/g,q(state.app)));await grants.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kb_app');
   // Preserve trusted extension execution needed by the schema owner. Restrict
   // application SECURITY DEFINER entry points to the dedicated runtime role.
   const entrypoints=(await grants.query("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef")).rows;
   for(const fn of entrypoints)await grants.query(`REVOKE EXECUTE ON FUNCTION ${fn.signature} FROM PUBLIC,kb_app`);
   await admin.query(`GRANT CONNECT ON DATABASE ${q(database)} TO ${q(state.app)}`);}finally{await grants.end();}
  writeFileSync(join(root,'app.env'),`DATABASE_URL=${url(state.app,state.appPassword)}\nPORT=${full?8340:8300}\nDOCUMENT_DIR=${join(root,'documents').replaceAll('\\','/')}\nKB_SECRETS_KEY=${randomBytes(32).toString('base64')}\nANTHROPIC_API_KEY=\nPDF_BROWSER=\n`,{mode:0o600});
  writeFileSync(join(root,'demo-logins.txt'),`PRIVATE REAL-DATA REVIEW. Share only the relevant credential with each authorized reviewer.\nClinic code: kb-review\n${Object.entries(state.userPasswords).map(([user,pw])=>user+': '+pw).join('\n')}\nMaster / Finance / Reports: ${state.screenPassword}\nSecond clinic contains no invented historical care.\n`,{mode:0o600});
  state.complete=true;writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});await source.query('ROLLBACK');console.log('Isolated '+patients.length+'-patient '+(full?'full rehearsal':'review')+' imported and reconciled; private summary and credentials saved without printing source values.');
 }finally{await source.end();await admin.end();}
}
main().catch(e=>{writeFileSync(join(root,'private-error.json'),JSON.stringify({phase,error:e instanceof Error?e.message:'Unknown'}),{mode:0o600});console.error('Real-data review stopped during '+phase+'. See private runtime report; no patient data or credentials printed.');process.exitCode=1;});
