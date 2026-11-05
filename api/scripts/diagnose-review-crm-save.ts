// Read-only diagnostics. Reconstruct the previously fingerprinted CRM state
// from its existing audit rows, then classify later collection-save changes.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {alignCrmStorageRows} from '../src/migration/crm-identity.js';
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url),full=new URL('../.organization-demo-runtime/realdata-full-rehearsal/',import.meta.url),state=JSON.parse(readFileSync(new URL('state.json',root),'utf8')),sourceState=JSON.parse(readFileSync(new URL('state.json',full),'utf8')),expected=JSON.parse(readFileSync(new URL('crm-reconciliation-summary.json',root),'utf8'));
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const blankNormalized=(v:Record<string,unknown>)=>Object.fromEntries(Object.entries(v).filter(([,x])=>x!==''&&x!==null&&x!==undefined));
async function main(){const source=new pg.Client({host:'localhost',database:'kb_realdata_full_rehearsal',user:sourceState.owner,password:sourceState.ownerPassword}),target=new pg.Client({host:'localhost',database:'kb_realdata_review',user:state.owner,password:state.ownerPassword});await source.connect();await target.connect();try{
 for(const[c,s]of [[source,sourceState],[target,state]]as const){await c.query('BEGIN READ ONLY');if((await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker!==s.marker)throw Error('Unexpected database');await c.query("SELECT set_config('app.clinic_id',(SELECT id::text FROM clinics WHERE code::text='kb-review'),true)");}
 const cols=['id','collection','position','data'];const originals=(await source.query('SELECT id,collection,position,data FROM crm_records ORDER BY id')).rows;
 const current=(await target.query('SELECT id,collection,position,data FROM crm_records ORDER BY id')).rows;
 const audit=(await target.query("SELECT DISTINCT ON(row_id) row_id,coalesce(after_row,before_row) AS record FROM audit_log WHERE table_name='crm_records' AND row_id=ANY($1::uuid[]) ORDER BY row_id,happened_at DESC,id DESC",[originals.map(r=>r.id)])).rows;
 const old=new Map(audit.map(r=>[r.row_id,r.record]));const baseline=originals.map(r=>Object.fromEntries(cols.map(c=>[c,old.get(r.id)?.[c]])));
 const aligned=alignCrmStorageRows(originals,current);let rawChanges=0,meaningfulChanges=0,positionChanges=0;const changes:unknown[]=[];const changedCollections:Record<string,number>={},changedFields:Record<string,number>={};
 const allowedFields=new Set(['name','stages','notes','stageId','pipelineId','updatedAt','privateLeadsMovedAt','boardsConsolidatedAt','color','order','id','type','isDefault']);
 for(let i=0;i<baseline.length;i++){const before=baseline[i]!,after=aligned.rows[i]!;if(stable(before.data)!==stable(after.data))rawChanges++;
  if(stable(blankNormalized(before.data as Record<string,unknown>))!==stable(blankNormalized(after.data))){meaningfulChanges++;const kind=after.collection==='pipelines'?'pipelines':'other';changedCollections[kind]=(changedCollections[kind]??0)+1;
   for(const key of new Set([...Object.keys(before.data as object),...Object.keys(after.data)]))if(stable((before.data as Record<string,unknown>)[key])!==stable(after.data[key])){const safe=allowedFields.has(key)?key:'other';changedFields[safe]=(changedFields[safe]??0)+1;}
   changes.push({status:'unverified_preserve_existing_review_change',before,after});}
  if(before.position!==after.position)positionChanges++;}
 const report={sourceRows:originals.length,currentRows:current.length,originalFingerprintMatches:hash(originals)===expected.originalSourceRowsHash,auditBaselineFingerprintMatches:hash(baseline)===expected.reviewSourceRowsHash,regeneratedStorageIds:aligned.regenerated,rawPayloadChanges:rawChanges,blankNormalizedPayloadChanges:meaningfulChanges,positionChanges,additionalReviewRows:aligned.additionalRows,changedCollections,changedFields};
 writeFileSync(new URL('verification-pending/PRIVATE-crm-review-changes.json',root),JSON.stringify({sourceUntouched:true,changes},null,2),{mode:0o600});
 writeFileSync(new URL('crm-save-normalization-proof.json',root),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{await source.end();await target.end();}}
main().catch(()=>{console.error('Read-only CRM diagnostic failed; no patient values printed.');process.exitCode=1;});
