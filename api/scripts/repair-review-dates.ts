// Correct only DATE columns in the marked, newly imported review. Source read-only.
import {readFileSync,writeFileSync} from 'node:fs';import {parseEnv} from 'node:util';import {join} from 'node:path';import {homedir} from 'node:os';import pg from 'pg';
import {preservePostgresDates} from '../src/migration/pg-dates.js';
preservePostgresDates();
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url),state=JSON.parse(readFileSync(new URL('state.json',root),'utf8'));
const env=parseEnv(readFileSync(join(homedir(),'.kb-pms/owner.env'),'utf8'));const source=new pg.Client({connectionString:env.REHEARSAL_OWNER_DATABASE_URL}),target=new pg.Client({host:'localhost',database:'kb_realdata_review',user:state.owner,password:state.ownerPassword});
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
async function main(){
 if(!process.argv.includes('--apply')){console.log('Dry run: source-authoritative DATE recopy in marked review only; requires a clean read-only comparison proof.');return;}
 const proof=JSON.parse(readFileSync(new URL('date-copy-proof.json',root),'utf8'));if(!proof.sourceAuthoritativeCorrectionSafe||proof.unexpectedDateDifferences||proof.nonDateDifferences)throw Error('Source comparison proof is not clean');
 await source.connect();await target.connect();try{
 await source.query('BEGIN READ ONLY');await target.query('BEGIN');const marker=(await target.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==state.marker)throw Error('Unexpected target');
 const sourceClinics=(await source.query('SELECT id FROM clinics')).rows;if(sourceClinics.length!==1)throw Error('Ambiguous source');await source.query("SELECT set_config('app.clinic_id',$1,true)",[sourceClinics[0].id]);
 const clinic=(await target.query("SELECT id FROM clinics WHERE code::text='kb-review'")).rows[0].id;await target.query("SELECT set_config('app.clinic_id',$1,true)",[clinic]);const actor=(await target.query("SELECT id FROM app_users WHERE username::text='admin'")).rows[0].id;await target.query("SELECT set_config('app.user_id',$1,true)",[actor]);
 const columns=(await source.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='date' AND table_name=ANY($1::text[])",[['patients','patient_registrations','appointments','daily_register','clinical_records','clinical_sheets','treatment_cases','treatment_plans','receipts','expenses','patient_documents','holidays']])).rows;
 let changed=0;for(const {table_name:table,column_name:column}of columns){const rows=(await target.query(`SELECT id,${q(column)} AS value FROM ${q(table)} ORDER BY ${q(column)} DESC NULLS LAST,id`)).rows;if(!rows.length)continue;const originals=(await source.query(`SELECT id,${q(column)} AS value FROM ${q(table)} WHERE id=ANY($1::uuid[])`,[rows.map(r=>r.id)])).rows;const lookup=new Map(originals.map(r=>[r.id,r.value]));for(const row of rows){if(lookup.has(row.id)&&lookup.get(row.id)!==row.value){if(!row.value||!lookup.get(row.id)||Date.parse(String(lookup.get(row.id)))-Date.parse(row.value)!==86400000)throw Error('Unexpected date difference; no correction applied');await target.query(`UPDATE ${q(table)} SET ${q(column)}=$1 WHERE id=$2`,[lookup.get(row.id),row.id]);changed++;}}}
 await target.query('COMMIT');console.log('Date-only source values restored in marked review; '+changed+' fields corrected.');
 }catch(e){await target.query('ROLLBACK');throw e;}finally{await source.end();await target.end();}}
main().catch(e=>{writeFileSync(new URL('private-date-error.json',root),JSON.stringify({error:e.message,code:e.code??null}),{mode:0o600});console.error('Review date correction failed; no source values printed.');process.exitCode=1;});
