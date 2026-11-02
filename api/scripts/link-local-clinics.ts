// Opt-in, idempotent local demonstration. Never imports/copies patient records.
import pg from "pg";
import { DEFAULT_ROLES } from "../src/auth/permissions.js";
import { required } from "../src/env.js";

const apply = process.argv.includes("--apply");
const client = new pg.Client({ connectionString: required("OWNER_DATABASE_URL") });
await client.connect();
try {
  const db = (await client.query("SELECT current_database() AS name")).rows[0].name;
  if (db !== "kb_pms") throw new Error("This helper is limited to the local kb_pms development database");
  const home = (await client.query("SELECT id,name FROM clinics WHERE code='kbdev' AND active")).rows[0];
  if (!home || home.name !== "KB Dental (development)") throw new Error("Expected the seeded development clinic; refusing to relabel another installation");
  const existing = (await client.query("SELECT code FROM org_identity")).rows[0];
  if (existing && existing.code !== "kb-local") throw new Error("Database already belongs to another organization");
  console.log("Plan: link kbdev and a synthetic kbdev-east clinic to KB Local Organization; grant existing development administrators access to both. No patient records will be copied or changed.");
  if (!apply) console.log("Dry run only. Run with --apply to provision.");
  else {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(24240001)");
    const org = (await client.query("INSERT INTO org_identity(id,code,name,hostname) VALUES(uuidv7(),'kb-local','KB Local Organization','127.0.0.1:8080') ON CONFLICT(singleton) DO UPDATE SET code=org_identity.code RETURNING id")).rows[0].id;
    await client.query("SELECT set_config('app.organization_id',$1,true)",[org]);
    let second = (await client.query("SELECT id,name FROM clinics WHERE code='kbdev-east'")).rows[0];
    if (second && second.name !== "KB Dental East (synthetic demo)") throw new Error("Existing kbdev-east is not this synthetic fixture");
    if (!second) {
      second = (await client.query("INSERT INTO clinics(code,name) VALUES('kbdev-east','KB Dental East (synthetic demo)') RETURNING id,name")).rows[0];
      await client.query("SELECT set_config('app.clinic_id',$1,true)",[second.id]);
      for (const role of DEFAULT_ROLES) await client.query("INSERT INTO roles(name,permissions) VALUES($1,$2)",[role.name,role.permissions]);
    }
    for (const [id,code,name] of [[home.id,'kbdev',home.name],[second.id,'kbdev-east',second.name]]) {
      const unit=(await client.query("INSERT INTO org_units(code,name) VALUES($1,$2) ON CONFLICT(organization_id,code) DO UPDATE SET name=org_units.name RETURNING id",[code,name])).rows[0].id;
      await client.query("INSERT INTO org_clinical_units VALUES($1,$2,$3) ON CONFLICT(organization_id,clinic_id) DO NOTHING",[org,unit,id]);
    }
    await client.query("SELECT set_config('app.clinic_id',$1,true)",[home.id]);
    const admins=(await client.query("SELECT u.id,u.username,u.display_name,u.password_hash FROM app_users u JOIN roles r ON r.id=u.role_id AND r.clinic_id=u.clinic_id WHERE u.active AND r.permissions @> ARRAY['roles:manage','masters:write']::text[]")).rows;
    const password=(await client.query("SELECT value FROM clinic_settings WHERE key='master_password'")).rows[0]?.value;
    if (password) await client.query("INSERT INTO org_settings(key,value) VALUES('clinical_master_password',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify(password)]);
    for (const admin of admins) {
      await client.query("SELECT set_config('app.clinic_id',$1,true)",[second.id]);
      const target=(await client.query("INSERT INTO app_users(username,display_name,password_hash,role_id) SELECT $1,$2,$3,id FROM roles WHERE name='admin' ON CONFLICT(clinic_id,username) DO NOTHING RETURNING id",[admin.username,admin.display_name,admin.password_hash])).rows[0];
      // Never reuse an unrelated pre-existing account just because its username matches.
      const prior=(await client.query("SELECT user_id FROM org_clinical_access WHERE principal_user_id=$1 AND clinic_id=$2",[admin.id,second.id])).rows[0];
      if (!target && !prior) throw new Error("A target account already exists without an explicit bridge grant; operator review required");
      await client.query("INSERT INTO org_clinical_access VALUES($1,$2,$3,$2,$3,true),($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING",[org,home.id,admin.id,second.id,target?.id ?? prior.user_id]);
    }
    await client.query("COMMIT");
    console.log("Local organization and two clinics linked. Existing home-clinic login credentials are unchanged. Reload or sign in at port8080.");
  }
} catch (e) { await client.query("ROLLBACK"); throw e; }
finally { await client.end(); }
