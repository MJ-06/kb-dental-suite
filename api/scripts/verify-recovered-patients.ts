// Read-only workbook/DB comparison. Patient-bearing payload remains in memory.
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {preservePostgresDates} from '../src/migration/pg-dates.js';
preservePostgresDates();
const full=process.argv.includes('--all'),root=new URL(full?'../.organization-demo-runtime/realdata-full-rehearsal/':'../.organization-demo-runtime/realdata-review/',import.meta.url);
const state=JSON.parse(readFileSync(new URL('state.json',root),'utf8'));
const env=parseEnv(readFileSync(join(homedir(),'.kb-pms/owner.env'),'utf8'));
const source=new pg.Client({connectionString:env.REHEARSAL_OWNER_DATABASE_URL});
const target=new pg.Client({host:'localhost',database:full?'kb_realdata_full_rehearsal':'kb_realdata_review',user:state.owner,password:state.ownerPassword});
async function main(){await source.connect();await target.connect();try{
 await source.query('BEGIN READ ONLY');await target.query('BEGIN READ ONLY');
 const sourceClinic=(await source.query('SELECT id FROM clinics')).rows;if(sourceClinic.length!==1)throw Error('Ambiguous source');
 await source.query("SELECT set_config('app.clinic_id',$1,true)",[sourceClinic[0].id]);
 const keys=(await source.query('SELECT upper(uhid) AS uhid FROM patients')).rows;
 const payload=JSON.parse(execFileSync('py',['-X','utf8',fileURLToPath(new URL('../../migration/audit_patient_coverage.py',import.meta.url)),'--migration-payload'],{input:JSON.stringify(keys),encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],maxBuffer:16*1024*1024}));
 const clinic=(await target.query("SELECT id FROM clinics WHERE code::text='kb-review'")).rows[0].id,org=(await target.query("SELECT id FROM org_identity WHERE code::text='kb-real-review'")).rows[0].id;
 await target.query("SELECT set_config('app.clinic_id',$1,true),set_config('app.organization_id',$2,true)",[clinic,org]);
 const rows=(await target.query("SELECT p.*,o.import_review_required FROM patients p JOIN org_clinical_patient_links l ON l.patient_id=p.id AND l.clinic_id=p.clinic_id JOIN org_patients o ON o.id=l.organization_patient_id WHERE p.import_provenance->>'identity_source'='historical_record_only'")).rows;
 if(rows.length!==payload.patients.length)throw Error('Recovered cohort count mismatch');
 for(const expected of payload.patients){const actual=rows.find(r=>r.uhid===expected.uhid);
  if(!actual||actual.full_name!==expected.name||actual.mobile!==expected.mobile||actual.date_of_birth!==expected.dob||actual.gender!==expected.gender||actual.patient_type!==null||!actual.import_review_required)throw Error('Recovered source field mismatch');
  const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
  if(stable(actual.import_provenance)!==stable(expected.provenance))throw Error('Recovered provenance mismatch');
 }
 const dates=(await target.query("SELECT form->>'reg_date_source' AS source,count(*)::int AS count FROM patient_registrations GROUP BY 1 ORDER BY 1")).rows;
 const receipts=(await target.query('SELECT service_source AS source,count(*)::int AS count FROM receipts GROUP BY 1 ORDER BY 1')).rows;
 const plans=(await target.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE estimate->>'source'='Finance sheet, Working for Balance')::int AS financeOpeningEstimates FROM treatment_plans")).rows[0];
 const report={recoveredIdentities:rows.length,sourceDemographicsAndProvenanceMatch:true,missingPatientTypesRemainNull:true,allRequireReview:true,registrationDateSources:dates,receiptDescriptionSources:receipts,treatmentPlanProvenance:plans};
 writeFileSync(new URL('recovered-patient-verification.json',root),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{await source.end();await target.end();}}
main().catch(()=>{console.error('Recovered identity verification failed; no patient values printed.');process.exitCode=1;});
