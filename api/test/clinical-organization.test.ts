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
  it("logout revokes the original session even after a clinic switch", async () => {
    const next=await call("switchWorkingClinic",{clinicId:w.clinicB}); clinic=w.clinicB; revision=next.revision;
    expect((await call("staffLogout")).success).toBe(true);
    expect((await call("authStatus")).valid).toBe(false);
  });
});
