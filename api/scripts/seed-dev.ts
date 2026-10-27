// A development clinic to click through on this machine: clinic "kbdev",
// one account per role, and the made-up masters a fresh clinic would set.
// The passwords are generated and written to ~/.kb-pms/dev-logins.txt
// (owner-only), never printed.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createClinic, createUser } from "../src/admin.js";
import { required } from "../src/env.js";
import type { Role } from "../src/db/schema.js";

const owner = required("OWNER_DATABASE_URL");
const c = new pg.Client({ connectionString: owner });
await c.connect();
const existing = await c.query<{ id: string }>("SELECT id FROM clinics WHERE code = 'kbdev'");
await c.end();
if (existing.rowCount) {
  console.log("Clinic kbdev already exists; nothing to do. Drop it first to reseed.");
  process.exit(0);
}

const file = join(homedir(), ".kb-pms", "dev-logins.txt");
// Reuse the passwords already handed out, so a reseed does not change them.
const previous = new Map<string, string>();
if (existsSync(file)) {
  for (const m of readFileSync(file, "utf8").matchAll(/username (\S+)\s+password (\S+)/g)) previous.set(m[1]!, m[2]!);
}

const clinicId = await createClinic(owner, { code: "kbdev", name: "KB Dental (development)" });
const lines = ["Development logins for http://127.0.0.1:8080 (clinic code: kbdev)"];
for (const role of ["admin", "doctor", "reception", "accounts"] as Role[]) {
  const password = previous.get(`dev-${role}`) ?? randomBytes(9).toString("base64url");
  await createUser(owner, clinicId, { username: `dev-${role}`, displayName: `Dev ${role}`, password, role });
  lines.push(`${role.padEnd(10)} username dev-${role}   password ${password}`);
}
writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Clinic kbdev created with 4 accounts. Logins written to ${file}`);
