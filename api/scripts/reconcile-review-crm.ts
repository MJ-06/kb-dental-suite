// Preserve existing UI edits when a full append encounters the same CRM entity ID.
// This touches only marked demo copies; original exports/rehearsal stay read-only.
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {createHash} from 'node:crypto';
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url),sourceRoot=new URL('../.organization-demo-runtime/realdata-full-rehearsal/',import.meta.url);
const state=JSON.parse(readFileSync(new URL('state.json',root),'utf8')),sourceState=JSON.parse(readFileSync(new URL('state.json',sourceRoot),'utf8'));
const source=new pg.Client({host:'localhost',database:'kb_realdata_full_rehearsal',user:sourceState.owner,password:sourceState.ownerPassword}),target=new pg.Client({host:'localhost',database:'kb_realdata_review',user:state.owner,password:state.ownerPassword});
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
async function main(){if(!process.argv.includes('--apply')){console.log('Dry run: reconcile only proven appended CRM duplicates, preserving the prior review payload.');return;}
 await source.connect();await target.connect();try{await source.query('BEGIN READ ONLY');await target.query('BEGIN');
 for(const [c,s]of [[source,sourceState],[target,state]]as const){const marker=(await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==s.marker)throw Error('Unexpected marked database');await c.query("SELECT set_config('app.clinic_id',(SELECT id::text FROM clinics WHERE code::text='kb-review'),true)");}
 const actor=(await target.query("SELECT id FROM app_users WHERE username::text='admin'")).rows[0].id;await target.query("SELECT set_config('app.user_id',$1,true)",[actor]);
 const originals=(await source.query('SELECT id,collection,position,data FROM crm_records')).rows,ids=new Set(originals.map(r=>r.id));
 const review=(await target.query('SELECT id,collection,position,data FROM crm_records')).rows;
 let reconciled=0;for(const current of review.filter(r=>!ids.has(r.id)&&r.data.id)){
  const sourceEntity=originals.find(r=>r.collection===current.collection&&r.data.id===current.data.id);if(!sourceEntity)continue;
  if(review.filter(r=>r.collection===current.collection&&r.data.id===current.data.id).length!==2)throw Error('Ambiguous CRM collision');
  const appended=review.find(r=>r.id===sourceEntity.id);if(!appended||stable(appended.data)!==stable(sourceEntity.data))throw Error('Appended CRM record already changed; refusing automatic reconciliation');
  await target.query('UPDATE crm_records SET data=$1::jsonb,position=$2 WHERE id=$3',[JSON.stringify(current.data),current.position,sourceEntity.id]);
  await target.query('DELETE FROM crm_records WHERE id=$1',[current.id]);reconciled++;
 }
 const collisions=(await target.query("SELECT collection,data->>'id' AS entity,count(*)::int AS n FROM crm_records WHERE nullif(data->>'id','') IS NOT NULL GROUP BY 1,2 HAVING count(*)>1")).rows;
 const introduced=collisions.filter(r=>r.n>originals.filter(s=>s.collection===r.collection&&String(s.data.id)===r.entity).length).length;if(introduced)throw Error('Unresolved CRM entity collisions');const duplicates=collisions.length;
 const skip=new Set(['clinic_id','version','created_at','updated_at','created_by','updated_by']);const cols=(await source.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_records' ORDER BY ordinal_position")).rows.map(r=>r.column_name).filter(c=>!skip.has(c));const columns=cols.map(c=>'"'+c+'"').join(',');
 const originalFields=(await source.query(`SELECT ${columns} FROM crm_records ORDER BY id`)).rows,reviewFields=(await target.query(`SELECT ${columns} FROM crm_records WHERE id=ANY($1::uuid[]) ORDER BY id`,[originals.map(r=>r.id)])).rows;
 const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 await target.query('COMMIT');writeFileSync(new URL('crm-reconciliation-summary.json',root),JSON.stringify({reconciled,sourceRowsWithReviewChanges:reviewFields.filter((r,i)=>stable(r)!==stable(originalFields[i])).length,originalSourceRowsHash:fingerprint(originalFields),reviewSourceRowsHash:fingerprint(reviewFields),introducedDuplicateEntityIds:0,preexistingSourceDuplicateGroups:duplicates,preservedReviewChanges:true,sourceUntouched:true},null,2),{mode:0o600});console.log('CRM duplicate reconciliation complete; '+reconciled+' existing UI records preserved; no additional duplicate entity IDs remain.');
 }catch(e){await target.query('ROLLBACK');writeFileSync(new URL('private-crm-reconciliation-error.json',root),JSON.stringify({error:e instanceof Error?e.message:'Unknown',code:(e as {code?:string}).code??null}),{mode:0o600});throw e;}finally{await source.end();await target.end();}}
main().catch(()=>{console.error('CRM reconciliation stopped safely; no patient data printed.');process.exitCode=1;});
