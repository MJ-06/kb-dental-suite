// HTTP/database acceptance against ONLY the provisioner's dedicated synthetic DBs.
// Passwords, tokens and patient rows stay in process memory; only check names print.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";

const root = fileURLToPath(new URL("../.organization-demo-runtime/", import.meta.url));
const codeList = ["org-a", "org-b"] as const;
const contexts = codeList.map(code => {
  const config = parseEnv(readFileSync(`${root}${code}/app.env`, "utf8"));
  const state = JSON.parse(readFileSync(`${root}${code}/provision-state.json`, "utf8"));
  if (!state.complete || state.code !== code || config.KB_ORGANIZATION_CODE !== code ||
      new URL(config.DATABASE_URL!).pathname !== `/kb_org_demo_${code.slice(-1)}` || config.HOST !== "127.0.0.1") {
    throw new Error("Only completed dedicated synthetic demo targets are permitted");
  }
  return { code, config, password: state.demoPassword as string };
});
type Target = typeof contexts[number];
type Reply = { status: number; data: any; headers: Record<string, any>; body: string };

async function call(target: Target, path: string, options: { payload?: object; cookie?: string; hostname?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.payload === undefined ? undefined : JSON.stringify(options.payload);
    const authority = new URL(`http://${options.hostname ?? target.config.KB_ORGANIZATION_HOSTNAME}`);
    if (!authority.port) authority.port = target.config.PORT!;
    const req = request({ hostname: "127.0.0.1", port: Number(target.config.PORT), path,
      method: body === undefined ? "GET" : "POST", timeout: 15000,
      headers: { host: authority.host,
        ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        ...(options.cookie ? { cookie: options.cookie } : {}) } }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", part => text += part);
      res.on("end", () => {
        let data: unknown; try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode ?? 0, data, headers: res.headers, body: text });
      });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Demo request timed out")));
    req.end(body);
  });
}
let checked = 0;
function check(condition: unknown, name: string) {
  if (!condition) throw new Error(`Acceptance failed: ${name}`);
  checked++; console.log(`PASS ${name}`);
}
async function login(target: Target, username: string) {
  const response = await call(target, "/api/v1/auth/login", { payload: { username, password: target.password } });
  check(response.status === 200, `${target.code}: ${username} sign-in`);
  const header = response.headers["set-cookie"]?.find((v: string) => v.startsWith("org_session="));
  check(header && !/;\s*Domain=/i.test(header) && /HttpOnly/i.test(header), `${target.code}: host-only HttpOnly session`);
  return { cookie: header.split(";")[0] as string, ...response.data };
}

async function main() {
  const [a, b] = contexts as [Target, Target];
  for (const target of contexts) {
    check((await call(target, "/health")).status === 200, `${target.code}: identity and DB health`);
    check((await call(target, "/")).body.includes("organization.js"), `${target.code}: workspace HTML served`);
    check((await call(target, "/organization.js")).status === 200 && (await call(target, "/organization.css")).status === 200, `${target.code}: local assets served`);
    check((await call(target, "/api/v1/organization/units")).status === 401, `${target.code}: anonymous access rejected`);
    check((await call(target, "/health", { hostname: "other.localhost" })).status === 421, `${target.code}: foreign host rejected`);
    check((await call(target, "/exec?action=getAllPatients")).status === 404, `${target.code}: legacy bypass unavailable`);
  }
  const doctor = await login(a, "doctor"), limited = await login(a, "doctor-one"), admin = await login(a, "admin"), bDoctor = await login(b, "doctor");
  check(doctor.units.length === 2 && bDoctor.units.length === 1, "A has two clinics; B has one");
  check((await call(b, "/api/v1/auth/me", { cookie: doctor.cookie })).status === 401, "A session rejected at B");
  const prefix = "/api/v1/organization";
  const [u1, u2] = doctor.units;
  const identity = await call(a, `${prefix}/patients`, { cookie: doctor.cookie, payload: { unit_id: u1.id, name: "Synthetic Journey Example", phone: "9000000098" } });
  check(identity.status === 200, "Register shared organization identity");
  const patient = identity.data.patient;
  check((await call(a, `${prefix}/patients/${patient.id}?unit_id=${u2.id}`, { cookie: doctor.cookie })).status === 200, "Same identity available in second authorized clinic");
  check((await call(b, `${prefix}/patients/${patient.id}?unit_id=${bDoctor.units[0].id}`, { cookie: bDoctor.cookie })).status === 404, "A patient unavailable in B");
  check((await call(a, `${prefix}/patients/${patient.id}/history?unit_id=${u2.id}`, { cookie: limited.cookie })).status === 403, "Single-clinic doctor cannot read second clinic history");
  check((await call(a, `${prefix}/patients/${patient.id}/history?unit_id=${u1.id}`, { cookie: admin.cookie })).status === 403, "Administration does not imply clinical access");
  const note = await call(a, `${prefix}/notes`, { cookie: doctor.cookie, payload: { unit_id: u2.id, patient_id: patient.id, text: "Synthetic follow-up at second clinic; no actual patient information." } });
  check(note.status === 200, "Record visit at second clinic");
  const metrics = await call(a, `${prefix}/metrics`, { cookie: admin.cookie });
  check(metrics.status === 200 && metrics.data.units.length === 2, "Organization dashboard returns both clinic sections");
  const inactive = await call(a, `${prefix}/settings`, { cookie: admin.cookie, payload: { unit_id: u1.id, key: "fees", value: [] } });
  check(inactive.status === 403, "Locked clinic fee override rejected");
  for (const [from, to] of [[a, b], [b, a]] as const) {
    const url = new URL(from.config.DATABASE_URL!); url.pathname = new URL(to.config.DATABASE_URL!).pathname;
    const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    let denied = false;
    try { await client.connect(); } catch (error) { denied = (error as { code?: string }).code === "42501"; }
    finally { await client.end().catch(() => {}); }
    check(denied, `${from.code}: runtime credential cannot connect to other organization DB`);
  }
  check(a.config.KB_DOCUMENT_ROOT !== b.config.KB_DOCUMENT_ROOT, "Organization document roots are distinct");
  console.log(`${checked} synthetic demo acceptance checks passed. No credentials, tokens or source patient data printed.`);
}
main().catch(error => {
  const message = error instanceof Error && error.message.startsWith("Acceptance failed:") ? error.message : "Demo verification failed; inspect local services/config without printing secrets.";
  console.error(message); process.exitCode = 1;
});
