import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { sql, type Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import { burnPasswordCheck, verifyPassword } from "../auth/password.js";
import { audit, context, counter, fail, OrgError, patient, text, UNIT_PERMISSIONS, uuid, type OrgTx } from "./model.js";

export interface OrganizationOptions { db: Kysely<DB>; code: string; hostname: string; documentRoot: string; cookieSecure: boolean; logger?: boolean }
const hash = (s:string) => createHash("sha256").update(s).digest("hex");
const COOKIE = "org_session";
const ALLOWED_SETTINGS = new Set(["contact","opening_hours","chairs","doctor_availability"]);
const DEFAULT_SETTINGS = new Set([...ALLOWED_SETTINGS,"catalogue","fees"]);
function settingValue(key:string,value:unknown):unknown {
  if(key==="contact"||key==="opening_hours"||key==="doctor_availability")return text(value,key,key==="contact"?300:1500);
  if(key==="chairs"||key==="catalogue"){
    const limit=key==="chairs"?30:100,max=key==="chairs"?60:120;
    if(!Array.isArray(value)||!value.length||value.length>limit)fail(400,"invalid_request",`${key} must be a nonempty list`);
    const values=value.map(v=>text(v,key,max));
    if(new Set(values.map(v=>v.toLowerCase())).size!==values.length)fail(400,"invalid_request",`${key} must contain unique names`);
    return values;
  }
  if(key==="fees"){
    if(!Array.isArray(value)||!value.length||value.length>100)fail(400,"invalid_request","Fees must be a nonempty list");
    const codes=new Set<string>();
    return value.map(row=>{
      if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).some(k=>!["code","name","amount"].includes(k)))fail(400,"invalid_request","Invalid fee row");
      const code=text(row.code,"fee code",40),name=text(row.name,"fee name",120),amount=row.amount;
      if(codes.has(code.toLowerCase()))fail(400,"invalid_request","Fee codes must be unique");
      codes.add(code.toLowerCase());
      if(typeof amount!=="number"||!Number.isFinite(amount)||amount<0||amount>9999999||Math.abs(amount*100-Math.round(amount*100))>0.00001)fail(400,"invalid_request","Fee must be nonnegative INR with at most two decimals");
      return{code,name,amount};
    });
  }
  return fail(403,"locked_setting","This setting requires its dedicated workflow");
}
type Actor = { id:string; username:string; display_name:string; permissions:string[] };
type Handler = (tx:OrgTx,actor:Actor,req:FastifyRequest)=>Promise<unknown>;
const body = (r:FastifyRequest):Record<string,any> => {
  if (!r.body || typeof r.body !== "object" || Array.isArray(r.body)) fail(400,"invalid_request","Send a JSON object");
  return r.body as Record<string,any>;
};
const query = (r:FastifyRequest) => r.query as Record<string,string|undefined>;
const params = (r:FastifyRequest) => r.params as Record<string,string>;
const json = (v:unknown) => sql`${JSON.stringify(v)}::jsonb`;
function date(v:unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) || !Number.isFinite(Date.parse(v))) fail(400,"invalid_request","Invalid date");
  return v;
}
async function grants(tx:OrgTx,actor:Actor) {
  return (await sql<any>`SELECT u.id,u.code,u.name,u.type,coalesce(g.permissions,ARRAY[]::text[]) AS permissions
    FROM org_units u LEFT JOIN org_grants g ON g.unit_id=u.id AND g.user_id=${actor.id}
    WHERE g.id IS NOT NULL OR ${actor.permissions.includes("access:manage") || actor.permissions.includes("metrics:read")}
    ORDER BY u.code`.execute(tx)).rows;
}
function orgPermission(a:Actor,p:string) { if (!a.permissions.includes(p)) fail(403,"forbidden","Permission required"); }
async function unitPermission(tx:OrgTx,a:Actor,id:unknown,p:string):Promise<string> {
  const unit = uuid(id);
  const g = (await sql<{permissions:string[]}>`SELECT permissions FROM org_grants WHERE user_id=${a.id} AND unit_id=${unit}`.execute(tx)).rows[0];
  if (!g?.permissions.includes(p)) fail(403,"forbidden","Clinic permission required");
  return unit;
}

