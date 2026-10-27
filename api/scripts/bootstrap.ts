// One-time setup on a new machine: creates the two database roles and the
// two databases, then writes .env. Run as the PostgreSQL superuser, whose
// password is read from ~/.kb-pms/postgres-superuser.txt (or PGSUPERPASS).
//
// Safe to run again: existing roles get new passwords and .env is rewritten.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ownerEnvFile } from "../src/env.js";

const superPassFile = join(homedir(), ".kb-pms", "postgres-superuser.txt");
const superPass = process.env.PGSUPERPASS ?? (existsSync(superPassFile) ? readFileSync(superPassFile, "utf8").trim() : "");
if (!superPass) throw new Error(`No superuser password: set PGSUPERPASS or create ${superPassFile}`);

const host = process.env.PGHOST ?? "localhost";
const port = Number(process.env.PGPORT ?? 5432);
const secret = () => randomBytes(24).toString("base64url");
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

const admin = new pg.Client({ host, port, user: "postgres", password: superPass, database: "postgres" });
await admin.connect();

const ownerPass = secret();
const appPass = secret();

async function ensureRole(name: string, password: string) {
  const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  const verb = exists.rowCount ? "ALTER" : "CREATE";
  // NOBYPASSRLS is the default; it is spelled out because the whole design
  // depends on it.
  await admin.query(`${verb} ROLE ${ident(name)} LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(password)}`);
}
await ensureRole("kb_owner", ownerPass);
await ensureRole("kb_app", appPass);

for (const db of ["kb_pms", "kb_pms_test"]) {
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${ident(db)} OWNER kb_owner ENCODING 'UTF8'`);
  await admin.query(`REVOKE ALL ON DATABASE ${ident(db)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO kb_app`);
}
await admin.end();

const url = (user: string, pass: string, db: string) => `postgres://${user}:${pass}@${host}:${port}/${db}`;

// The running app only ever gets kb_app's password. kb_owner's (which can
// change the schema) goes in a separate file in the user's profile, read
// only by migrations, tests and the onboarding scripts.
function writeSecret(path: string | URL, lines: string[]) {
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // tightens a file that already existed
}
writeSecret(new URL("../.env", import.meta.url), [
  "# Written by npm run db:bootstrap. Not committed.",
  `DATABASE_URL=${url("kb_app", appPass, "kb_pms")}`,
  `TEST_DATABASE_URL=${url("kb_app", appPass, "kb_pms_test")}`,
  "PORT=8080",
  "HOST=127.0.0.1",
  "COOKIE_SECURE=false"
]);
writeSecret(ownerEnvFile, [
  "# Schema-owner credentials. Never give these to the running app.",
  `OWNER_DATABASE_URL=${url("kb_owner", ownerPass, "kb_pms")}`,
  `TEST_OWNER_DATABASE_URL=${url("kb_owner", ownerPass, "kb_pms_test")}`
]);
console.log(`Roles and databases ready. App settings in .env; owner settings in ${ownerEnvFile}.`);
