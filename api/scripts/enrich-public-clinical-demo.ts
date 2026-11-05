// Idempotent examples in the marked synthetic database only; never touches source data.
import {readFileSync} from "node:fs";
import pg from "pg";
const root=new URL("../.organization-demo-runtime/public-clinical/",import.meta.url);
async function main(){
 if(!process.argv.includes("--apply")){console.log("Dry run: add synthetic plans, receipts, expenses and appointments in the dedicated public demo only.");return;}
 const state=JSON.parse(readFileSync(new URL("state.json",root),"utf8"));
 if(!state.complete)throw Error("Incomplete synthetic setup");
 const c=new pg.Client({host:"localhost",database:"kb_public_clinical_demo",user:state.app,password:state.appPassword});await c.connect();
 try{
  const marker=(await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;
  if(marker!==state.marker)throw Error("Unexpected database marker");
  await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(hashtextextended('public-synthetic-enrichment',0))");
  const org=(await c.query("SELECT id FROM org_identity WHERE code='review-demo'")).rows[0]?.id;if(!org)throw Error("Unexpected organization");
  await c.query("SELECT set_config('app.organization_id',$1,true)",[org]);
  // The mapping is owner-managed. Read only that mapping with the existing
  // owner credential; all fixture writes use the existing runtime role.
  const discovery=new pg.Client({host:"localhost",database:"kb_public_clinical_demo",user:state.owner,password:state.ownerPassword});await discovery.connect();
  let clinics:Array<{clinic_id:string}>;try{clinics=(await discovery.query("SELECT clinic_id FROM org_clinical_units WHERE organization_id=$1 ORDER BY clinic_id",[org])).rows;}finally{await discovery.end();}
  if(clinics.length!==2)throw Error("Expected two synthetic clinics");
  for(const {clinic_id} of clinics){
   await c.query("SELECT set_config('app.clinic_id',$1,true)",[clinic_id]);
   const user=(await c.query("SELECT id FROM app_users WHERE username='admin'")).rows[0].id;await c.query("SELECT set_config('app.user_id',$1,true)",[user]);
   const today=(await c.query("SELECT clinic_today()::text AS day")).rows[0].day;
   const patients=(await c.query("SELECT id,uhid,full_name AS name FROM patients WHERE full_name IN ('Aster Demo Patient','Cedar Demo Patient','Juniper Demo Patient') AND deleted_at IS NULL ORDER BY full_name")).rows;
   for(let n=0;n<patients.length;n++){
    const central=patients[n],patient=central;
    const rows=[{tooth:"16",dept:"Conservative Dentistry",procedure:"Demo composite restoration",details:"Synthetic example only"},{tooth:"All",dept:"Preventive Dentistry",procedure:"Demo scaling",details:"Fictional follow-up"}];
    const p1={chiefComplaint:"Fictional sensitivity for prototype review",medHistory:"Synthetic record; no actual clinical care",allergies:"Demo: none recorded",provisionalDiagnosis:"Demonstration only",treatments:[{option:"Demo restoration",prognosis:"Synthetic example",outcome:"Planned",charges:"1500"}]};
    await c.query("INSERT INTO care_plans(patient_id,uhid,patient_name,plan_date,page1,page2,page3,page4) VALUES($1,$2,$3,$4,$5::jsonb,'{}'::jsonb,$6::jsonb,$7::jsonb) ON CONFLICT(clinic_id,uhid) DO NOTHING",[patient.id,patient.uhid,central.name,today,JSON.stringify(p1),JSON.stringify({provisionalDiagnosis:"Demonstration only",specialNotes:"Synthetic care plan for testing",medCorrelation:"No actual prescription"}),JSON.stringify({rows})]);
    const planRows=rows.map((r,i)=>({...r,id:i+1,phase:"Phase 1",price:i===0?1000:500,qty:1,selected:true,isOpt:false,gid:null}));
    await c.query("INSERT INTO treatment_plans(patient_id,uhid,patient_name,plan_date,plan_rows,estimate) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(clinic_id,uhid) DO NOTHING",[patient.id,patient.uhid,central.name,today,JSON.stringify(planRows),JSON.stringify({subtotal:1500,discount:0,total:1500})]);
    for(let i=0;i<2;i++){
     const key=`SYNTHETIC-REVIEW-RECEIPT-${central.id}-${i}`;
     if(!(await c.query("SELECT 1 FROM receipts WHERE remarks=$1",[key])).rowCount)await c.query("INSERT INTO receipts(receipt_no,receipt_date,patient_id,uhid,patient_name,service,mode1,amount1,amount2,remarks,legacy_receipt_no) VALUES(next_receipt_no(),clinic_today()-$1::int,$2,$3,$4,'Demo staged treatment',$5,$6,0,$7,next_receipt_label(clinic_today()-$1::int))",[i===0?7:0,patient.id,patient.uhid,central.name,i===0?"Cash":"UPI",i===0?300:500,key]);
    }
    for(const offset of [-2,0]){
     const key=`SYNTHETIC-REVIEW-APPOINTMENT-${central.id}-${offset}-${today}`;
     if(!(await c.query("SELECT 1 FROM appointments WHERE notes=$1 OR (patient_id=$2 AND notes LIKE 'SYNTHETIC-REVIEW-APPOINTMENT-%' AND starts_at=(clinic_today()+$3::int+($4::text)::time) AT TIME ZONE 'Asia/Kolkata')",[key,patient.id,offset,`${10+n}:00`])).rowCount)await c.query("INSERT INTO appointments(patient_id,patient_name,starts_at,ends_at,reason,doctor_name,notes,status) VALUES($1,$2,(clinic_today()+$3::int+($4::text)::time) AT TIME ZONE 'Asia/Kolkata',(clinic_today()+$3::int+($4::text)::time) AT TIME ZONE 'Asia/Kolkata'+interval '30 minutes','Demo review','Dr Rowan Example',$5,$6)",[patient.id,central.name,offset,`${10+n}:00`,key,offset<0?"Completed":"Scheduled"]);
    }
   }
   for(let i=0;i<2;i++){
    const key=`SYNTHETIC-REVIEW-EXPENSE-${i}`;
    await c.query("INSERT INTO expenses(expense_date,paid_by,expense_name,amount,mode,remarks,legacy_id) VALUES(clinic_today()-$1::int,'Demo Administrator',$2,$3,'UPI','Fictional demo expense',$4) ON CONFLICT(clinic_id,legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING",[i===0?7:0,i===0?"Demo dental supplies":"Demo utilities",i===0?450:200,key]);
   }
  }
  await c.query("COMMIT");console.log("Synthetic examples added for existing demo patients: care/treatment plans, part-payments, expenses and appointments in both clinics. Existing reviewer edits retained.");
 }catch(e){await c.query("ROLLBACK");throw e;}finally{await c.end();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Demo enrichment failed");process.exitCode=1;});
