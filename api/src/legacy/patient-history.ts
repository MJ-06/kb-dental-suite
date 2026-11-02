import { sql } from "kysely";
import { setTenant } from "../db/index.js";
import { read, type ActionTable } from "./types.js";
import { str, uhidOf } from "./util.js";

type Clinic = {id:string;name:string;timezone:string;user_id:string};
type Event = {id:string;kind:string;time:string;title:string;doctor:string|null;details:Record<string,unknown>;clinicId:string;clinicName:string;timezone:string;key:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Clinical fields only. Never return whole untyped payloads that may contain fees.
const FIELDS=["Procedure","Treatment","Diagnosis","Findings","Notes","Work Done","Tooth No.","Tooth No","Doctor","Treating Doctor","Material","Materials Used","Implant Brand","LOT","LOT No.","Batch","Site"];
export const patientHistoryActions:ActionTable = {
  getPatientHistory:read(async(p,{tx,actor})=>{
    if(!actor.organizationId) return {success:false,error:"Organization patient history is not configured"};
    let id=str(p.organizationPatientId);
    if(!id) id=(await sql<{id:string}>`SELECT l.organization_patient_id AS id FROM org_clinical_patient_links l
      JOIN patients p ON p.id=l.patient_id AND p.clinic_id=l.clinic_id
      WHERE l.clinic_id=${actor.clinicId} AND p.uhid=${uhidOf(p.uhid)} AND p.deleted_at IS NULL`.execute(tx)).rows[0]?.id ?? "";
    if(!UUID.test(id)) return {success:false,error:"Patient identity is not available"};
    const patient=(await sql<{id:string;uhid:string;name:string}>`SELECT id,uhid,name FROM org_patients WHERE id=${id}`.execute(tx)).rows[0];
    if(!patient) return {success:false,error:"Patient identity is not available"};
    const clinics=(await sql<{clinics:Clinic[]}>`SELECT clinical_history_access(${actor.sessionHash!}) AS clinics`.execute(tx)).rows[0]!.clinics;
    if(!clinics.length) return {success:false,forbidden:true,error:"Your clinic grants do not allow clinical history"};
    const filter=str(p.clinicId);
    if(filter && !clinics.some(c=>c.id===filter)) return {success:false,forbidden:true,error:"Clinic history is not available"};
    let after="";
    if(p.cursor) {
      try {
        if(typeof p.cursor!=="string" || p.cursor.length>1500) throw Error();
        const cursor=JSON.parse(Buffer.from(p.cursor,"base64url").toString());
        if(cursor.patient!==id || cursor.filter!==filter || typeof cursor.after!=="string" || cursor.after.length>250) throw Error();
        after=cursor.after;
      } catch { return {success:false,error:"Invalid history cursor"}; }
    }
    const events:Event[]=[];
    try {
      for(const clinic of clinics.filter(c=>!filter || c.id===filter)) {
        await setTenant(tx,clinic.id,clinic.user_id);
        const local=(await sql<{patient_id:string;uhid:string}>`SELECT l.patient_id,p.uhid FROM org_clinical_patient_links l
          JOIN patients p ON p.id=l.patient_id AND p.clinic_id=l.clinic_id
          WHERE l.organization_patient_id=${id} AND l.clinic_id=${clinic.id} AND p.deleted_at IS NULL`.execute(tx)).rows[0];
        if(!local) continue;
        const rows=(await sql<Omit<Event,"clinicId"|"clinicName"|"timezone">>`WITH events AS (
          SELECT id,'register'::text AS kind,visit_date::timestamp AT TIME ZONE ${clinic.timezone} AS occurred,
            'Care register entry'::text AS title,operating_doctor AS doctor,
            jsonb_strip_nulls(jsonb_build_object('Procedure',procedure_done,'Tooth',tooth_no,'Work done',work_done,'Assessment',initial_assessment)) AS details
          FROM daily_register WHERE patient_id=${local.patient_id} OR (patient_id IS NULL AND upper(uhid)=${local.uhid.toUpperCase()})
          UNION ALL SELECT id,'medical',collected_at,'Medical / registration history',NULL,
            jsonb_strip_nulls(jsonb_build_object('Conditions',conditions,'Allergies',allergies,'Medicines',medicines,'Habits',habits,'Complaint',chief_complaint))
          FROM patient_registrations WHERE patient_id=${local.patient_id}
          UNION ALL SELECT id,'form',recorded_at,tab_name,coalesce(nullif(fields->>'Treating Doctor',''),nullif(fields->>'Doctor','')),
            coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(fields) WHERE key=ANY(${FIELDS}) AND jsonb_typeof(value) IN ('string','number','boolean')),'{}'::jsonb)
          FROM clinical_records WHERE patient_id=${local.patient_id} OR (patient_id IS NULL AND upper(uhid)=${local.uhid.toUpperCase()})
          UNION ALL SELECT id,'chart',updated_at,'Chart updated: '||sheet_type,NULL,'{}'::jsonb FROM clinical_sheets
          WHERE patient_id=${local.patient_id} OR (patient_id IS NULL AND upper(uhid)=${local.uhid.toUpperCase()})
          UNION ALL SELECT id,'case',opened_at,'Treatment case: '||procedure_name,NULL,
            jsonb_build_object('Case',case_ref,'Tooth',tooth_ref,'Status',case_status)
          FROM treatment_cases WHERE patient_id=${local.patient_id} OR (patient_id IS NULL AND upper(uhid)=${local.uhid.toUpperCase()})
        ), stamped AS (SELECT id,kind,title,doctor,details,to_char(occurred AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time FROM events),
        keyed AS (SELECT *,time||'|'||${clinic.id}||'|'||kind||'|'||id::text AS key FROM stamped)
        SELECT * FROM keyed WHERE (${after}='' OR key<${after}) ORDER BY key DESC LIMIT 31`.execute(tx)).rows;
        events.push(...rows.map(e=>({...e,clinicId:clinic.id,clinicName:clinic.name,timezone:clinic.timezone})));
      }
    } finally { await setTenant(tx,actor.clinicId,actor.userId); }
    events.sort((a,b)=>a.key<b.key?1:a.key>b.key?-1:0);
    const page=events.slice(0,30);
    return {success:true,patient,events:page,clinics:clinics.map(({id,name})=>({id,name})),
      scope:"Only history permitted by your clinic access is shown. Other records may not be included.",
      nextCursor:events.length>30?Buffer.from(JSON.stringify({patient:id,filter,after:page.at(-1)!.key})).toString("base64url"):null};
  },"patients:read")
};
