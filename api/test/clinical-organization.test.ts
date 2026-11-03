import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "kysely";
import { runInNewContext } from "node:vm";
import { makeWorld, OWNER_URL, type World } from "./setup.js";
import { execLogin } from "./legacy.js";

let w: World, cookie: string, desk: string;
let revision = 1, clinic: string;
async function owner(fn: (c: pg.Client) => Promise<void>) {
  const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
  try { await c.query("BEGIN"); await fn(c); await c.query("COMMIT"); }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { await c.end(); }
}
async function call(action: string, params: Record<string, unknown> = {}, options: { cookie?: string; clinic?: string; revision?: number; method?: "GET" | "POST" } = {}) {
  const method = options.method ?? "POST";
  const payload = { action, ...params };
  const res = await w.app.inject({ method, url: "/exec", headers: {
    cookie: options.cookie ?? cookie, "x-kb-clinic": options.clinic ?? clinic,
    "x-kb-clinic-revision": String(options.revision ?? revision)
  }, ...(method === "POST" ? { payload } : { query: Object.fromEntries(Object.entries(payload).map(([k,v]) => [k,String(v)])) }) });
  return res.json();
}
beforeAll(async () => {
  w = await makeWorld(); clinic = w.clinicA;
  await owner(async c => {
    await c.query("INSERT INTO org_identity(id,code,name,hostname) VALUES('00000000-0000-4000-8000-000000000001','test-org','Example Organization','test.localhost')");
    await c.query("SELECT set_config('app.organization_id','00000000-0000-4000-8000-000000000001',true)");
    for (const [id, code] of [[w.clinicA,'first'],[w.clinicB,'second']]) {
      const u = await c.query("INSERT INTO org_units(code,name) VALUES($1,$1) RETURNING id", [code]);
      await c.query("INSERT INTO org_clinical_units(organization_id,unit_id,clinic_id) VALUES(org_id(),$1,$2)",[u.rows[0].id,id]);
    }
    await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicA]);
    const a = (await c.query("SELECT id FROM app_users WHERE username='a-admin'")).rows[0].id;
    await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicB]);
    const b = (await c.query("SELECT id FROM app_users WHERE username='b-admin'")).rows[0].id;
    await c.query("INSERT INTO org_clinical_access VALUES(org_id(),$1,$2,$1,$2,true),(org_id(),$1,$2,$3,$4,true)",[w.clinicA,a,w.clinicB,b]);
  });
  cookie = await execLogin(w,"alpha","a-admin"); desk = await execLogin(w,"alpha","a-desk");
});
afterAll(async () => { await w.close(); });

