import {beforeAll,afterAll,it,expect} from "vitest";
import {makeWorld,type World} from "./setup.js";
import {exec,execLogin} from "./legacy.js";
let w:World,admin:string,desk:string;
beforeAll(async()=>{w=await makeWorld();admin=await execLogin(w,"alpha","a-admin");desk=await execLogin(w,"alpha","a-desk");});
afterAll(()=>w.close());
it("lists recent local patients, caps results and excludes another clinic",async()=>{
 for(let n=0;n<22;n++){const u=await exec(w,admin,"getNextUHID");expect((await exec(w,admin,"saveRegistration",{uhid:u.uhid,name:`Overview Fictional ${n}`})).success).toBe(true);}
 const r=await exec(w,admin,"getRecentPatients",{limit:"100"});
 expect(r.success).toBe(true);expect(r.patients).toHaveLength(20);
 expect(r.patients.every((p:any)=>p.name.startsWith("Overview Fictional"))).toBe(true);
 expect((await exec(w,admin,"getRecentPatients",{sort:"appointments"})).patients).toHaveLength(20);
});
it("returns actual clinic summary counts with permission-scoped sections",async()=>{
 const a=await exec(w,admin,"getClinicOverview");expect(a.success,a.error).toBe(true);expect(a.patients).toBeGreaterThanOrEqual(22);expect(a.carePlans).toBe(0);expect(a.treatmentPlans).toBe(0);
 const d=await exec(w,desk,"getClinicOverview");expect(d.success).toBe(true);expect(d.carePlans).toBeNull();expect(d.treatmentPlans).toBeNull();expect(d).not.toHaveProperty("collections");
});
it("administrator report access needs no secondary password while other staff retain permission checks",async()=>{
 await exec(w,admin,"saveReportsPassword",{slot:"1",password:"Fictional report secret"});
 expect((await exec(w,admin,"verifyReportsPassword",{password:""})).correct).toBe(true);
 expect((await exec(w,desk,"verifyReportsPassword",{password:""})).forbidden).toBe(true);
});
