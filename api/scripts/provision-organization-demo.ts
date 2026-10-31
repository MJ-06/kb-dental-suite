// Creates only dedicated synthetic organization demo resources. Dry-run by default.
// Deliberately does not import src/env.ts or the development bootstrap/reset tools.
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../src/migrator.js";
import { seedOrganization } from "../src/organization/seed.js";
import { seedDemoWork } from "./demo-organization-fixtures.js";

const runtime = fileURLToPath(new URL("../.organization-demo-runtime/", import.meta.url));
const plans = [
  { code: "org-a", name: "Organization A — synthetic demo", database: "kb_org_demo_a", hostname: "org-a.localhost:8101", port: 8101,
    clinics: [{ code: "a1", name: "Org A · Riverside Clinic" }, { code: "a2", name: "Org A · Orchard Clinic" }] },
  { code: "org-b", name: "Organization B — synthetic demo", database: "kb_org_demo_b", hostname: "org-b.localhost:8102", port: 8102,
    clinics: [{ code: "b1", name: "Org B · Meadow Clinic" }] }
] as const;
type Plan = typeof plans[number];
interface State {
  format: 1; code: string; database: string; host: string; port: number;
  operation: string; marker: string; ownerRole: string; appRole: string;
  ownerPassword: string; appPassword: string; demoPassword: string; secretsKey: string;
  complete: boolean;
}
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const secret = () => randomBytes(24).toString("base64url");
let phase = "argument/preflight validation";

function protectDirectory(path: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Runtime directory cannot be a link.");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    // Use SID rather than account display name; no secrets go to command arguments.
    const identity = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = identity.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) throw new Error("Cannot determine current Windows SID for runtime ACL.");
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
  } else chmodSync(path, 0o700);
}

function saveState(path: string, state: State) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function writeConfig(path: string, contents: string) {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== contents) {
      throw new Error("An existing demo config differs; refusing to overwrite it.");
    }
    return;
  }
  writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
}

function url(user: string, password: string, state: State) {
  const value = new URL(`postgresql://${state.host}:${state.port}/${state.database}`);
  value.username = user;
  value.password = password;
  return value.toString();
}