describe("preserved clinical UI organization bridge", () => {
  it("lists only granted clinics and does not accept query-string authorization", async () => {
    expect((await call("getWorkingClinics")).clinics).toHaveLength(2);
    expect((await call("getWorkingClinics",{}, {cookie:desk})).clinics).toHaveLength(1);
    const forged = await call("switchWorkingClinic",{clinicId:w.clinicB},{cookie:desk});
    expect(forged.success).toBe(false);
    expect((await call("switchWorkingClinic",{clinicId:w.clinicB},{method:"GET"})).success).toBe(false);
    expect((await call("switchWorkingClinic",{clinicId:"00000000-0000-4000-8000-000000000099"})).success).toBe(false);
  });
  it("pins rendered pages and refuses missing or stale clinic context", async () => {
    const page = await w.app.inject({url:"/",headers:{cookie}});
    expect(page.body.includes('window.KB_CLINIC_CONTEXT')).toBe(true);
    const missing = await w.app.inject({url:"/exec",query:{action:"getChairsList"},headers:{cookie}});
    expect(missing.json().clinicChanged).toBe(true);
    expect((await call("getChairsList",{}, {revision:999})).clinicChanged).toBe(true);
  });
  it("keeps embedded mini-app drafts in clinic storage and pins their fetches", async () => {
    const page=await w.app.inject({url:"/",headers:{cookie}});
    const pin=/window[.]KB_PIN_FETCH = function\(w\) \{([\s\S]*?)\}; window[.]KB_PIN_FETCH\(window\);/.exec(page.body);
    expect(!!pin).toBe(true);
    const map=new Map<string,string>([["draft","old draft"],["kb_clinic_other_draft","other clinic"]]);
    const store={get length(){return map.size;}, key:(i:number)=>[...map.keys()][i] ?? null,
      getItem:(k:string)=>map.get(k) ?? null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
    const parent:any={KB_CLINIC_CONTEXT:{id:clinic,revision}};
    let headers: Headers | undefined;
    const child:any={localStorage:store,sessionStorage:store,fetch:async (_input:unknown,init:any)=>{headers=init.headers;}};
    runInNewContext(`window.KB_PIN_FETCH = function(w) {${pin![1]}}; window.KB_PIN_FETCH(child);`,
      {window:parent,child,location:{origin:"http://localhost"},URL,Headers});
    expect(child.localStorage.getItem("draft")).toBeNull();
    child.localStorage.setItem("draft","current clinic");
    expect(map.get(`kb_clinic_${clinic}_draft`)).toBe("current clinic");
    await child.fetch("/exec");
    expect(headers!.get("X-KB-Clinic")).toBe(clinic);
    child.localStorage.clear();
    expect(map.get("draft")).toBe("old draft");
    expect(map.get("kb_clinic_other_draft")).toBe("other clinic");
  });
  it("protects organization details with the same Master password and explicit management grant", async () => {
    expect((await call("getOrganizationProfile")).locked).toBe(true);
    expect((await call("saveMasterPassword",{password:"example master secret"})).success).toBe(true);
    expect((await call("verifyMasterPassword",{password:"wrong"})).correct).toBe(false);
    expect((await call("getOrganizationProfile")).locked).toBe(true);
    expect((await call("verifyMasterPassword",{password:"example master secret"})).correct).toBe(true);
    expect((await call("getOrganizationProfile")).success).toBe(true);
    expect((await call("getOrganizationProfile",{}, {cookie:desk})).success).toBe(false);
  });
  it("persists organization details, checks versions and refuses provisioning fields", async () => {
    const saved = await call("saveOrganizationProfile",{profile:{displayName:"Example Dental Group",email:"demo@example.invalid"},version:0});
    expect(saved.success).toBe(true);
    expect((await call("saveOrganizationProfile",{profile:{displayName:"Stale"},version:0})).conflict).toBe(true);
    expect((await call("saveOrganizationProfile",{profile:{displayName:"Test",hostname:"other.localhost"},version:saved.version})).success).toBe(false);
    expect((await call("getOrganizationProfile")).profile.displayName).toBe("Example Dental Group");
  });
  it("switches the server's clinic, clears Master unlock, and rejects other-tab writes", async () => {
    await call("savePaymentModesList",{modes:["First clinic only"]});
    const switched = await call("switchWorkingClinic",{clinicId:w.clinicB});
    expect(switched.success).toBe(true); clinic=w.clinicB; revision=switched.revision;
    expect((await call("whoAmI")).clinicId).toBe(w.clinicB);
    expect((await call("getPaymentModesList")).modes).toEqual([]);
    expect((await call("savePaymentModesList",{modes:["stale write"]},{clinic:w.clinicA,revision:1})).clinicChanged).toBe(true);
    expect((await call("getOrganizationProfile")).locked).toBe(true);
    expect((await call("verifyMasterPassword",{password:"example master secret"})).correct).toBe(true);
    expect((await call("getOrganizationProfile")).profile.displayName).toBe("Example Dental Group");
    const next = await call("switchWorkingClinic",{clinicId:w.clinicA}); clinic=w.clinicA; revision=next.revision;
    expect((await call("getPaymentModesList")).modes).toEqual(["First clinic only"]);
  });
  it("does not allow the runtime database account to grant itself clinic access", async () => {
    await expect(sql`SELECT * FROM org_clinical_access`.execute(w.db)).rejects.toThrow();
  });
  it("shares one identity across clinics without copying registration history", async () => {
    const issued=await call("getNextUHID");
    expect((await call("saveRegistration",{uhid:issued.uhid,name:"Orbit Synthetic",mobile:"9000000061",dob:"14/03/1990",complaint:"Fictional private clinic A note",regStatus:"Quick"})).success).toBe(true);
    const first=(await call("searchOrganizationPatients",{query:"Orbit Synthetic"})).patients[0];
    expect(first.atCurrentClinic).toBe(true);
    const moved=await call("switchWorkingClinic",{clinicId:w.clinicB}); clinic=w.clinicB; revision=moved.revision;
    const found=(await call("searchOrganizationPatients",{query:"Orbit Synthetic"})).patients[0];
    expect(found.organization_patient_id).toBe(first.organization_patient_id);
    expect(found.atCurrentClinic).toBe(false);
    expect((await call("getPatient",{uhid:issued.uhid})).success).toBe(false);
    const attached=await call("attachOrganizationPatient",{organizationPatientId:found.organization_patient_id});
    expect(attached.success).toBe(true);
    expect((await call("getPatient",{uhid:attached.uhid})).patient).toMatchObject({name:"Orbit Synthetic",complaint:""});
    const again=await call("attachOrganizationPatient",{organizationPatientId:found.organization_patient_id});
    expect(again.id).toBe(attached.id);
    expect((await call("attachOrganizationPatient",{organizationPatientId:found.organization_patient_id},{method:"GET"})).success).toBe(false);
    expect((await call("attachOrganizationPatient",{organizationPatientId:"00000000-0000-4000-8000-000000000099"})).success).toBe(false);
    await call("saveRegistration",{uhid:attached.uhid,name:"Orbit Synthetic Updated",regStatus:"Quick"});
    const back=await call("switchWorkingClinic",{clinicId:w.clinicA}); clinic=w.clinicA; revision=back.revision;
    expect((await call("getPatient",{uhid:issued.uhid})).patient).toMatchObject({name:"Orbit Synthetic Updated",complaint:"Fictional private clinic A note"});
    expect((await call("searchOrganizationPatients",{query:"Orbit Synthetic Updated"})).patients).toHaveLength(1);
    const rest=await w.app.inject({url:"/api/v1/patients/",query:{q:"Orbit Synthetic Updated"},headers:{cookie,"x-kb-clinic":clinic,"x-kb-clinic-revision":String(revision)}});
    expect(rest.statusCode).toBe(200);
    expect(rest.json().patients[0].full_name).toBe("Orbit Synthetic Updated");
  });
  it("does not equate matching UHIDs or names and refuses unpermitted linking", async () => {
    const issued=await call("getNextUHID");
    await call("saveRegistration",{uhid:issued.uhid,name:"Same Synthetic",dob:"02/02/1980",mobile:"9000000062"});
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicB]);
      await c.query("INSERT INTO patients(uhid,full_name,mobile,date_of_birth) VALUES($1,'Same Synthetic','9000000062','1980-02-02')",[issued.uhid]);
    });
    const matches=(await call("searchOrganizationPatients",{query:"Same Synthetic"})).patients;
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((x:any)=>x.organization_patient_id)).size).toBe(2);
    expect(new Set(matches.map((x:any)=>x.organization_uhid)).size).toBe(2);
    const remote=matches.find((x:any)=>!x.atCurrentClinic);
    expect((await call("attachOrganizationPatient",{organizationPatientId:remote.organization_patient_id})).success).toBe(true);
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicA]);
      await c.query("UPDATE roles SET permissions=ARRAY['patients:read'] WHERE id=(SELECT role_id FROM app_users WHERE username='a-desk')");
    });
    expect((await call("searchOrganizationPatients",{query:"Same Synthetic"},{cookie:desk,revision:1})).success).toBe(true);
    expect((await call("attachOrganizationPatient",{organizationPatientId:remote.organization_patient_id},{cookie:desk,revision:1})).forbidden).toBe(true);
    await expect(sql`DELETE FROM org_clinical_patient_links`.execute(w.db)).rejects.toThrow();
  });
  it("serializes competing switches so only one page context can win", async () => {
    const results = await Promise.all([
      call("switchWorkingClinic",{clinicId:w.clinicB}),
      call("switchWorkingClinic",{clinicId:w.clinicB})
    ]);
    expect(results.filter(r=>r.success)).toHaveLength(1);
    expect(results.filter(r=>r.clinicChanged)).toHaveLength(1);
    const state=await call("getWorkingClinics"); clinic=state.clinic_id; revision=state.revision;
  });
  it("fails closed when a granted target account is disabled", async () => {
    const home=await call("switchWorkingClinic",{clinicId:w.clinicA}); clinic=w.clinicA; revision=home.revision;
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicB]);
      await c.query("UPDATE app_users SET active=false WHERE username='b-admin'");
    });
    expect((await call("switchWorkingClinic",{clinicId:w.clinicB})).success).toBe(false);
    expect((await call("whoAmI")).clinicId).toBe(w.clinicA);
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicB]);
      await c.query("UPDATE app_users SET active=true WHERE username='b-admin'");
    });
  });
  it("opens a central patient directly and pages only permitted clinic history", async () => {
    const home=await call("switchWorkingClinic",{clinicId:w.clinicA}); clinic=w.clinicA; revision=home.revision;
    const issued=await call("getNextUHID");
    await call("saveRegistration",{uhid:issued.uhid,name:"History Synthetic",mobile:"9000000081",complaint:"Synthetic medical history"});
    const identity=(await call("searchOrganizationPatients",{query:"History Synthetic"})).patients[0].organization_patient_id;
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicA]);
      const id=(await c.query("SELECT id FROM patients WHERE uhid=$1",[issued.uhid])).rows[0].id;
      await c.query("INSERT INTO daily_register(patient_id,uhid,visit_date,procedure_done,operating_doctor) SELECT $1,$2,'2026-01-01'::date+n,'Synthetic procedure A','Synthetic Dr West' FROM generate_series(1,31) n",[id,issued.uhid]);
      await c.query("INSERT INTO clinical_records(patient_id,uhid,tab_name,fields,recorded_at) VALUES($1,$2,'Demo form',$3::jsonb,'2026-06-01')",[id,issued.uhid,JSON.stringify({"Treating Doctor":"",Doctor:"Synthetic Dr West",Material:"Demo composite",LOT:"FAKE-LOT-1",Fee:999})]);
      await c.query("INSERT INTO clinical_sheets(patient_id,uhid,sheet_type) VALUES($1,$2,'Demo chart')",[id,issued.uhid]);
    });
    const next=await call("switchWorkingClinic",{clinicId:w.clinicB}); clinic=w.clinicB; revision=next.revision;
    expect((await call("getPatientHistory",{organizationPatientId:identity})).success).toBe(true);
    const opened=await call("openOrganizationPatient",{organizationPatientId:identity}); expect(opened.success).toBe(true);
    expect((await call("openOrganizationPatient",{organizationPatientId:identity})).id).toBe(opened.id);
    expect((await call("openOrganizationPatient",{organizationPatientId:identity},{method:"GET"})).success).toBe(false);
    expect((await call("searchOrganizationPatients",{query:"History Synthetic"})).patients).toHaveLength(1);
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicB]);
      await c.query("INSERT INTO daily_register(patient_id,uhid,visit_date,procedure_done,operating_doctor) VALUES($1,$2,'2026-07-01','Synthetic procedure B','Synthetic Dr East')",[opened.id,opened.uhid]);
    });
    const first=await call("getPatientHistory",{organizationPatientId:identity});
    expect(first.success).toBe(true); expect(first.events).toHaveLength(30); expect(first.nextCursor).toBeTruthy();
    const second=await call("getPatientHistory",{organizationPatientId:identity,cursor:first.nextCursor});
    const events=[...first.events,...second.events]; expect(events).toHaveLength(35);
    expect(new Set(events.map(e=>e.key)).size).toBe(35);
    expect(events.some(e=>e.doctor==="Synthetic Dr East"&&e.clinicId===w.clinicB)).toBe(true);
    const form=events.find(e=>e.kind==="form"); expect(form.doctor).toBe("Synthetic Dr West"); expect(form.details.Material).toBe("Demo composite"); expect(form.details.Fee).toBeUndefined();
    expect((await call("getPatientHistory",{organizationPatientId:identity,cursor:"bad"})).success).toBe(false);
    expect((await call("getPatientHistory",{organizationPatientId:identity},{cookie:desk,clinic:w.clinicA,revision:1})).forbidden).toBe(true);
    // Reading a central identity may create an internal reference, but grants
    // no permission to change identity or enter clinical/registration data.
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicB]);
      await c.query("INSERT INTO patients(uhid,full_name) VALUES(next_uhid(),'Readonly Central Example')");
    });
    const remote=(await call("searchOrganizationPatients",{query:"Readonly Central Example"},{cookie:desk,clinic:w.clinicA,revision:1})).patients[0];
    expect(remote.atCurrentClinic).toBe(false);
    const reference=await call("openOrganizationPatient",{organizationPatientId:remote.organization_patient_id},{cookie:desk,clinic:w.clinicA,revision:1});
    expect(reference.success).toBe(true);
    expect((await call("saveRegistration",{uhid:reference.uhid,name:"Unauthorized edit"},{cookie:desk,clinic:w.clinicA,revision:1})).forbidden).toBe(true);
    await owner(async c=>{
      await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicA]);
      await c.query("UPDATE roles SET permissions=array_remove(permissions,'clinical:read') WHERE id=(SELECT role_id FROM app_users WHERE username='a-admin')");
    });
    const restricted=await call("getPatientHistory",{organizationPatientId:identity});
    expect(restricted.clinics).toHaveLength(1); expect(restricted.events).toHaveLength(1);
    expect(restricted.events[0].clinicId).toBe(w.clinicB);
    expect((await call("getPatientHistory",{organizationPatientId:identity,clinicId:w.clinicA})).forbidden).toBe(true);
    expect((await call("whoAmI")).clinicId).toBe(w.clinicB);
    expect((await call("getPatientHistory",{organizationPatientId:"00000000-0000-4000-8000-000000000099"})).success).toBe(false);
  });
  it("logout revokes the original session even after a clinic switch", async () => {
    const report=await call("getOrganizationReports",{fromDate:"2026-01-01",toDate:"2026-12-31"});
    expect(report.success).toBe(true);expect(report.rows.length).toBeGreaterThan(0);
    expect((await call("getOrganizationReports",{clinicId:"00000000-0000-4000-8000-000000000099"})).forbidden).toBe(true);
    expect((await call("getOrganizationReports",{}, {cookie:desk,clinic:w.clinicA,revision:1})).forbidden).toBe(true);
    const next=await call("switchWorkingClinic",{clinicId:w.clinicB}); clinic=w.clinicB; revision=next.revision;
    expect((await call("staffLogout")).success).toBe(true);
    expect((await call("authStatus")).valid).toBe(false);
  });
});
