// Creates a second database, kb_rehearsal, beside kb_pms and kb_pms_test, for
// trial loads of real clinic data. The dev server and any tunnel to it use
// kb_pms only, so real rows never sit behind a public address.
// Needs the superuser password (same sources as db:bootstrap). Roles and their
// passwords are left alone. Adds REHEARSAL_OWNER_DATABASE_URL to the owner file.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ownerEnvFile, required } from "../src/env.js";
import { migrate } from "../src/migrator.js";

const superPassFile = join(homedir(), ".kb-pms", "postgres-superuser.txt");
const superPass = process.env.PGSUPERPASS ?? (existsSync(superPassFile) ? readFileSync(superPassFile, "utf8").trim() : "");
if (!superPass) throw new Error("No superuser password: set PGSUPERPASS or create " + superPassFile);

const owner = new URL(required("OWNER_DATABASE_URL"));
if (!["localhost", "127.0.0.1", "::1"].includes(owner.hostname)) throw new Error("Rehearsal databases are local only");
const admin = new pg.Client({ host: owner.hostname, port: Number(owner.port || 5432), user: "postgres", password: superPass, database: "postgres" });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'kb_rehearsal'");
if (!exists.rowCount) await admin.query(`CREATE DATABASE kb_rehearsal OWNER kb_owner ENCODING 'UTF8'`);
await admin.query("REVOKE ALL ON DATABASE kb_rehearsal FROM PUBLIC");
await admin.query("GRANT CONNECT ON DATABASE kb_rehearsal TO kb_app");
await admin.end();

owner.pathname = "/kb_rehearsal";
if (!readFileSync(ownerEnvFile, "utf8").includes("REHEARSAL_OWNER_DATABASE_URL")) {
  appendFileSync(ownerEnvFile, `REHEARSAL_OWNER_DATABASE_URL=${owner.toString()}\n`);
}
await migrate(owner.toString());
console.log("kb_rehearsal is ready and migrated.");
