import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDb } from "../db/index.js";
import { hashPassword } from "../auth/password.js";
import { context, ORG_PERMISSIONS, TEMPLATES } from "./model.js";

export interface SeedOptions { code: string; name: string; hostname?: string; clinics?: {code:string;name:string}[]; password?: string }
export async function seedOrganization(ownerUrl: string, opts: SeedOptions) {
  const db = createDb(ownerUrl,1);
  try {
    return await db.transaction().execute(async tx => {
      await sql`SELECT pg_advisory_xact_lock(23230001)`.execute(tx);
      let organization = (await sql<any>`SELECT * FROM org_identity`.execute(tx)).rows[0];
      if (organization && organization.code !== opts.code) throw new Error("Database belongs to another organization");
      if (!organization) {
        if (!opts.password || opts.password.length < 10) throw new Error("First seed requires a synthetic password of at least 10 characters");
        organization = (await sql<any>`INSERT INTO org_identity(id,code,name,hostname) VALUES(${randomUUID()},${opts.code},${opts.name},${opts.hostname ?? `${opts.code}.localhost`}) RETURNING *`.execute(tx)).rows[0];
      }
      await context(tx, organization.id);
      const clinics = opts.clinics ?? Array.from({length:opts.code === "org-a" ? 2 : 1},(_,i)=>({code:`clinic-${i+1}`,name:`Fictional Clinic ${i+1}`}));
      for (const c of clinics) await sql`INSERT INTO org_units(code,name) VALUES(${c.code},${c.name}) ON CONFLICT(organization_id,code) DO NOTHING`.execute(tx);
      const units = (await sql<any>`SELECT id,code,name,type FROM org_units ORDER BY code`.execute(tx)).rows;
      for (const username of ["admin","clinic-admin","doctor","doctor-one","reception","accounts"]) {
        const exists = (await sql<any>`SELECT id FROM org_users WHERE username=${username}`.execute(tx)).rows[0];
        if (exists) continue;
        if (!opts.password) throw new Error("Password required for missing fixture user");
        const perms = username === "admin" ? ORG_PERMISSIONS : [];
        const user = (await sql<any>`INSERT INTO org_users(username,display_name,password_hash,permissions)
          VALUES(${username},${`Demo ${username}`},${await hashPassword(opts.password)},${perms}) RETURNING id`.execute(tx)).rows[0];
        if (username !== "admin") for (const u of username === "doctor" ? units : units.slice(0,1)) {
          await sql`INSERT INTO org_grants(user_id,unit_id,permissions) VALUES(${user.id},${u.id},${TEMPLATES[username === "doctor-one" ? "doctor" : username]!})`.execute(tx);
        }
      }
      if (!(await sql<any>`SELECT id FROM org_patients LIMIT 1`.execute(tx)).rows.length) {
        for (const [i,name] of ["Aster Example","Cedar Example"].entries()) {
          await sql`INSERT INTO org_patients(uhid,name,phone,gender,registration_unit_id)
            VALUES(${`P${String(i+1).padStart(6,"0")}`},${name},${`900000000${i+1}`},'unspecified',${units[0]!.id})`.execute(tx);
        }
        await sql`INSERT INTO org_counters(key,value) VALUES('patient',2) ON CONFLICT DO NOTHING`.execute(tx);
      }
      for (const [key,value] of Object.entries({contact:"Organization contact",opening_hours:"09:00–18:00",chairs:["Chair 1"],doctor_availability:"Weekdays",fees:[{code:"CONSULT",name:"Consultation",amount:300}],identity:opts.name,forms:"Organization controlled",access:"Explicit clinic grants",catalogue:["Consultation"]})) {
        await sql`INSERT INTO org_settings(key,value) VALUES(${key},${JSON.stringify(value)}::jsonb) ON CONFLICT DO NOTHING`.execute(tx);
      }
      if (!(await sql<any>`SELECT id FROM org_forms LIMIT 1`.execute(tx)).rows.length) {
        const form = (await sql<any>`INSERT INTO org_forms(key,title,form_version,fields) VALUES('visit-check','Visit check',1,${JSON.stringify([{key:"finding",label:"Finding",required:true}])}::jsonb) RETURNING id`.execute(tx)).rows[0];
        await sql`INSERT INTO org_form_assignments(form_id,unit_id) VALUES(${form.id},${units[0]!.id})`.execute(tx);
      }
      if (!(await sql<any>`SELECT id FROM org_notes LIMIT 1`.execute(tx)).rows.length) {
        const doctor=(await sql<any>`SELECT id FROM org_users WHERE username='doctor'`.execute(tx)).rows[0];
        const p=(await sql<any>`SELECT id,uhid,name,phone FROM org_patients ORDER BY uhid OFFSET 1 LIMIT 1`.execute(tx)).rows[0];
        if(p)for(const unit of units)await sql`INSERT INTO org_notes(unit_id,patient_id,author_id,text,patient_snapshot)
          VALUES(${unit.id},${p.id},${doctor.id},${`Synthetic continuity visit at ${unit.name}. Demonstration only.`},${JSON.stringify(p)}::jsonb)`.execute(tx);
      }
      return { organization, units,
        users:(await sql<any>`SELECT id,username,display_name,permissions FROM org_users ORDER BY username`.execute(tx)).rows,
        patients:(await sql<any>`SELECT id,uhid,name,phone,version FROM org_patients ORDER BY uhid`.execute(tx)).rows };
    });
  } finally { await db.destroy(); }
}
