import {sql} from "kysely";
import {read,write,type ActionTable} from "./types.js";
import {str,uhidOf,isoDay,num} from "./util.js";
import {dobToISO} from "./patients.js";
export const cghs:ActionTable={
 saveCghsBill:write("finance:write",async(p,{tx})=>{
  const uhid=uhidOf(p.uhid),amount=num(p.amount),day=isoDay(p.billDate)||dobToISO(p.billDate)||(await sql<{day:string}>`SELECT clinic_today()::text AS day`.execute(tx)).rows[0]!.day;
  if(amount===null||amount<0)return {success:false,error:"Enter a valid bill amount"};
  const patient=(await sql<{id:string;name:string}>`SELECT id,full_name AS name FROM patients WHERE uhid=${uhid} AND deleted_at IS NULL`.execute(tx)).rows[0];
  if(!patient)return {success:false,error:"Patient not found in this clinic"};
  let lines=p.lines??[];if(typeof lines==="string"){try{lines=JSON.parse(lines);}catch{return {success:false,error:"Invalid bill lines"};}}
  if(!Array.isArray(lines)||lines.length>500)return {success:false,error:"Invalid bill lines"};
  const period=day.slice(0,7).replace("-","");
  const n=(await sql<{n:number}>`INSERT INTO cghs_bill_counters(period,last_value) VALUES(${period},1) ON CONFLICT(clinic_id,period) DO UPDATE SET last_value=cghs_bill_counters.last_value+1 RETURNING last_value AS n`.execute(tx)).rows[0]!.n;
  const billNo=period+String(n).padStart(4,"0");
  await sql`INSERT INTO cghs_bills(patient_id,uhid,bill_no,bill_date,patient_name,panel,card_id,panel_category,amount,lines) VALUES(${patient.id},${uhid},${billNo},${day}::date,${patient.name},${str(p.panel)},${str(p.cardId)},${str(p.panelCategory)},${amount},${JSON.stringify(lines)}::jsonb)`.execute(tx);
  return {success:true,billNo};
 }),
 getCghsBills:read(async(p,{tx,actor})=>{
  if(!actor.permissions.has("finance:read"))return {success:false,forbidden:true,error:"Finance permission required"};
  const uhid=uhidOf(p.uhid);
  const rows=(await sql<any>`SELECT bill_no AS "billNo",bill_date::text AS "billDate",uhid,patient_name AS "patientName",panel,card_id AS "cardId",panel_category AS "panelCategory",amount::float8 AS amount,lines,created_at AS "savedAt" FROM cghs_bills WHERE (${uhid}='' OR upper(uhid)=${uhid}) ORDER BY bill_date DESC,created_at DESC,id DESC`.execute(tx)).rows;
  return {success:true,bills:rows};
 },"finance:read")
};