async function ensureRole(admin: pg.Client, name: string, password: string, marker: string) {
  const found = (await admin.query(
    "SELECT shobj_description(oid, 'pg_authid') AS marker, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1", [name]
  )).rows[0];
  if (found) {
    if (found.marker !== marker || found.rolsuper || found.rolcreatedb || found.rolcreaterole || found.rolbypassrls) {
      throw new Error("Existing role ownership/attributes differ; refusing to adopt it.");
    }
    return;
  }
  // CREATE ROLE and its identity marker are atomic, so a crash cannot leave an
  // unmarked role that a later run might accidentally adopt.
  await admin.query("BEGIN");
  try {
    await admin.query(`CREATE ROLE ${ident(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`);
    await admin.query(`COMMENT ON ROLE ${ident(name)} IS ${literal(marker)}`);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function verifyDatabase(admin: pg.Client, state: State): Promise<boolean> {
  const row = (await admin.query(
    "SELECT shobj_description(d.oid, 'pg_database') AS marker, r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1", [state.database]
  )).rows[0];
  if (!row) return false;
  if (row.marker !== state.marker || row.owner !== state.ownerRole) throw new Error("Existing database identity differs; refusing to modify it.");
  return true;
}

async function grantRuntime(admin: pg.Client, state: State, superPassword: string) {
  const client = new pg.Client({ host: state.host, port: state.port, database: state.database, user: "postgres", password: superPassword });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Existing migrations grant kb_app; it must not gain access to these new DBs.
    await client.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kb_app");
    await client.query("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, kb_app");
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${ident(state.appRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ident(state.appRole)}`);
    const tables = (await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND left(tablename,4)='org_'"
    )).rows;
    if (!tables.length) throw new Error("Organization schema missing.");
    for (const { tablename } of tables) {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${ident(tablename)} TO ${ident(state.appRole)}`);
    }
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON public.org_identity FROM ${ident(state.appRole)}`);
    await client.query(`REVOKE UPDATE, DELETE ON public.org_forms, public.org_notes, public.org_submissions, public.org_audit FROM ${ident(state.appRole)}`);
    await client.query(`REVOKE DELETE ON public.org_receipts FROM ${ident(state.appRole)}`);
    // The organization housekeeping trigger calls this existing context helper.
    await client.query(`GRANT EXECUTE ON FUNCTION public.app_user_id() TO ${ident(state.appRole)}`);
    const functions = (await client.query<{ signature: string }>(
      "SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND left(p.proname,4)='org_'"
    )).rows;
    // Signature comes from PostgreSQL's regprocedure formatter, not user input.
    for (const { signature } of functions) await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${ident(state.appRole)}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { await client.end(); }
  await admin.query(`GRANT CONNECT ON DATABASE ${ident(state.database)} TO ${ident(state.appRole)}`);
}

async function provision(admin: pg.Client, plan: Plan, host: string, port: number, superPassword: string) {
  phase = `${plan.code}: ownership preflight`;
  const root = join(runtime, plan.code);
  const stateFile = join(root, "provision-state.json");
  const databaseExists = (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [plan.database])).rowCount;
  if (!existsSync(stateFile) && databaseExists) throw new Error("Dedicated target already exists without this provisioner's ownership record; refusing it.");
  protectDirectory(root);
  let state: State;
  if (existsSync(stateFile)) {
    if (lstatSync(stateFile).isSymbolicLink()) throw new Error("State file cannot be a link.");
    state = JSON.parse(readFileSync(stateFile, "utf8")) as State;
    if (state.format !== 1 || state.code !== plan.code || state.database !== plan.database || state.host !== host || state.port !== port ||
        !new RegExp(`^${plan.database}_owner_[a-f0-9]{12}$`).test(state.ownerRole) || !new RegExp(`^${plan.database}_app_[a-f0-9]{12}$`).test(state.appRole) ||
        state.marker !== `kb-org-demo:v1:${plan.code}:${state.operation}` || !state.ownerPassword || !state.appPassword || !state.demoPassword || !state.secretsKey) {
      throw new Error("Demo state does not match the dedicated target.");
    }
  } else {
    const operation = randomUUID();
    const suffix = randomBytes(6).toString("hex");
    state = { format: 1, code: plan.code, database: plan.database, host, port, operation,
      marker: `kb-org-demo:v1:${plan.code}:${operation}`, ownerRole: `${plan.database}_owner_${suffix}`, appRole: `${plan.database}_app_${suffix}`,
      ownerPassword: secret(), appPassword: secret(), demoPassword: secret(), secretsKey: randomBytes(32).toString("base64"), complete: false };
    saveState(stateFile, state);
  }
  if (state.complete) {
    if (!await verifyDatabase(admin, state)) throw new Error("Completed demo database is missing; refusing to recreate it automatically.");
    const roles = (await admin.query(
      "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=ANY($1::text[])",
      [[state.ownerRole, state.appRole]]
    )).rows;
    if (roles.length !== 2 || roles.some((role) => !role.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.marker !== state.marker)) {
      throw new Error("Completed demo roles differ from the protected ownership record.");
    }
    const memberships = (await admin.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=ANY($1::text[]) LIMIT 1", [[state.ownerRole, state.appRole]])).rowCount;
    if (memberships) throw new Error("Unexpected role membership on completed demo.");
    for (const filename of ["app.env", "owner.env", "demo-logins.txt"]) {
      const path = join(root, filename);
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Completed demo configuration is missing or unsafe.");
    }
    const probe = new pg.Client({ host, port, database: state.database, user: "postgres", password: superPassword });
    await probe.connect();
    try {
      await probe.query("BEGIN READ ONLY");
      const identities = (await probe.query("SELECT code,hostname FROM public.org_identity")).rows;
      if (identities.length !== 1 || identities[0].code !== plan.code || identities[0].hostname !== plan.hostname) throw new Error("Completed demo organization identity differs.");
      await probe.query("ROLLBACK");
    } finally { await probe.end(); }
    console.log(`${plan.code}: validated existing completed demo; no changes.`);
    return;
  }
  await ensureRole(admin, state.ownerRole, state.ownerPassword, state.marker);
  await ensureRole(admin, state.appRole, state.appPassword, state.marker);
  if (!await verifyDatabase(admin, state)) {
    await admin.query(`CREATE DATABASE ${ident(state.database)} OWNER ${ident(state.ownerRole)} ENCODING 'UTF8'`);
    // CREATE DATABASE cannot be transactional. If interrupted before this marker,
    // next run refuses adoption; manual identity review is deliberately required.
    await admin.query(`COMMENT ON DATABASE ${ident(state.database)} IS ${literal(state.marker)}`);
  }
  await admin.query(`REVOKE ALL ON DATABASE ${ident(state.database)} FROM PUBLIC`);
  await admin.query(`REVOKE ALL ON DATABASE ${ident(state.database)} FROM kb_app`);
  const ownerUrl = url(state.ownerRole, state.ownerPassword, state);
  // A separate lock persists on the admin connection while migrate() opens its own.
  phase = `${plan.code}: migration`;
  await migrate(ownerUrl, () => {});
  phase = `${plan.code}: synthetic seed`;
  await seedOrganization(ownerUrl, { code: plan.code, name: plan.name, hostname: plan.hostname,
    clinics: plan.clinics.map((clinic) => ({ ...clinic })), password: state.demoPassword });
  await seedDemoWork(ownerUrl, plan.code);
  phase = `${plan.code}: runtime grants`;
  await grantRuntime(admin, state, superPassword);
  phase = `${plan.code}: private config`;
  const documents = join(root, "documents");
  protectDirectory(documents);
  writeConfig(join(root, "app.env"), [
    "# Synthetic organization demonstration only. Contains secrets; never commit.",
    `DATABASE_URL=${url(state.appRole, state.appPassword, state)}`,
    `KB_ORGANIZATION_CODE=${plan.code}`, `KB_ORGANIZATION_HOSTNAME=${plan.hostname}`,
    `KB_DOCUMENT_ROOT=${documents.replaceAll("\\", "/")}`, `KB_SECRETS_KEY=${state.secretsKey}`,
    `PORT=${plan.port}`, "HOST=127.0.0.1", "KB_LOCAL_DEMO=1", "COOKIE_SECURE=false", ""
  ].join("\n"));
  writeConfig(join(root, "owner.env"), `OWNER_DATABASE_URL=${ownerUrl}\n`);
  writeConfig(join(root, "demo-logins.txt"), [
    "SYNTHETIC LOCAL DEMO ONLY — do not copy into chat, code or commits.",
    `Origin: http://${plan.hostname}`, "Usernames: admin, clinic-admin, doctor, doctor-one, reception, accounts",
    `Password for these fictional accounts: ${state.demoPassword}`, ""
  ].join("\n"));
  state.complete = true;
  saveState(stateFile, state);
  console.log(`${plan.code}: provisioned dedicated synthetic database, runtime config and document root. Credentials are in the ignored runtime directory; none printed.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply", "--help"].includes(arg))) throw new Error("Unknown argument.");
  if (args.includes("--help") || !args.includes("--apply")) {
    console.log("Dry-run only: would create NEW dedicated kb_org_demo_a (2 clinics) and kb_org_demo_b (1 clinic), unique roles, ignored config and local documents.");
    console.log("Would apply existing migrations and seed only synthetic records; no existing database reset, source-data copy, server startup or passwords printed.");
    console.log("Apply after review: node --import tsx scripts/provision-organization-demo.ts --apply");
    return;
  }
  const host = process.env.PGHOST ?? "localhost";
  const port = Number(process.env.PGPORT ?? 5432);
  if (!["localhost", "127.0.0.1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("This provisioner permits only local PostgreSQL.");
  const superPassword = process.env.PGSUPERPASS ?? readFileSync(join(homedir(), ".kb-pms", "postgres-superuser.txt"), "utf8").trim();
  if (!superPassword) throw new Error("Local PostgreSQL administrative credential is missing.");
  protectDirectory(runtime);
  const admin = new pg.Client({ host, port, database: "postgres", user: "postgres", password: superPassword, application_name: "kb_org_demo_provision" });
  await admin.connect();
  try {
    const locked = (await admin.query("SELECT pg_try_advisory_lock(731842, 20261031) AS locked")).rows[0]?.locked;
    if (!locked) throw new Error("Another organization demo provisioner is running.");
    for (const plan of plans) await provision(admin, plan, host, port, superPassword);
  } finally { await admin.end(); }
}

main().catch(() => {
  // Do not print raw SQL/driver errors: they can include credentials or seeded values.
  console.error(`Organization demo provisioning stopped at ${phase}. No passwords or database rows were printed. Review ignored state/config and target ownership privately before retry; no databases were dropped.`);
  process.exitCode = 1;
});
