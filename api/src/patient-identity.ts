import { sql } from "kysely";
import type { Tx } from "./db/index.js";

// Overlay only the four shared identity fields. Clinic/financial/clinical fields
// remain the current clinic's, with the original local IDs and audit history.
export async function withSharedIdentity<T extends {id:string}>(tx:Tx, patients:T[]):Promise<T[]> {
  if (!patients.length) return patients;
  const rows=(await sql<{patient_id:string;full_name:string;mobile:string|null;gender:string|null;date_of_birth:string|null}>`
    SELECT l.patient_id,o.name AS full_name,nullif(o.phone,'') AS mobile,o.gender,o.dob AS date_of_birth
    FROM org_clinical_patient_links l JOIN org_patients o ON o.id=l.organization_patient_id
    WHERE l.clinic_id=app_clinic_id() AND l.patient_id IN (${sql.join(patients.map(p=>p.id))})`.execute(tx)).rows;
  const identities=new Map(rows.map(({patient_id,...identity})=>[patient_id,identity]));
  return patients.map(p=>({...p,...identities.get(p.id)}));
}
