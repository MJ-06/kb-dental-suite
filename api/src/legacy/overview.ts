import {sql} from "kysely";
import {read,type ActionTable} from "./types.js";
import {setTenant} from "../db/index.js";

export const overview:ActionTable={
 getOrganizationReports:read(async(p,{tx,actor})=>{
  if(!actor.organizationId || !actor.permissions.has("roles:manage") || !actor.permissions.has("finance:read")) return {success:false,forbidden:true,error:"Organization report access is not granted"};
  const today=(await sql<{day:string}>`SELECT clinic_today()::text AS day`.execute(tx)).rows[0]!.day;
  const from=String(p.fromDate||today.slice(0,7)+"-01"),to=String(p.toDate||today);
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(from)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(to)||from>to) return {success:false,error:"Choose a valid date range"};
  const clinics=(await sql<{clinics:{id:string;name:string;user_id:string;timezone:string}[]}>`SELECT clinical_report_access(${actor.sessionHash!}) AS clinics`.execute(tx)).rows[0]!.clinics;
  const selected=String(p.clinicId||"");if(selected&&!clinics.some(c=>c.id===selected))return {success:false,forbidden:true,error:"Clinic report access is not granted"};
  const rows=[];
  try{for(const c of clinics.filter(c=>!selected||c.id===selected)){
   await setTenant(tx,c.id,c.user_id);
   const r=(await sql<any>`SELECT
    (SELECT count(*)::int FROM appointments WHERE (starts_at AT TIME ZONE ${c.timezone})::date BETWEEN ${from}::date AND ${to}::date AND status<>'Cancelled') AS appointments,
    (SELECT count(DISTINCT patient_id)::int FROM appointments WHERE (starts_at AT TIME ZONE ${c.timezone})::date BETWEEN ${from}::date AND ${to}::date AND status<>'Cancelled') AS patientsSeen,
    (SELECT count(*)::int FROM care_plans) AS carePlans,
    (SELECT count(*)::int FROM treatment_plans) AS treatmentPlans,
    (SELECT coalesce(sum(amount1+amount2),0)::float8 FROM receipts WHERE receipt_date BETWEEN ${from}::date AND ${to}::date) AS collections,
    (SELECT coalesce(sum(amount),0)::float8 FROM expenses WHERE voided_at IS NULL AND expense_date BETWEEN ${from}::date AND ${to}::date) AS expenses`.execute(tx)).rows[0];
   rows.push({clinicId:c.id,clinicName:c.name,...r});
  }}finally{await setTenant(tx,actor.clinicId,actor.userId);}
  return {success:true,fromDate:from,toDate:to,clinics:clinics.map(c=>({id:c.id,name:c.name})),rows,scope:"Only clinics with active report and finance permissions are included. Plan counts are all-time; other metrics use the selected dates."};
 },"reports:read"),
 getRecentPatients:read(async(p,{tx,actor})=>{
  const limit=Math.max(1,Math.min(20,Number(p.limit)||20));
  const appointmentSort=p.sort==="appointments" && actor.permissions.has("appointments:read");
  const rows=await sql<any>`SELECT p.uhid,p.full_name AS name,p.gender,
   to_char(p.date_of_birth,'DD/MM/YYYY') AS dob,p.mobile,
   l.organization_patient_id,o.uhid AS organization_uhid,p.registered_on,
   ${appointmentSort ? sql`(SELECT max(a.starts_at) FROM appointments a WHERE a.patient_id=p.id AND a.starts_at<=now() AND a.status NOT IN ('Cancelled','No Show'))` : sql`NULL::timestamptz`} AS last_appointment
   FROM patients p LEFT JOIN org_clinical_patient_links l ON l.patient_id=p.id AND l.clinic_id=p.clinic_id
   LEFT JOIN org_patients o ON o.id=l.organization_patient_id
   WHERE p.deleted_at IS NULL
   ORDER BY last_appointment DESC NULLS LAST,p.registered_on DESC,p.id DESC LIMIT ${Math.floor(limit)}`.execute(tx);
  return {success:true,patients:rows.rows,sort:appointmentSort?"appointments":"registered"};
 },"patients:read"),
 getClinicOverview:read(async(_p,{tx,actor})=>{
  const clinical=actor.permissions.has("clinical:read"),diary=actor.permissions.has("appointments:read");
  const row=(await sql<any>`SELECT clinic_today()::text AS today,
   ${actor.organizationId ? sql`(SELECT count(*)::int FROM org_patients)` : sql`(SELECT count(*)::int FROM patients WHERE deleted_at IS NULL)`} AS patients,
   (SELECT count(*)::int FROM pending_registrations) AS pending`.execute(tx)).rows[0];
  let carePlans:number|null=null,treatmentPlans:number|null=null;
  if(clinical){const r=(await sql<any>`SELECT (SELECT count(*)::int FROM care_plans) AS care,(SELECT count(*)::int FROM treatment_plans) AS treatment`.execute(tx)).rows[0];carePlans=r.care;treatmentPlans=r.treatment;}
  const appointments=diary?(await sql<any>`SELECT a.id,a.patient_name AS name,p.uhid,
   to_char(a.starts_at AT TIME ZONE ${actor.timezone},'HH24:MI') AS time,a.status,a.reason,a.doctor_name AS doctor
   FROM appointments a LEFT JOIN patients p ON p.id=a.patient_id
   WHERE (a.starts_at AT TIME ZONE ${actor.timezone})::date=clinic_today()
   AND a.status<>'Cancelled' ORDER BY a.starts_at,a.id LIMIT 10`.execute(tx)).rows:[];
  return {success:true,...row,carePlans,treatmentPlans,appointments,canViewAppointments:diary};
 },"patients:read")
};
