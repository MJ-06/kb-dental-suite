// User-approved private packet for later source-owner/Viveyk verification.
// Database access is read-only; no patient values are printed or committed.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,copyFileSync,existsSync} from 'node:fs';
import pg from 'pg';
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url),folder=new URL('verification-pending/',root);
const state=JSON.parse(readFileSync(new URL('state.json',root),'utf8'));
async function main(){if(!process.argv.includes('--apply')){console.log('Dry run: create a private verification packet of inferred/ambiguous source details; no DB edits.');return;}
 const c=new pg.Client({host:'localhost',database:'kb_realdata_review',user:state.owner,password:state.ownerPassword});await c.connect();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const marker=(await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==state.marker)throw Error('Unexpected review database');
  await c.query("SELECT set_config('app.clinic_id',(SELECT id::text FROM clinics WHERE code::text='kb-review'),true)");
  const packet={status:'unverified_do_not_promote_to_confirmed_clinical_facts',createdAt:new Date().toISOString(),
   registrationDates:(await c.query("SELECT p.id,p.uhid,p.full_name,p.registered_on,r.form->>'reg_date_source' AS source FROM patients p JOIN patient_registrations r ON r.patient_id=p.id WHERE r.form->>'reg_date_source' IN ('uhid_month','first_data')")).rows,
   receiptDescriptions:(await c.query("SELECT id,uhid,patient_name,receipt_date,receipt_no,legacy_receipt_no,service,service_source FROM receipts WHERE service_source IN ('register','register_near')")).rows,
   financialOpeningEstimates:(await c.query("SELECT id,uhid,patient_name,plan_date,estimate FROM treatment_plans WHERE estimate->>'source'='Finance sheet, Working for Balance'")).rows,
   recoveredIdentities:(await c.query("SELECT id,uhid,full_name,import_provenance FROM patients WHERE import_provenance->>'review_required'='true'")).rows};
  mkdirSync(folder,{recursive:true,mode:0o700});writeFileSync(new URL('PRIVATE-unverified-records.json',folder),JSON.stringify(packet,null,2),{mode:0o600});
  const reference=new URL('private-ui-comparison-selection.json',root);if(existsSync(reference)){const selected=JSON.parse(readFileSync(reference,'utf8'));const baseline=new URL('private-ui-comparison-api.json',root);writeFileSync(new URL('PRIVATE-ui-reference.json',folder),JSON.stringify({patient:{uhid:selected.patient.uhid,name:selected.patient.full_name},snapshotCounts:{cases:selected.patient.cases,forms:selected.patient.forms,register:selected.patient.register,appointments:selected.patient.appointments},daysheetDate:existsSync(baseline)?JSON.parse(readFileSync(baseline,'utf8')).date:null},null,2),{mode:0o600});}
  const exceptions=new URL('../../../migration/data/out/',root);let copied=0;
  try{for(const name of readdirSync(exceptions)){if(!/^(rejects|review|duplicates|orphans)[^/\\]*\.csv$/i.test(name))continue;copyFileSync(new URL(name,exceptions),new URL(name,folder));copied++;}}catch(e){if((e as {code?:string}).code!=='ENOENT')throw e;}
  const summary={registrationDateEstimates:packet.registrationDates.length,receiptDescriptionSuggestions:packet.receiptDescriptions.length,financialOpeningEstimates:packet.financialOpeningEstimates.length,recoveredIdentities:packet.recoveredIdentities.length,sourceExceptionFiles:copied,sentToAnyone:false,originalDatabaseUnchanged:true};
  writeFileSync(new URL('summary.json',folder),JSON.stringify(summary,null,2),{mode:0o600});
  writeFileSync(new URL('README-PRIVATE.txt',folder),'PRIVATE patient information — for authorized source-owner/Viveyk verification only.\nKeep this folder out of Git and do not publish it through the demo tunnel.\nNo data was sent to anyone. Transfer privately to the authorized reviewer.\nThe JSON separates estimated registration dates, suggested receipt descriptions, finance opening estimates and review-required recovered identities. Original exception CSVs, when available, remain unresolved source references.\nVerify against original exports and the clinic record owner. Record confirmed correction, evidence, reviewer and date before changing confirmed data. Never merge by name/phone or turn opening balances into clinician-authored plans.\nNo clinical facts, source records or original exports were modified.\n',{mode:0o600});console.log(JSON.stringify(summary));
 }finally{await c.end();}}
main().catch(()=>{console.error('Private verification packet export failed; no patient values printed.');process.exitCode=1;});
