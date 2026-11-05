// Private, read-only selection for the requested one-patient UI comparison.
// No patient values are printed or checked into Git.
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url),state=JSON.parse(readFileSync(new URL('state.json',root),'utf8'));
const c=new pg.Client({host:'localhost',database:'kb_realdata_review',user:state.owner,password:state.ownerPassword});
async function main(){await c.connect();try{await c.query('BEGIN READ ONLY');const marker=(await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==state.marker)throw Error('Unexpected database');
 await c.query("SELECT set_config('app.clinic_id',(SELECT id::text FROM clinics WHERE code::text='kb-review'),true)");
 const candidates=(await c.query(`WITH f AS (SELECT upper(uhid) AS u,count(*)::int AS n FROM clinical_records GROUP BY 1),
 k AS (SELECT upper(uhid) AS u,count(*)::int AS n FROM treatment_cases GROUP BY 1),
 ch AS (SELECT upper(uhid) AS u,count(*)::int AS n FROM clinical_sheets GROUP BY 1),
 dr AS (SELECT upper(uhid) AS u,count(*)::int AS n FROM daily_register GROUP BY 1),
 a AS (SELECT patient_id,count(*)::int AS n FROM appointments GROUP BY 1),
 pl AS (SELECT upper(uhid) AS u,CASE WHEN jsonb_typeof(plan_rows)='array' THEN jsonb_array_length(plan_rows) ELSE 0 END AS n FROM treatment_plans WHERE estimate->>'source' IS DISTINCT FROM 'Finance sheet, Working for Balance')
 SELECT p.id,p.uhid,p.full_name,coalesce(f.n,0) AS forms,coalesce(k.n,0) AS cases,coalesce(ch.n,0) AS charts,coalesce(dr.n,0) AS register,coalesce(a.n,0) AS appointments,coalesce(pl.n,0) AS plan_rows
 FROM patients p LEFT JOIN f ON f.u=upper(p.uhid) LEFT JOIN k ON k.u=upper(p.uhid) LEFT JOIN ch ON ch.u=upper(p.uhid) LEFT JOIN dr ON dr.u=upper(p.uhid) LEFT JOIN a ON a.patient_id=p.id LEFT JOIN pl ON pl.u=upper(p.uhid)
 WHERE p.deleted_at IS NULL AND coalesce(f.n,0)>0 AND coalesce(k.n,0)>0 ORDER BY coalesce(pl.n,0) DESC,coalesce(k.n,0) DESC,coalesce(ch.n,0) DESC,coalesce(f.n,0) DESC,coalesce(dr.n,0) DESC LIMIT 1`)).rows;
 const selected=candidates[0];if(!selected||selected.forms<1)throw Error('No populated case');
 const appts=(await c.query("SELECT (starts_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date,doctor_name FROM appointments WHERE patient_id=$1 ORDER BY starts_at DESC",[selected.id])).rows;
 const days=(await c.query('SELECT visit_date::text AS date,operating_doctor FROM daily_register WHERE upper(uhid)=upper($1) ORDER BY visit_date DESC',[selected.uhid])).rows;
 const recordTypes=(await c.query('SELECT tab_name,count(*)::int AS count FROM clinical_records WHERE upper(uhid)=upper($1) GROUP BY tab_name ORDER BY count DESC',[selected.uhid])).rows;
 const records=(await c.query('SELECT tab_name,fields FROM clinical_records WHERE upper(uhid)=upper($1) ORDER BY recorded_at DESC',[selected.uhid])).rows;
 const score=(r:{fields:Record<string,unknown>})=>Object.entries(r.fields).filter(([k,v])=>/doctor|assistant|staff|material|brand|batch|lot|graft|implant|sealer|cone/i.test(k)&&String(v??'').trim()).length;
 const preferred=records.filter(r=>r.tab_name==='Restoration');const record=(preferred.length?preferred:records).sort((a,b)=>score(b)-score(a))[0];
 const staffScore=(r:{fields:Record<string,unknown>})=>Object.entries(r.fields).filter(([k,v])=>/assistant|staff|nurse|hygienist/i.test(k)&&String(v??'').trim().length>2&&!/^(nil|none|n\/a|yes|no)$/i.test(String(v).trim())).length;
 const staffRecord=records.filter(r=>staffScore(r)>0).sort((a,b)=>staffScore(b)-staffScore(a))[0]??null;
 writeFileSync(new URL('private-ui-comparison-selection.json',root),JSON.stringify({patient:selected,appointments:appts,registerDays:days,recordTypes,record,staffRecord},null,2),{mode:0o600});
 console.log(JSON.stringify({selectedPatients:1,forms:selected.forms,cases:selected.cases,charts:selected.charts,registerEntries:selected.register,appointments:selected.appointments,authoredPlanRows:selected.plan_rows}));
 }finally{await c.end();}}
main().catch(e=>{console.error('Private comparison selection failed; safe error code: '+((e as {code?:string}).code??'selection_precondition')+'. No patient information printed.');process.exitCode=1;});
