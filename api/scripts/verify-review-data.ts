// Independent, read-only field comparisons. Counts/hashes only leave this process.
import {readFileSync,writeFileSync} from 'node:fs';import {parseEnv} from 'node:util';import {join,resolve,sep} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';import pg from 'pg';
const full=process.argv.includes('--all');
const root=new URL(full?'../.organization-demo-runtime/realdata-full-rehearsal/':'../.organization-demo-runtime/realdata-review/',import.meta.url);
import {preservePostgresDates} from '../src/migration/pg-dates.js';
preservePostgresDates();
const state=JSON.parse(readFileSync(new URL('state.json',root),'utf8')),sourceEnv=parseEnv(readFileSync(join(homedir(),'.kb-pms/owner.env'),'utf8'));
const source=new pg.Client({connectionString:sourceEnv.REHEARSAL_OWNER_DATABASE_URL});const target=new pg.Client({host:'localhost',database:full?'kb_realdata_full_rehearsal':'kb_realdata_review',user:state.owner,password:state.ownerPassword});
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const skip=new Set(['clinic_id','version','created_at','updated_at','created_by','updated_by','storage_key','storage_ref','storage_backend','checksum_sha256']);
async function main(){await source.connect();await target.connect();try{
 await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const sourceClinic=(await source.query('SELECT id FROM clinics')).rows;if(sourceClinic.length!==1)throw Error('Ambiguous source');
 const marker=(await target.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==state.marker)throw Error('Unexpected target');
 const clinic=(await target.query("SELECT id FROM clinics WHERE code::text='kb-review'")).rows[0].id;await source.query("SELECT set_config('app.clinic_id',$1,true)",[sourceClinic[0].id]);await target.query("SELECT set_config('app.clinic_id',$1,true)",[clinic]);
 const selected=(await source.query('SELECT id FROM patients WHERE deleted_at IS NULL ORDER BY registered_on DESC,id DESC'+(full?'':' LIMIT 2000'))).rows.map(r=>r.id);
 const actual=(await target.query('SELECT id FROM patients WHERE deleted_at IS NULL')).rows.map(r=>r.id);if(hash([...selected].sort())!==hash([...actual].sort()))throw Error('Patient selection mismatch');
 const report:any={patientSelectionMatches:true,tables:{},files:{checked:0,matched:0}};
 for(const table of ['panels','doctors','chairs','staff','treatments','medicines','implant_brands','appointment_reasons','pick_lists','holidays','panel_rates','procedure_library','patients','patient_registrations','appointments','daily_register','clinical_records','clinical_sheets','treatment_cases','treatment_plans','receipts','expenses','patient_documents',...(full?['crm_records','crm_lead_inbox','pending_registrations']:[])]){
  const cols=(await source.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[table])).rows.map(r=>r.column_name).filter(c=>!skip.has(c));
  const rows=(await target.query(`SELECT ${cols.map(q).join(',')} FROM ${q(table)} ORDER BY id`)).rows;
  const originals=rows.length?(await source.query(`SELECT ${cols.map(q).join(',')} FROM ${q(table)} WHERE id=ANY($1::uuid[]) ORDER BY id`,[rows.map(r=>r.id)])).rows:[];
  const matched=hash(rows)===hash(originals);report.tables[table]={rows:rows.length,matched};if(!matched)throw Error('Field comparison mismatch in '+table);
 }
 const sourceRoot=resolve(join(homedir(),'.kb-pms/documents-rehearsal')),targetRoot=resolve(new URL('documents/',root).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
 for(const doc of (await target.query('SELECT id,storage_key FROM patient_documents')).rows){const original=(await source.query('SELECT storage_key FROM patient_documents WHERE id=$1',[doc.id])).rows[0];const from=resolve(sourceRoot,...String(original.storage_key).split('/')),to=resolve(targetRoot,...String(doc.storage_key).split('/'));if(!from.startsWith(sourceRoot+sep)||!to.startsWith(targetRoot+sep))throw Error('Invalid file key');report.files.checked++;if(createHash('sha256').update(readFileSync(from)).digest('hex')!==createHash('sha256').update(readFileSync(to)).digest('hex'))throw Error('Attachment mismatch');report.files.matched++;}
 report.complete=true;writeFileSync(new URL('independent-data-verification.json',root),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{await source.end();await target.end();}}
main().catch(e=>{writeFileSync(new URL('private-comparison-error.json',root),JSON.stringify({error:e instanceof Error?e.message:'Unknown',code:e.code??null}),{mode:0o600});console.error('Independent data comparison failed. No patient values printed; inspect the private migration summary.');process.exitCode=1;});
