// Explicit backfill: existing records keep their clinic IDs, UHIDs and history.
import pg from "pg";
import { required } from "../src/env.js";
const client=new pg.Client({connectionString:required("OWNER_DATABASE_URL")});
await client.connect();
try {
  await client.query("BEGIN");
  const clinics=(await client.query("SELECT clinic_id,organization_id FROM org_clinical_units ORDER BY clinic_id")).rows;
  let count=0;
  for (const clinic of clinics) {
    await client.query("SELECT set_config('app.clinic_id',$1,true),set_config('app.organization_id',$2,true)",[clinic.clinic_id,clinic.organization_id]);
    const rows=(await client.query("SELECT p.id FROM patients p LEFT JOIN org_clinical_patient_links l ON l.patient_id=p.id AND l.clinic_id=p.clinic_id WHERE p.deleted_at IS NULL AND l.patient_id IS NULL ORDER BY p.id")).rows;
    count+=rows.length;
    if(process.argv.includes("--apply")) for(const row of rows) await client.query("SELECT clinical_publish_patient($1)",[row.id]);
  }
  await client.query(process.argv.includes("--apply") ? "COMMIT" : "ROLLBACK");
  console.log(`${process.argv.includes("--apply") ? "Published" : "Dry run: would publish"} ${count} patient identities across ${clinics.length} linked clinics. No identities merged; no clinical records copied or moved.`);
} catch(e) {await client.query("ROLLBACK");throw e;} finally {await client.end();}
