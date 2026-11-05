// Preserve passive CRM source IDs; select contacts by explicit UHID only.
import {readFileSync,writeFileSync} from 'node:fs';import {parseEnv} from 'node:util';import {homedir} from 'node:os';import {join} from 'node:path';import pg from 'pg';
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url);
async function main(){
 const state=JSON.parse(readFileSync(new URL('state.json',root),'utf8'));if(!state.complete)throw Error('Review not complete');
 const config=parseEnv(readFileSync(new URL('app.env',root),'utf8')),sourceEnv=parseEnv(readFileSync(join(homedir(),'.kb-pms/owner.env'),'utf8'));
 const source=new pg.Client({connectionString:sourceEnv.REHEARSAL_OWNER_DATABASE_URL}),target=new pg.Client({connectionString:config.DATABASE_URL});await source.connect();await target.connect();
 try{await source.query('BEGIN READ ONLY');const cid=(await source.query('SELECT id FROM clinics')).rows;if(cid.length!==1)throw Error('Ambiguous source');await source.query("SELECT set_config('app.clinic_id',$1,true)",[cid[0].id]);
  const rows=(await source.query('SELECT id,collection,position,data FROM crm_records ORDER BY collection,position')).rows;
  const discovery=new pg.Client({host:'localhost',database:'kb_realdata_review',user:state.owner,password:state.ownerPassword});await discovery.connect();let clinic:string;try{const marker=(await discovery.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==state.marker)throw Error('Unexpected target');clinic=(await discovery.query("SELECT id FROM clinics WHERE code::text='kb-review'")).rows[0].id;}finally{await discovery.end();}
  await target.query('BEGIN');await target.query("SELECT set_config('app.clinic_id',$1,true)",[clinic!]);
  const actor=(await target.query("SELECT id FROM app_users WHERE username::text='admin'")).rows[0].id;await target.query("SELECT set_config('app.user_id',$1,true)",[actor]);
  const keys=new Set((await target.query('SELECT upper(uhid) AS key FROM patients WHERE deleted_at IS NULL')).rows.map(r=>r.key));
  const contacts=rows.filter(r=>r.collection==='contacts'&&keys.has(String(r.data.uhid??'').trim().toUpperCase()));const contactsIds=new Set(contacts.map(r=>r.data.id));
  const chosen=rows.filter(r=>r.collection==='contacts'?contactsIds.has(r.data.id):r.collection==='leads'?(keys.has(String(r.data.uhid??'').trim().toUpperCase())||contactsIds.has(r.data.contactId)):true);
  const current=Number((await target.query('SELECT count(*) AS n FROM crm_records')).rows[0].n);if(current){await target.query('ROLLBACK');console.log('Existing review CRM retained; no source data overwritten.');return;}
  const report:Record<string,{source:number;selected:number}>={};for(const row of rows){report[row.collection]??={source:0,selected:0};report[row.collection]!.source++;}
  for(const row of chosen){await target.query('INSERT INTO crm_records(id,collection,position,data) VALUES($1,$2,$3,$4::jsonb)',[row.id,row.collection,row.position,JSON.stringify(row.data)]);report[row.collection]!.selected++;}
  await target.query('COMMIT');writeFileSync(new URL('crm-verification-summary.json',root),JSON.stringify(report,null,2),{mode:0o600});console.log('Selected-patient CRM copied with source entity IDs preserved; counts saved privately.');
 }catch(e){await target.query('ROLLBACK');throw e;}finally{await source.end();await target.end();}
}
main().catch(()=>{console.error('CRM supplement stopped; no source values printed.');process.exitCode=1;});
