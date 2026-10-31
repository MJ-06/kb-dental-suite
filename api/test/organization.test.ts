// Regression/security specifications authored before organization implementation.
// Run ONLY under the coordinator's serialized shared-test-database ownership.
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/index.js";
import { buildOrganizationApp } from "../src/organization/app.js";
import { seedOrganization } from "../src/organization/seed.js";
import { APP_URL, OWNER_URL, PASSWORD, resetDatabase } from "./setup.js";

let app: Awaited<ReturnType<typeof buildOrganizationApp>>;
let db: ReturnType<typeof createDb>;
let seed: Awaited<ReturnType<typeof seedOrganization>>;
const host = "org-a.localhost";
const cookies: Record<string, string> = {};
let documentRoot:string;
async function call(user: string, method: "GET" | "POST", path: string, payload?: object) {
  return app.inject({ method, url: path.startsWith("/api") ? path : `/api/v1/organization${path}`,
    headers: { host, ...(cookies[user] ? { cookie: cookies[user] } : {}) }, payload });
}
beforeAll(async () => {
  await resetDatabase();
  seed = await seedOrganization(OWNER_URL, { code: "org-a", name: "Fictional A", hostname: host, password: PASSWORD });
  db = createDb(APP_URL, 3);
  documentRoot=await mkdtemp(join(tmpdir(),"org-demo-test-"));
  app = await buildOrganizationApp({ db, code: "org-a", hostname: host, documentRoot, cookieSecure: false });
  for (const username of ["admin", "doctor", "doctor-one", "reception", "accounts", "clinic-admin"]) {
    const r = await call("", "POST", "/api/v1/auth/login", { username, password: PASSWORD });
    expect(r.statusCode).toBe(200);
    cookies[username] = `org_session=${r.cookies.find(c => c.name === "org_session")!.value}`;
  }
});
afterAll(async () => { await app?.close(); await db?.destroy(); if(documentRoot)await rm(documentRoot,{recursive:true,force:true}); });
it("rejects anonymous, foreign host and cross-origin mutation", async () => {
  expect((await call("", "GET", "/units")).statusCode).toBe(401);
  expect((await app.inject({ url: "/health", headers: { host: "org-b.localhost" } })).statusCode).toBe(421);
  expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { host, origin: "http://org-b.localhost", cookie: cookies.doctor }, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({url:"/health",headers:{host:`${host}:8101`}})).statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:"/api/v1/auth/logout",headers:{host:`${host}:8101`,origin:`http://${host}:8101`},payload:{}})).statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:"/api/v1/auth/logout",headers:{host:`${host}:8101`,origin:`http://${host}:8102`},payload:{}})).statusCode).toBe(403);
});
it("keeps administrative and clinical authority separate, denies foreign unit", async () => {
  const patient = seed.patients[0]!;
  expect((await call("admin", "GET", `/patients/${patient.id}/history?unit_id=${seed.units[0]!.id}`)).statusCode).toBe(403);
  expect((await call("doctor-one", "GET", `/patients/${patient.id}/history?unit_id=${seed.units[1]!.id}`)).statusCode).toBe(403);
  expect((await call("doctor", "GET", `/patients/${patient.id}/history?unit_id=${seed.units[1]!.id}`)).statusCode).toBe(200);
});
it("shares identity, allows family phones and rejects stale edits", async () => {
  const unit_id = seed.units[0]!.id;
  const p = (await call("reception", "POST", "/patients", { unit_id, name: "Synthetic Family", phone: "9000000099" })).json().patient;
  const second = await call("reception", "POST", "/patients", { unit_id, name: "Synthetic Family Child", phone: "9000000099" });
  expect(second.statusCode).toBe(200);
  expect(second.json().duplicate_warning).toBe(true);
  expect((await call("reception", "POST", `/patients/${p.id}`, { unit_id, version: p.version, name: "Synthetic Updated", phone: p.phone })).statusCode).toBe(200);
  expect((await call("reception", "POST", `/patients/${p.id}`, { unit_id, version: p.version, name: "Stale", phone: p.phone })).statusCode).toBe(409);
  expect((await call("reception", "GET", "/patients")).statusCode).toBe(400);
});
it("requires meaningful literal name confirmation for phone discovery",async()=>{
  const unit_id=seed.units[0]!.id,phone="9000000088";
  await call("reception","POST","/patients",{unit_id,name:"Synthetic Family Parent",phone});
  await call("reception","POST","/patients",{unit_id,name:"Synthetic Family Child",phone});
  for(const name of ["%","_","\\"]){
    const response=await call("reception","GET",`/patients?phone=${phone}&name=${encodeURIComponent(name)}`);
    expect(response.statusCode,`symbol-only confirmation ${name}`).toBe(400);
    expect(response.json().patients).toBeUndefined();
  }
  const normal=await call("reception","GET",`/patients?phone=${phone}&name=family`);
  expect(normal.statusCode).toBe(200);
  expect(normal.json().patients).toHaveLength(2);
  const literal=await call("reception","GET",`/patients?phone=${phone}&name=${encodeURIComponent("Family_")}`);
  expect(literal.statusCode).toBe(200);
  expect(literal.json().patients).toHaveLength(0);
  const punctuation="Synthetic_100%\\ Example";
  await call("reception","POST","/patients",{unit_id,name:punctuation,phone});
  const exactLiteral=await call("reception","GET",`/patients?phone=${phone}&name=${encodeURIComponent("_100%\\")}`);
  expect(exactLiteral.statusCode).toBe(200);
  expect(exactLiteral.json().patients.map((p:any)=>p.name)).toEqual([punctuation]);
});
it("blocks shared-doctor overlapping appointments across units", async () => {
  const doctor_id = seed.users.find(u => u.username === "doctor")!.id;
  const body = { patient_id: seed.patients[0]!.id, doctor_id, starts_at: "2030-01-10T04:30:00Z", ends_at: "2030-01-10T05:00:00Z" };
  expect((await call("reception", "POST", "/appointments", { ...body, unit_id: seed.units[0]!.id })).statusCode).toBe(200);
  expect((await call("doctor", "POST", "/appointments", { ...body, unit_id: seed.units[1]!.id })).statusCode).toBe(409);
});
it("preserves finalized note and records addendum", async () => {
  const unit_id = seed.units[0]!.id, patient_id = seed.patients[0]!.id;
  const r = await call("doctor", "POST", "/notes", { unit_id, patient_id, text: "Fictional examination note" });
  expect(r.statusCode).toBe(200);
  expect((await call("doctor", "POST", `/notes/${r.json().note.id}/addenda`, { unit_id, text: "Fictional correction" })).statusCode).toBe(200);
  const notes = (await call("doctor", "GET", `/patients/${patient_id}/history?unit_id=${unit_id}`)).json().notes;
  expect(notes.some((n: any) => n.text === "Fictional examination note")).toBe(true);
  expect(notes.some((n: any) => n.parent_id === r.json().note.id)).toBe(true);
});
it("enforces immutable form version assignment and locked settings", async () => {
  const form = (await call("admin", "POST", "/forms", { key: "demo-check", title: "Check", fields: [{ key: "finding", label: "Finding", required: true }], unit_ids: [seed.units[0]!.id] })).json().form;
  const submission = { unit_id: seed.units[1]!.id, patient_id: seed.patients[0]!.id, form_id: form.id, answers: { finding: "Synthetic" } };
  expect((await call("doctor", "POST", "/submissions", submission)).statusCode).toBe(409);
  expect((await call("doctor", "POST", "/submissions", { ...submission, unit_id: seed.units[0]!.id, answers: {} })).statusCode).toBe(400);
  expect((await call("doctor", "POST", "/submissions", { ...submission, unit_id: seed.units[0]!.id })).statusCode).toBe(200);
  expect((await call("clinic-admin", "POST", "/settings", { unit_id: seed.units[0]!.id, key: "fees", value: [] })).statusCode).toBe(403);
  expect((await call("clinic-admin", "POST", "/settings", { unit_id: seed.units[0]!.id, key: "contact", value: "Synthetic contact" })).statusCode).toBe(200);
});
it("changes versioned organization defaults while preserving clinic overrides and reset inheritance",async()=>{
  const one=seed.units[0]!.id,two=seed.units[1]!.id;
  const defaults=await call("admin","GET","/settings/defaults");
  expect(defaults.statusCode).toBe(200);
  const original=defaults.json().settings.find((s:any)=>s.key==="opening_hours");
  expect(original.source).toBe("organization");
  expect(original.version).toBeGreaterThan(0);
  const inherited=async(unit:string)=>(await call("admin","GET",`/settings?unit_id=${unit}`)).json().settings.find((s:any)=>s.key==="opening_hours");
  const firstDefault="Synthetic hours 08:00–16:00";
  expect((await call("admin","POST","/settings/defaults",{key:"opening_hours",value:firstDefault,version:original.version})).statusCode).toBe(200);
  expect((await inherited(one)).value).toBe(firstDefault);
  expect((await inherited(two)).value).toBe(firstDefault);
  expect((await call("clinic-admin","POST","/settings",{unit_id:one,key:"opening_hours",value:"Synthetic clinic hours 10:00–18:00",version:0})).statusCode).toBe(200);
  const current=(await call("admin","GET","/settings/defaults")).json().settings.find((s:any)=>s.key==="opening_hours");
  const secondDefault="Synthetic hours 09:00–17:00";
  expect((await call("admin","POST","/settings/defaults",{key:"opening_hours",value:secondDefault,version:current.version})).statusCode).toBe(200);
  expect((await inherited(one)).value).toBe("Synthetic clinic hours 10:00–18:00");
  expect((await inherited(two)).value).toBe(secondDefault);
  const override=await inherited(one);
  expect((await call("clinic-admin","POST","/settings/reset",{unit_id:one,key:"opening_hours",version:override.version})).statusCode).toBe(200);
  expect((await inherited(one)).value).toBe(secondDefault);
  expect((await inherited(one)).source).toBe("inherited");
  expect((await call("admin","POST","/settings/defaults",{key:"opening_hours",value:"Stale default",version:current.version})).statusCode).toBe(409);
  expect((await call("clinic-admin","GET","/settings/defaults")).statusCode).toBe(403);
  expect((await call("clinic-admin","POST","/settings/defaults",{key:"opening_hours",value:"Denied",version:current.version+1})).statusCode).toBe(403);
});
it("validates centrally controlled fees and catalogue without unlocking protected settings",async()=>{
  const values=(await call("admin","GET","/settings/defaults")).json().settings;
  const version=(key:string)=>values.find((s:any)=>s.key===key).version;
  const fees=[{code:"DEMO",name:"Synthetic consultation",amount:325}];
  expect((await call("admin","POST","/settings/defaults",{key:"fees",value:fees,version:version("fees")})).statusCode).toBe(200);
  expect((await call("admin","POST","/settings/defaults",{key:"catalogue",value:["Synthetic consultation"],version:version("catalogue")})).statusCode).toBe(200);
  expect((await call("admin","POST","/settings/defaults",{key:"fees",value:[{code:"BAD",name:"Bad",amount:-1}],version:version("fees")+1})).statusCode).toBe(400);
  expect((await call("admin","POST","/settings/defaults",{key:"catalogue",value:[{name:"Invalid"}],version:version("catalogue")+1})).statusCode).toBe(400);
  for(const key of ["identity","access","forms"])expect((await call("admin","POST","/settings/defaults",{key,value:"Blocked",version:version(key)})).statusCode).toBe(403);
  expect((await call("clinic-admin","POST","/settings",{unit_id:seed.units[0]!.id,key:"fees",value:fees,version:0})).statusCode).toBe(403);
});
it("keeps clinic receipts and balances local and records voids", async () => {
  const unit_id = seed.units[0]!.id, patient_id = seed.patients[0]!.id;
  const r = await call("accounts", "POST", "/receipts", { unit_id, patient_id, charge: 100, paid: 40, description: "Synthetic visit" });
  expect(r.statusCode).toBe(200);
  expect((await call("accounts", "GET", `/receipts?unit_id=${unit_id}&patient_id=${patient_id}`)).json().balance).toBe(60);
  expect((await call("accounts", "GET", `/receipts?unit_id=${seed.units[1]!.id}&patient_id=${patient_id}`)).statusCode).toBe(403);
  expect((await call("accounts", "POST", `/receipts/${r.json().receipt.id}/void`, { unit_id, reason: "Synthetic correction" })).statusCode).toBe(200);
  expect((await call("accounts", "GET", `/receipts?unit_id=${unit_id}&patient_id=${patient_id}`)).json().balance).toBe(0);
});
it("rejects voiding a charge already settled by a later payment",async()=>{
  const unit_id=seed.units[0]!.id;
  const patient_id=(await call("reception","POST","/patients",{unit_id,name:"Synthetic Settled Balance",phone:"9000000087"})).json().patient.id;
  const charge=await call("accounts","POST","/receipts",{unit_id,patient_id,charge:100,paid:0,description:"Synthetic charge"});
  expect(charge.statusCode).toBe(200);
  expect((await call("accounts","POST","/receipts",{unit_id,patient_id,charge:0,paid:100,description:"Synthetic settlement"})).statusCode).toBe(200);
  const receipt_id=charge.json().receipt.id;
  const refused=await call("accounts","POST",`/receipts/${receipt_id}/void`,{unit_id,reason:"Would create unsupported credit"});
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe("negative_balance");
  const after=(await call("accounts","GET",`/receipts?unit_id=${unit_id}&patient_id=${patient_id}`)).json();
  expect(after.balance).toBe(0);
  expect(after.receipts.find((r:any)=>r.id===receipt_id).voided_at).toBeNull();
  const events=(await call("admin","GET","/audit")).json().events;
  expect(events.some((e:any)=>e.subject_id===receipt_id&&e.action==="receipt.voided")).toBe(false);
});
it("serializes concurrent receipt payment and charge void without creating credit",async()=>{
  const unit_id=seed.units[0]!.id;
  const patient_id=(await call("reception","POST","/patients",{unit_id,name:"Synthetic Concurrent Balance",phone:"9000000086"})).json().patient.id;
  const charge=await call("accounts","POST","/receipts",{unit_id,patient_id,charge:100,paid:0,description:"Synthetic concurrent charge"});
  expect(charge.statusCode).toBe(200);
  const results=await Promise.all([
    call("accounts","POST","/receipts",{unit_id,patient_id,charge:0,paid:100,description:"Synthetic concurrent payment"}),
    call("accounts","POST",`/receipts/${charge.json().receipt.id}/void`,{unit_id,reason:"Synthetic concurrent correction"})
  ]);
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect((await call("accounts","GET",`/receipts?unit_id=${unit_id}&patient_id=${patient_id}`)).json().balance).toBe(0);
});
it("stores fictional documents with exact clinic scope and checksum",async()=>{
  const unit_id=seed.units[0]!.id,patient_id=seed.patients[0]!.id;
  const upload=await call("doctor","POST","/documents",{unit_id,patient_id,filename:"fictional.txt",mime:"text/plain",base64:Buffer.from("Fictional demo document only").toString("base64")});
  expect(upload.statusCode).toBe(200);
  const document=upload.json().document;
  expect(document.sha256).toHaveLength(64);
  expect((await call("doctor","GET",`/documents/${document.id}/download?unit_id=${unit_id}`)).body).toBe("Fictional demo document only");
  expect((await call("doctor-one","GET",`/documents/${document.id}/download?unit_id=${seed.units[1]!.id}`)).statusCode).toBe(403);
  expect((await call("admin","GET",`/documents?unit_id=${unit_id}&patient_id=${patient_id}`)).statusCode).toBe(403);
});
it("reports distinct organization identities and revokes on next request", async () => {
  const m = await call("admin", "GET", "/metrics");
  expect(m.statusCode).toBe(200);
  expect(m.json().unique_patients).toBeGreaterThanOrEqual(2);
  const user_id = seed.users.find(u => u.username === "doctor-one")!.id;
  expect((await call("admin", "POST", "/grants", { user_id, unit_id: seed.units[0]!.id, permissions: [] })).statusCode).toBe(200);
  expect((await call("doctor-one", "GET", `/patients/${seed.patients[0]!.id}/history?unit_id=${seed.units[0]!.id}`)).statusCode).toBe(403);
});