export async function buildOrganizationApp(opts:OrganizationOptions) {
  const app = Fastify({logger:opts.logger ?? false,bodyLimit:2*1024*1024,ajv:{customOptions:{removeAdditional:false}}});
  const identity = (await sql<any>`SELECT id,code,name,hostname,timezone,currency FROM org_identity`.execute(opts.db)).rows;
  if (identity.length !== 1 || identity[0].code !== opts.code || identity[0].hostname.toLowerCase() !== opts.hostname.toLowerCase()) throw new Error("Organization identity pin mismatch");
  const organization = identity[0];
  const documentRoot=resolve(opts.documentRoot);
  await mkdir(documentRoot,{recursive:true});
  await app.register(cookie);
  await app.register(rateLimit,{max:500,timeWindow:"1 minute"});
  app.setErrorHandler((err:any,_req,reply)=>{
    if (err instanceof OrgError) return reply.code(err.status).send({error:{code:err.code,message:err.message}});
    const code = err.code ?? err.cause?.code;
    if (["23P01","23505"].includes(code)) return reply.code(409).send({error:{code:"conflict",message:"Record conflicts with existing data"}});
    if (["23503","22P02","22007","22008","23514"].includes(code)) return reply.code(400).send({error:{code:"invalid_request",message:"Invalid record or reference"}});
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({error:{code:"invalid_request",message:"Invalid request"}});
    app.log.error({code:typeof code === "string" ? code : "internal"},"Organization request failed");
    return reply.code(500).send({error:{code:"internal",message:"Request could not be completed"}});
  });
  app.addHook("onRequest",async(req,reply)=>{
    const host=(req.headers.host ?? "").toLowerCase();
    const configured=new URL(`http://${opts.hostname.toLowerCase()}`);
    let accepted=false;
    if(/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)){
      try{const actual=new URL(`http://${host}`);accepted=actual.hostname===configured.hostname&&(!configured.port||actual.port===configured.port);}catch{/* invalid authority */}
    }
    if (!accepted) return reply.code(421).send({error:{code:"wrong_host",message:"Wrong organization host"}});
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers.origin && req.headers.origin !== `${opts.cookieSecure ? "https" : "http"}://${host}`) return reply.code(403).send({error:{code:"origin",message:"Origin refused"}});
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply.code(415).send({error:{code:"json_only",message:"Send JSON"}});
    }
  });
  app.addHook("onSend",async(_req,reply)=>{
    reply.header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff").header("Referrer-Policy","same-origin").header("X-Frame-Options","DENY");
  });
  const run = (fn:Handler) => async(req:FastifyRequest) => opts.db.transaction().execute(async tx=>{
    await context(tx,organization.id);
    const token = req.cookies[COOKIE];
    if (!token) fail(401,"signed_out","Please sign in");
    const a = (await sql<Actor>`SELECT u.id,u.username,u.display_name,u.permissions FROM org_sessions s
      JOIN org_users u ON u.id=s.user_id AND u.organization_id=s.organization_id
      WHERE s.token_hash=${hash(token)} AND s.expires_at>now() AND u.active`.execute(tx)).rows[0];
    if (!a) fail(401,"signed_out","Session ended");
    await context(tx,organization.id,a.id);
    return fn(tx,a,req);
  });
  const get = (path:string,fn:Handler) => app.get(`/api/v1/organization${path}`,run(fn));
  const post = (path:string,fn:Handler) => app.post(`/api/v1/organization${path}`,run(fn));
  app.get("/health",async()=>{await sql`SELECT 1`.execute(opts.db);return{status:"ok",code:opts.code};});
  app.get("/api/v1/organization",async()=>({organization}));
  app.post("/api/v1/auth/login",{config:{rateLimit:{max:15,timeWindow:"1 minute"}}},async(req,reply)=>{
    const b=body(req),username=text(b.username,"username",40).toLowerCase(),password=text(b.password,"password",200);
    const result = await opts.db.transaction().execute(async tx=>{
      await context(tx,organization.id);
      const u=(await sql<any>`SELECT * FROM org_users WHERE username=${username} FOR UPDATE`.execute(tx)).rows[0];
      if (!u || !u.active || (u.locked_until && u.locked_until>new Date())) {await burnPasswordCheck(password);return null;}
      if (!await verifyPassword(password,u.password_hash)) {
        await sql`UPDATE org_users SET failed_attempts=failed_attempts+1,locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=${u.id}`.execute(tx);return null;
      }
      await sql`UPDATE org_users SET failed_attempts=0,locked_until=NULL WHERE id=${u.id}`.execute(tx);
      const token=randomBytes(32).toString("base64url");
      await sql`INSERT INTO org_sessions(token_hash,user_id,expires_at) VALUES(${hash(token)},${u.id},now()+interval '1 day')`.execute(tx);
      const user:Actor={id:u.id,username:u.username,display_name:u.display_name,permissions:u.permissions};
      await context(tx,organization.id,u.id);await audit(tx,u.id,"auth.login",u.id);
      return{token,user,units:await grants(tx,user)};
    });
    if (!result) fail(401,"login_failed","Username or password is wrong or account is temporarily locked");
    reply.setCookie(COOKIE,result.token,{httpOnly:true,secure:opts.cookieSecure,sameSite:"strict",path:"/",maxAge:86400});
    return{user:result.user,units:result.units};
  });
  app.get("/api/v1/auth/me",run(async(tx,a)=>({user:a,units:await grants(tx,a)})));
  app.post("/api/v1/auth/logout",async(req,reply)=>{
    await opts.db.transaction().execute(async tx=>{await context(tx,organization.id);if(req.cookies[COOKIE])await sql`DELETE FROM org_sessions WHERE token_hash=${hash(req.cookies[COOKIE]!)}`.execute(tx);});
    reply.clearCookie(COOKIE,{path:"/"});return{ok:true};
  });
  get("/units",async(tx,a)=>({units:await grants(tx,a)}));
  get("/staff",async(tx,a)=>{
    orgPermission(a,"access:manage");
    const staff=(await sql<any>`SELECT id,username,display_name,permissions FROM org_users ORDER BY username`.execute(tx)).rows;
    const gs=(await sql<any>`SELECT user_id,unit_id,permissions FROM org_grants`.execute(tx)).rows;
    return{staff:staff.map(u=>({...u,grants:gs.filter(g=>g.user_id===u.id).map(({unit_id,permissions})=>({unit_id,permissions}))}))};
  });
  post("/grants",async(tx,a,r)=>{
    orgPermission(a,"access:manage");const b=body(r),user=uuid(b.user_id),unit=uuid(b.unit_id);
    if (!Array.isArray(b.permissions)||b.permissions.some((p:unknown)=>typeof p!=="string"||!UNIT_PERMISSIONS.includes(p)))fail(400,"invalid_request","Unknown permission");
    await sql`INSERT INTO org_grants(user_id,unit_id,permissions) VALUES(${user},${unit},${[...new Set(b.permissions)] as string[]})
      ON CONFLICT(organization_id,user_id,unit_id) DO UPDATE SET permissions=excluded.permissions`.execute(tx);
    await audit(tx,a.id,"grant.updated",user,unit);return{ok:true};
  });
  get("/doctors",async(tx,a,r)=>{
    const unit=await unitPermission(tx,a,query(r).unit_id,"appointments:read");
    return{doctors:(await sql<any>`SELECT u.id,u.display_name FROM org_users u JOIN org_grants g ON g.user_id=u.id
      WHERE g.unit_id=${unit} AND 'clinical:write'=ANY(g.permissions) AND u.active ORDER BY u.display_name`.execute(tx)).rows};
  });
  get("/patients",async(tx,a,r)=>{
    const gs=await grants(tx,a);if(!gs.some(g=>g.permissions.includes("patients:read")))fail(403,"forbidden","Directory permission required");
    const q=query(r);
    if (!q.uhid && !(q.phone&&q.name))fail(400,"confirmation_required","Search exact UHID or phone plus name");
    const confirmedName=q.uhid?null:text(q.name,"name",100);
    if(confirmedName!==null&&!/[\p{L}\p{N}]/u.test(confirmedName))fail(400,"confirmation_required","Enter a meaningful part of the patient's name");
    const patients=(await sql<any>`SELECT id,uhid,name,phone,gender,dob,version FROM org_patients
      WHERE ${q.uhid ? sql`uhid=${text(q.uhid,"UHID",40)}` : sql`phone=${text(q.phone,"phone",30)} AND strpos(lower(name),lower(${confirmedName}))>0`} ORDER BY name LIMIT 30`.execute(tx)).rows;
    return{patients};
  });
  post("/patients",async(tx,a,r)=>{
    const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"patients:write");
    const name=text(b.name,"name",120),phone=text(b.phone,"phone",30);
    const duplicates=(await sql<any>`SELECT id FROM org_patients WHERE phone=${phone} LIMIT 1`.execute(tx)).rows.length>0;
    const uhid=`P${String(await counter(tx,"patient")).padStart(6,"0")}`;
    const p=(await sql<any>`INSERT INTO org_patients(uhid,name,phone,gender,dob,registration_unit_id)
      VALUES(${uhid},${name},${phone},${b.gender ? text(b.gender,"gender",30):null},${date(b.dob)},${unit}) RETURNING id,uhid,name,phone,gender,dob,version`.execute(tx)).rows[0];
    await audit(tx,a.id,"patient.created",p.id,unit);return{patient:p,duplicate_warning:duplicates};
  });
  get("/patients/:id",async(tx,a,r)=>{await unitPermission(tx,a,query(r).unit_id,"patients:read");return{patient:await patient(tx,params(r).id!)};});
  post("/patients/:id",async(tx,a,r)=>{
    const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"patients:write"),id=uuid(params(r).id);
    if(!Number.isInteger(b.version))fail(400,"invalid_request","Version required");
    const p=(await sql<any>`UPDATE org_patients SET name=${text(b.name,"name",120)},phone=${text(b.phone,"phone",30)},gender=${b.gender ? text(b.gender,"gender",30):null},dob=${date(b.dob)} WHERE id=${id} AND version=${b.version} RETURNING id,uhid,name,phone,gender,dob,version`.execute(tx)).rows[0];
    if(!p)fail(409,"stale_version","Patient changed; reload before saving");
    await audit(tx,a.id,"patient.updated",id,unit);return{patient:p};
  });
  get("/patients/:id/history",async(tx,a,r)=>{
    const unit=await unitPermission(tx,a,query(r).unit_id,"clinical:read"),id=uuid(params(r).id);await patient(tx,id);
    const notes=(await sql<any>`SELECT n.*,u.display_name AS author,u.display_name AS author_name FROM org_notes n JOIN org_users u ON u.id=n.author_id WHERE n.patient_id=${id} AND n.unit_id=${unit} ORDER BY n.created_at`.execute(tx)).rows;
    const submissions=(await sql<any>`SELECT s.*,f.title,f.form_version,f.fields,u.display_name AS author FROM org_submissions s JOIN org_forms f ON f.id=s.form_id JOIN org_users u ON u.id=s.author_id WHERE s.patient_id=${id} AND s.unit_id=${unit} ORDER BY s.created_at`.execute(tx)).rows;
    return{notes,submissions};
  });
  get("/appointments",async(tx,a,r)=>{
    const unit=await unitPermission(tx,a,query(r).unit_id,"appointments:read");
    return{appointments:(await sql<any>`SELECT x.*,p.name AS patient_name,p.uhid,u.display_name AS doctor_name FROM org_appointments x JOIN org_patients p ON p.id=x.patient_id JOIN org_users u ON u.id=x.doctor_id WHERE x.unit_id=${unit} ORDER BY starts_at LIMIT 300`.execute(tx)).rows};
  });
  post("/appointments",async(tx,a,r)=>{
    const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"appointments:write"),pid=uuid(b.patient_id),doctor=uuid(b.doctor_id);await patient(tx,pid);
    const dg=(await sql<any>`SELECT g.id FROM org_grants g JOIN org_users u ON u.id=g.user_id WHERE g.user_id=${doctor} AND g.unit_id=${unit} AND 'clinical:write'=ANY(g.permissions) AND u.active`.execute(tx)).rows[0];
    if(!dg)fail(400,"invalid_doctor","Doctor is not assigned to this clinic");
    const start=new Date(b.starts_at),end=new Date(b.ends_at);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)fail(400,"invalid_request","Valid appointment interval required");
    const appointment=(await sql<any>`INSERT INTO org_appointments(unit_id,patient_id,doctor_id,starts_at,ends_at,chair) VALUES(${unit},${pid},${doctor},${start},${end},${b.chair ? text(b.chair,"chair",60):""}) RETURNING *`.execute(tx)).rows[0];
    await audit(tx,a.id,"appointment.created",appointment.id,unit);return{appointment};
  });
  async function saveNote(tx:OrgTx,a:Actor,r:FastifyRequest,kind:"note"|"addendum"|"submission") {
    const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"clinical:write");
    let pid:string,parent:string|null=null,submission:string|null=null;
    if(kind==="note")pid=uuid(b.patient_id);
    else {
      const id=uuid(params(r).id),table=kind==="submission"?"org_submissions":"org_notes";
      const row=(await sql<any>`SELECT patient_id FROM ${sql.table(table)} WHERE id=${id} AND unit_id=${unit}`.execute(tx)).rows[0];
      if(!row)fail(404,"not_found","Clinical record not found");pid=row.patient_id;
      if(kind==="submission")submission=id;else parent=id;
    }
    const snapshot=await patient(tx,pid);
    const note=(await sql<any>`INSERT INTO org_notes(unit_id,patient_id,author_id,text,parent_id,submission_id,patient_snapshot)
      VALUES(${unit},${pid},${a.id},${text(b.text,"note",12000)},${parent},${submission},${json(snapshot)}) RETURNING *`.execute(tx)).rows[0];
    await audit(tx,a.id,kind==="note"?"note.created":"note.addendum",note.id,unit);return{note};
  }
  post("/notes",(tx,a,r)=>saveNote(tx,a,r,"note"));
  post("/notes/:id/addenda",(tx,a,r)=>saveNote(tx,a,r,"addendum"));
  post("/submissions/:id/addenda",(tx,a,r)=>saveNote(tx,a,r,"submission"));
  get("/forms",async(tx,a,r)=>{
    const unit=query(r).unit_id;
    if(unit){await unitPermission(tx,a,unit,"forms:fill");return{forms:(await sql<any>`SELECT f.* FROM org_forms f JOIN org_form_assignments x ON x.form_id=f.id WHERE x.unit_id=${uuid(unit)} ORDER BY f.key,f.form_version DESC`.execute(tx)).rows};}
    orgPermission(a,"forms:manage");return{forms:(await sql<any>`SELECT f.*,coalesce((SELECT jsonb_agg(unit_id) FROM org_form_assignments x WHERE x.form_id=f.id),'[]'::jsonb) AS unit_ids FROM org_forms f ORDER BY f.key,f.form_version DESC`.execute(tx)).rows};
  });
  async function assign(tx:OrgTx,id:string,units:unknown) {
    if(!Array.isArray(units)||units.length>50)fail(400,"invalid_request","Clinic assignments required");
    const ids=[...new Set(units.map(uuid))];
    await sql`DELETE FROM org_form_assignments WHERE form_id=${id}`.execute(tx);
    for(const unit of ids)await sql`INSERT INTO org_form_assignments(form_id,unit_id) VALUES(${id},${unit})`.execute(tx);
  }
  post("/forms",async(tx,a,r)=>{
    orgPermission(a,"forms:manage");const b=body(r),key=text(b.key,"form key",60),title=text(b.title,"title",120);
    if(!Array.isArray(b.fields)||!b.fields.length||b.fields.length>40)fail(400,"invalid_request","Form fields required");
    const keys=new Set<string>();const fields=b.fields.map((f:any)=>{
      const key=text(f.key,"field key",40);if(!/^[a-z][a-z0-9_]*$/.test(key)||keys.has(key))fail(400,"invalid_request","Invalid or duplicate field key");keys.add(key);
      return{key,label:text(f.label,"field label",120),required:f.required===true};
    });
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`form:${organization.id}:${key}`},0))`.execute(tx);
    const version=(await sql<{v:number}>`SELECT coalesce(max(form_version),0)+1 AS v FROM org_forms WHERE key=${key}`.execute(tx)).rows[0]!.v;
    const form=(await sql<any>`INSERT INTO org_forms(key,title,form_version,fields) VALUES(${key},${title},${version},${json(fields)}) RETURNING *`.execute(tx)).rows[0];
    // Retire prior assignments for this key, retaining definitions/submissions.
    await sql`DELETE FROM org_form_assignments WHERE form_id IN(SELECT id FROM org_forms WHERE key=${key})`.execute(tx);
    await assign(tx,form.id,b.unit_ids);await audit(tx,a.id,"form.published",form.id);return{form};
  });
  post("/forms/:id/assign",async(tx,a,r)=>{
    orgPermission(a,"forms:manage");const id=uuid(params(r).id);
    if(!(await sql<any>`SELECT id FROM org_forms WHERE id=${id}`.execute(tx)).rows[0])fail(404,"not_found","Form not found");
    await assign(tx,id,body(r).unit_ids);await audit(tx,a.id,"form.assigned",id);return{ok:true};
  });
  post("/submissions",async(tx,a,r)=>{
    const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"forms:fill"),pid=uuid(b.patient_id),fid=uuid(b.form_id);
    const snapshot=await patient(tx,pid);
    const f=(await sql<any>`SELECT f.* FROM org_forms f JOIN org_form_assignments x ON x.form_id=f.id WHERE f.id=${fid} AND x.unit_id=${unit} FOR SHARE OF x`.execute(tx)).rows[0];
    if(!f)fail(409,"form_unassigned","This form version is not assigned; resolve the draft before submitting");
    if(!b.answers||typeof b.answers!=="object"||Array.isArray(b.answers))fail(400,"invalid_request","Answers required");
    const keys=new Set(f.fields.map((x:any)=>x.key));
    if(Object.keys(b.answers).some(k=>!keys.has(k)))fail(400,"invalid_request","Unknown form field");
    for(const field of f.fields){const v=b.answers[field.key];if(field.required&&(typeof v!=="string"||!v.trim()))fail(400,"required_field",`${field.label} is required`);if(v!==undefined&&(typeof v!=="string"||v.length>4000))fail(400,"invalid_request","Invalid answer");}
    const submission=(await sql<any>`INSERT INTO org_submissions(unit_id,patient_id,form_id,author_id,answers,patient_snapshot) VALUES(${unit},${pid},${fid},${a.id},${json(b.answers)},${json(snapshot)}) RETURNING *`.execute(tx)).rows[0];
    await audit(tx,a.id,"form.submitted",submission.id,unit);return{submission};
  });
  get("/settings/defaults",async(tx,a)=>{
    orgPermission(a,"settings:manage");
    const rows=(await sql<any>`SELECT key,value,version FROM org_settings WHERE unit_id IS NULL ORDER BY key`.execute(tx)).rows;
    return{settings:rows.map(row=>({...row,source:"organization",locked:!DEFAULT_SETTINGS.has(row.key)}))};
  });
  post("/settings/defaults",async(tx,a,r)=>{
    orgPermission(a,"settings:manage");
    const b=body(r),key=text(b.key,"setting key",60);
    if(!DEFAULT_SETTINGS.has(key))fail(403,"locked_setting","This setting requires its dedicated workflow");
    const value=settingValue(key,b.value);
    if(!Number.isInteger(b.version)||b.version<1)fail(400,"invalid_request","Current organization default version required");
    const old=(await sql<{id:string;version:number}>`SELECT id,version FROM org_settings WHERE unit_id IS NULL AND key=${key} FOR UPDATE`.execute(tx)).rows[0];
    if(!old)fail(404,"not_found","Organization default not found");
    if(old.version!==b.version)fail(409,"stale_version","Organization default changed; reload before saving");
    await sql`UPDATE org_settings SET value=${json(value)} WHERE id=${old.id}`.execute(tx);
    await audit(tx,a.id,"setting.default.updated",old.id);return{ok:true};
  });
  get("/settings",async(tx,a,r)=>{
    const unit=uuid(query(r).unit_id);
    if(!a.permissions.includes("settings:manage"))await unitPermission(tx,a,unit,"settings:write");
    const rows=(await sql<any>`SELECT key,value,unit_id,version FROM org_settings WHERE unit_id IS NULL OR unit_id=${unit} ORDER BY unit_id NULLS FIRST`.execute(tx)).rows;
    const settings=new Map<string,any>();for(const row of rows)settings.set(row.key,{key:row.key,value:row.value,source:row.unit_id?"override":"inherited",locked:!ALLOWED_SETTINGS.has(row.key),version:row.unit_id?row.version:0});
    return{settings:[...settings.values()]};
  });
  async function settingWrite(tx:OrgTx,a:Actor,r:FastifyRequest,reset:boolean){
    const b=body(r),unit=uuid(b.unit_id),key=text(b.key,"setting key",60);
    if(!a.permissions.includes("settings:manage"))await unitPermission(tx,a,unit,"settings:write");
    if(!ALLOWED_SETTINGS.has(key))fail(403,"locked_setting","Organization controls this setting");
    const value=reset?undefined:settingValue(key,b.value);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`setting:${unit}:${key}`},0))`.execute(tx);
    const old=(await sql<any>`SELECT version FROM org_settings WHERE unit_id=${unit} AND key=${key}`.execute(tx)).rows[0];
    if((old && b.version!==old.version)||(!old&&b.version!==undefined&&b.version!==0))fail(409,"stale_version","Setting changed; reload");
    if(reset){if(old)await sql`DELETE FROM org_settings WHERE unit_id=${unit} AND key=${key}`.execute(tx);}
    else await sql`INSERT INTO org_settings(unit_id,key,value) VALUES(${unit},${key},${json(value)}) ON CONFLICT(organization_id,unit_id,key) DO UPDATE SET value=excluded.value`.execute(tx);
    await audit(tx,a.id,reset?"setting.reset":"setting.overridden",undefined,unit);return{ok:true};
  }
  post("/settings",(tx,a,r)=>settingWrite(tx,a,r,false));post("/settings/reset",(tx,a,r)=>settingWrite(tx,a,r,true));
  get("/receipts",async(tx,a,r)=>{
    const q=query(r),unit=await unitPermission(tx,a,q.unit_id,"finance:read"),pid=uuid(q.patient_id);await patient(tx,pid);
    const receipts=(await sql<any>`SELECT * FROM org_receipts WHERE unit_id=${unit} AND patient_id=${pid} ORDER BY created_at DESC`.execute(tx)).rows.map(x=>({...x,charge:Number(x.charge),paid:Number(x.paid)}));
    return{receipts,balance:Math.round(receipts.filter(x=>!x.voided_at).reduce((sum,x)=>sum+x.charge-x.paid,0)*100)/100};
  });
  post("/receipts",async(tx,a,r)=>{
    const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"finance:write"),pid=uuid(b.patient_id),snapshot=await patient(tx,pid);
    for(const key of ["charge","paid"])if(typeof b[key]!=="number"||!Number.isFinite(b[key])||b[key]<0||b[key]>9999999||Math.abs(b[key]*100-Math.round(b[key]*100))>0.00001)fail(400,"invalid_request","Money must be nonnegative INR with at most two decimals");
    // Clinic-local balance lock prevents concurrent overcollection/implicit transfers.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`balance:${unit}:${pid}`},0))`.execute(tx);
    const bal=Number((await sql<any>`SELECT coalesce(sum(charge-paid),0) AS balance FROM org_receipts WHERE unit_id=${unit} AND patient_id=${pid} AND voided_at IS NULL`.execute(tx)).rows[0].balance);
    if(b.paid>bal+b.charge)fail(409,"overpayment","Payment exceeds this clinic's balance");
    const code=(await sql<any>`SELECT code FROM org_units WHERE id=${unit}`.execute(tx)).rows[0].code;
    const number=`${code.toUpperCase()}/${String(await counter(tx,`receipt:${unit}`)).padStart(5,"0")}`;
    const receipt=(await sql<any>`INSERT INTO org_receipts(unit_id,patient_id,number,charge,paid,description,patient_snapshot) VALUES(${unit},${pid},${number},${b.charge},${b.paid},${text(b.description,"description",300)},${json(snapshot)}) RETURNING *`.execute(tx)).rows[0];
    await audit(tx,a.id,"receipt.created",receipt.id,unit);return{receipt:{...receipt,charge:Number(receipt.charge),paid:Number(receipt.paid)}};
  });
  post("/receipts/:id/void",async(tx,a,r)=>{
    const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"finance:write"),id=uuid(params(r).id);
    const reason=text(b.reason,"reason",500);
    // Find the immutable owning patient without locking a row before the shared
    // balance lock. Create and void must acquire locks in the same order.
    const target=(await sql<{patient_id:string}>`SELECT patient_id FROM org_receipts WHERE id=${id} AND unit_id=${unit}`.execute(tx)).rows[0];
    if(!target)fail(409,"receipt_conflict","Receipt missing or already voided");
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`balance:${unit}:${target.patient_id}`},0))`.execute(tx);
    const current=(await sql<any>`SELECT id,voided_at FROM org_receipts WHERE id=${id} AND unit_id=${unit} FOR UPDATE`.execute(tx)).rows[0];
    if(!current||current.voided_at)fail(409,"receipt_conflict","Receipt missing or already voided");
    // Keep arithmetic numeric inside PostgreSQL, avoiding floating-point cents.
    const check=(await sql<{negative:boolean}>`SELECT coalesce(sum(charge-paid),0)<0 AS negative FROM org_receipts
      WHERE unit_id=${unit} AND patient_id=${target.patient_id} AND voided_at IS NULL AND id<>${id}`.execute(tx)).rows[0]!;
    if(check.negative)fail(409,"negative_balance","Voiding this receipt would create unsupported clinic credit; correct the later payment first");
    const receipt=(await sql<any>`UPDATE org_receipts SET voided_at=now(),void_reason=${reason} WHERE id=${id} AND unit_id=${unit} AND voided_at IS NULL RETURNING *`.execute(tx)).rows[0];
    if(!receipt)fail(409,"receipt_conflict","Receipt missing or already voided");await audit(tx,a.id,"receipt.voided",id,unit);return{receipt};
  });
  get("/documents",async(tx,a,r)=>{
    const q=query(r),unit=await unitPermission(tx,a,q.unit_id,"clinical:read"),pid=uuid(q.patient_id);await patient(tx,pid);
    return{documents:(await sql<any>`SELECT id,unit_id,patient_id,filename,mime,bytes,sha256,created_at FROM org_documents WHERE unit_id=${unit} AND patient_id=${pid} ORDER BY created_at DESC`.execute(tx)).rows};
  });
  // JSON base64 is intentionally capped at 1 MiB for this local synthetic demo.
  // The random server key, never filename/path input, determines the storage path.
  app.post("/api/v1/organization/documents",async(req,reply)=>{
    let written:string|undefined;
    try{return await run(async(tx,a,r)=>{
      const b=body(r),unit=await unitPermission(tx,a,b.unit_id,"clinical:write"),pid=uuid(b.patient_id);await patient(tx,pid);
      const filename=text(b.filename,"filename",120).replace(/[\\/\r\n\x00-\x1f]/g,"_");
      const mime=text(b.mime,"MIME",80);
      if(!["application/pdf","image/png","image/jpeg","text/plain"].includes(mime))fail(400,"invalid_request","Unsupported document type");
      if(typeof b.base64!=="string"||b.base64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.base64))fail(400,"invalid_request","Valid base64 document required");
      const bytes=Buffer.from(b.base64,"base64");if(!bytes.length||bytes.length>1048576)fail(400,"invalid_request","Document must be 1 byte to 1 MiB");
      const key=randomBytes(24).toString("hex");written=join(documentRoot,key);await writeFile(written,bytes,{flag:"wx"});
      const document=(await sql<any>`INSERT INTO org_documents(unit_id,patient_id,author_id,filename,mime,storage_key,sha256,bytes)
        VALUES(${unit},${pid},${a.id},${filename},${mime},${key},${createHash("sha256").update(bytes).digest("hex")},${bytes.length})
        RETURNING id,unit_id,patient_id,filename,mime,bytes,sha256,created_at`.execute(tx)).rows[0];
      await audit(tx,a.id,"document.uploaded",document.id,unit);return{document};
    })(req);}catch(e){if(written)await unlink(written).catch(()=>{});throw e;}
  });
  app.get("/api/v1/organization/documents/:id/download",async(req,reply)=>{
    const result=await run(async(tx,a,r)=>{
      const unit=await unitPermission(tx,a,query(r).unit_id,"clinical:read"),id=uuid(params(r).id);
      const d=(await sql<any>`SELECT * FROM org_documents WHERE id=${id} AND unit_id=${unit}`.execute(tx)).rows[0];
      if(!d)fail(404,"not_found","Document not found");
      if(!/^[a-f0-9]{48}$/.test(d.storage_key))fail(500,"storage_error","Document key invalid");
      const bytes=await readFile(join(documentRoot,d.storage_key));
      if(createHash("sha256").update(bytes).digest("hex")!==d.sha256)fail(500,"storage_error","Document checksum mismatch");
      await audit(tx,a.id,"document.downloaded",id,unit);return{bytes,mime:d.mime};
    })(req) as {bytes:Buffer;mime:string};
    return reply.header("Content-Disposition","attachment; filename=document").header("Content-Security-Policy","sandbox; default-src 'none'").type(result.mime).send(result.bytes);
  });
  get("/metrics",async(tx,a,r)=>{
    const q=query(r),today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date());
    const from=date(q.from)??`${today.slice(0,4)}-01-01`,to=date(q.to)??today;if(to<from)fail(400,"invalid_request","Invalid date range");
    let units=await grants(tx,a);
    if(!a.permissions.includes("metrics:read"))units=units.filter(u=>u.permissions.includes("finance:read"));
    if(q.unit_id){const id=uuid(q.unit_id);if(!units.some(u=>u.id===id))fail(403,"forbidden","Metrics scope denied");units=units.filter(u=>u.id===id);}
    if(!units.length)fail(403,"forbidden","Metrics permission required");
    const ids=units.map(u=>u.id);
    // One statement supplies all aggregates from a single MVCC snapshot.
    const result=(await sql<any>`WITH scope AS(SELECT unnest(${ids}::uuid[]) AS id),
      p AS(SELECT registration_unit_id AS unit_id,count(*)::int AS n FROM org_patients WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1),
      a AS(SELECT unit_id,count(*)::int AS n FROM org_appointments WHERE (starts_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1),
      r AS(SELECT unit_id,sum(paid)::float8 AS n FROM org_receipts WHERE voided_at IS NULL AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1),
      activity AS(SELECT unit_id,patient_id FROM org_appointments WHERE (starts_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date UNION SELECT unit_id,patient_id FROM org_notes WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date UNION SELECT unit_id,patient_id FROM org_submissions WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date UNION SELECT unit_id,patient_id FROM org_receipts WHERE voided_at IS NULL AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date),
      x AS(SELECT unit_id,count(DISTINCT patient_id)::int AS n FROM activity GROUP BY 1)
      SELECT s.id,coalesce(p.n,0) AS registrations,coalesce(a.n,0) AS appointments,coalesce(r.n,0) AS collections,coalesce(x.n,0) AS active_patients,
      (SELECT count(*)::int FROM org_patients WHERE registration_unit_id IN(SELECT id FROM scope) AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date) AS registered_patients,
      (SELECT count(DISTINCT patient_id)::int FROM activity WHERE unit_id IN(SELECT id FROM scope)) AS unique_patients
      FROM scope s LEFT JOIN p ON p.unit_id=s.id LEFT JOIN a ON a.unit_id=s.id LEFT JOIN r ON r.unit_id=s.id LEFT JOIN x ON x.unit_id=s.id`.execute(tx)).rows;
    // unique_patients means registered organization identities for broad admin view;
    // distinct activity is reported separately to avoid summing per-clinic counts.
    const registered=result[0]?.registered_patients??0;
    const rows=result.map(x=>({...x,name:units.find(u=>u.id===x.id).name}));
    return{from,to,timezone:"Asia/Kolkata",currency:"INR",generated_at:new Date().toISOString(),source_as_of:new Date().toISOString(),unique_patients:registered,unique_active_patients:result[0]?.unique_patients??0,registrations:rows.reduce((s,x)=>s+x.registrations,0),appointments:rows.reduce((s,x)=>s+x.appointments,0),collections:rows.reduce((s,x)=>s+x.collections,0),units:rows};
  });
  get("/audit",async(tx,a)=>{orgPermission(a,"audit:read");return{events:(await sql<any>`SELECT x.id,x.action,x.subject_id,x.unit_id,x.created_at,u.display_name AS actor FROM org_audit x LEFT JOIN org_users u ON u.id=x.actor_id ORDER BY x.created_at DESC LIMIT 200`.execute(tx)).rows};});

  for(const path of ["/","/organization.html"]) app.get(path,async(_req,reply)=>{
    try{
      const nonce=randomBytes(18).toString("base64");let html=await readFile(new URL("../../../organization.html",import.meta.url),"utf8");
      html=html.replace(/<script\b/g,`<script nonce="${nonce}"`).replace(/<style\b/g,`<style nonce="${nonce}"`);
      reply.header("Content-Security-Policy",`default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
      return reply.type("text/html; charset=utf-8").send(html);
    }catch(e:any){if(e.code==="ENOENT")return reply.code(404).send({error:{code:"ui_pending",message:"Organization interface is not installed"}});throw e;}
  });
  for(const [name,mime] of [["organization.js","text/javascript; charset=utf-8"],["organization.css","text/css; charset=utf-8"]]) app.get(`/${name}`,async(_req,reply)=>{
    try{return reply.type(mime!).send(await readFile(new URL(`../../../${name}`,import.meta.url),"utf8"));}catch(e:any){if(e.code==="ENOENT")return reply.code(404).send();throw e;}
  });
  return app;
}
