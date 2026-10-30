// Makes (or resets) a throwaway local login "demo-admin" in kb_rehearsal.
// Usage: npx tsx scripts/rehearsal-user.ts <password>
import pg from "pg";
import { createUser } from "../src/admin.js";
import { required } from "../src/env.js";

const password = process.argv[2];
if (!password || password.length < 12) throw new Error("Give a password of at least 12 characters");
const url = required("REHEARSAL_OWNER_DATABASE_URL");
const c = new pg.Client({ connectionString: url }); await c.connect();
const clinic = (await c.query("SELECT id FROM clinics WHERE code = 'kb'")).rows[0].id as string;
await c.query("SELECT set_config('app.clinic_id', $1, false)", [clinic]);
await c.query("DELETE FROM sessions"); await c.query("DELETE FROM app_users WHERE username = 'demo-admin'");
await c.end();
await createUser(url, clinic, { username: "demo-admin", displayName: "Demo Admin", password, role: "admin" });
console.log("demo-admin ready in kb_rehearsal");
