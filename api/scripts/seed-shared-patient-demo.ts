// Fictional identity only, for the two-clinic local UI journey.
import pg from "pg";
import { required } from "../src/env.js";
const c=new pg.Client({connectionString:required("OWNER_DATABASE_URL")}); await c.connect();
try {
  const database=(await c.query("SELECT current_database() AS name")).rows[0].name;
  const clinic=(await c.query("SELECT id FROM clinics WHERE code='kbdev' AND name='KB Dental (development)'")).rows[0];
  const organization=(await c.query("SELECT code FROM org_identity")).rows[0];
  if(database!=="kb_pms" || !clinic || organization?.code!=="kb-local") throw new Error("This fixture is limited to the linked local development organization");
  if(!process.argv.includes("--apply")) console.log("Dry run: would create one fictional Orion Shared Demo identity at kbdev, with no clinical history. Use --apply.");
  else {
    await c.query("BEGIN"); await c.query("SELECT set_config('app.clinic_id',$1,true)",[clinic.id]);
    const existing=await c.query("SELECT id FROM patients WHERE full_name='Orion Shared Demo' AND mobile='9000000071' AND date_of_birth='1990-01-15' AND deleted_at IS NULL");
    if(!existing.rows.length) await c.query("INSERT INTO patients(uhid,full_name,mobile,date_of_birth,gender) VALUES(next_uhid(),'Orion Shared Demo','9000000071','1990-01-15','Other')");
    if(process.argv.includes("--history")) {
      const source=(await c.query("SELECT id FROM patients WHERE full_name='Orion Shared Demo' AND mobile='9000000071' AND date_of_birth='1990-01-15' AND deleted_at IS NULL")).rows[0];
      const canonical=(await c.query("SELECT clinical_publish_patient($1) AS id",[source.id])).rows[0].id;
      for(const [code,doctor,date,material] of [
        ["kbdev","Dr Rowan Example","2026-10-28","Synthetic material A"],
        ["kbdev-east","Dr Morgan Example","2026-11-02","Synthetic material B"]
      ]) {
        const target=(await c.query("SELECT id FROM clinics WHERE code=$1",[code])).rows[0];
        if(!target) throw new Error("Run the local clinic linker first");
        await c.query("SELECT set_config('app.clinic_id',$1,true)",[target.id]);
        const user=(await c.query("SELECT u.id FROM app_users u JOIN roles r ON r.id=u.role_id AND r.clinic_id=u.clinic_id WHERE u.active AND r.permissions @> ARRAY['patients:read','clinical:read']::text[] ORDER BY u.username LIMIT 1")).rows[0];
        if(!user) throw new Error("Expected a local clinical fixture account");
        await c.query("SELECT set_config('app.user_id',$1,true)",[user.id]);
        const reference=(await c.query("SELECT clinical_open_patient($1) AS patient",[canonical])).rows[0].patient;
        if(!reference) throw new Error("Could not open the fictional fixture");
        await c.query("INSERT INTO daily_register(patient_id,uhid,visit_date,procedure_done,work_done,operating_doctor,tooth_no) VALUES($1,$2,$3,'Synthetic care example','Demonstration only; no real clinical care',$4,'Demo site') ON CONFLICT DO NOTHING",[reference.id,reference.uhid,date,doctor]);
        await c.query("INSERT INTO clinical_records(patient_id,uhid,tab_name,fields,recorded_at) SELECT $1,$2,'Synthetic material example',$3::jsonb,$4::timestamptz WHERE NOT EXISTS(SELECT 1 FROM clinical_records WHERE patient_id=$1 AND fields->>'DemoFixture'='shared-history-v1')",[reference.id,reference.uhid,JSON.stringify({DemoFixture:"shared-history-v1",Doctor:doctor,Treatment:"Synthetic treatment example",Material:material,LOT:"DEMO-LOT-01",Notes:"Fictional history used only to demonstrate clinic attribution"}),date+"T10:00:00+05:30"]);
      }
    }
    await c.query("COMMIT"); console.log("Fictional identity ready. Search Orion Shared Demo from either clinic. Optional --history seeds labelled synthetic care/material examples; existing patient records are unchanged.");
  }
} catch(e){await c.query("ROLLBACK");throw e;} finally {await c.end();}
