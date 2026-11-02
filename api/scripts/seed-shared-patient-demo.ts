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
    await c.query("COMMIT"); console.log("Fictional identity ready. Search Orion Shared Demo from the other clinic to try explicit attachment. Existing patients unchanged.");
  }
} catch(e){await c.query("ROLLBACK");throw e;} finally {await c.end();}
