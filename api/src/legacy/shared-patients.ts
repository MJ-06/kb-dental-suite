import { sql } from "kysely";
import { read, write, type ActionTable } from "./types.js";
import { str } from "./util.js";

export const sharedPatientActions: ActionTable = {
  openOrganizationPatient:read(async(p,{tx,actor})=>{
    const id=str(p.organizationPatientId);
    if(!actor.organizationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return {success:false,error:"Invalid organization patient"};
    const local=(await sql<{patient:{id:string;uhid:string}|null}>`SELECT clinical_open_patient(${id}::uuid) AS patient`.execute(tx)).rows[0]!.patient;
    if(!local) return {success:false,error:"Patient is not available",forbidden:true};
    return {success:true,...local,organizationPatientId:id};
  },"patients:read"),
  searchOrganizationPatients: read(async (p,{tx,actor}) => {
    if (!actor.organizationId) return { success:false,error:"Organization directory is not configured" };
    const q=str(p.query);
    if (q.length<2 || q.length>100) return {success:false,error:"Enter between 2 and 100 characters"};
    const like=`%${q.replace(/[%_\\]/g,"\\$&")}%`;
    const rows=(await sql<any>`SELECT o.id AS organization_patient_id,o.uhid AS organization_uhid,o.name,o.phone AS mobile,
      o.gender,to_char(o.dob,'DD/MM/YYYY') AS dob,o.version AS identity_version,p.uhid AS local_uhid,o.import_review_required
      FROM org_patients o LEFT JOIN org_clinical_patient_links l ON l.organization_patient_id=o.id AND l.clinic_id=${actor.clinicId}
      LEFT JOIN patients p ON p.id=l.patient_id AND p.deleted_at IS NULL
      WHERE (o.name ILIKE ${like} OR o.uhid ILIKE ${like} OR o.phone ILIKE ${like} OR p.uhid ILIKE ${like})
      ORDER BY o.name,o.id LIMIT 20`.execute(tx)).rows;
    return {success:true,patients:rows.map(r=>({...r,uhid:r.local_uhid ?? r.organization_uhid,dob:r.dob ?? "",gender:r.gender ?? "",atCurrentClinic:!!r.local_uhid}))};
  },"patients:read"),
  attachOrganizationPatient: write("patients:write",async(p,{tx,actor})=>{
    const id=str(p.organizationPatientId);
    if (!actor.organizationId || !/^[0-9a-f-]{36}$/i.test(id)) return {success:false,error:"Invalid organization patient"};
    const local=(await sql<{patient:{id:string;uhid:string}|null}>`SELECT clinical_attach_patient(${id}::uuid) AS patient`.execute(tx)).rows[0]!.patient;
    if (!local) return {success:false,error:"Organization patient is not available",forbidden:true};
    return {success:true,...local};
  })
};
