import {beforeAll,afterAll,it,expect} from "vitest";
import {makeWorld,type World} from "./setup.js";
import {exec,execLogin} from "./legacy.js";
let w:World,admin:string,desk:string,uhid:string;
beforeAll(async()=>{w=await makeWorld();admin=await execLogin(w,"alpha","a-admin");desk=await execLogin(w,"alpha","a-desk");uhid=(await exec(w,admin,"getNextUHID")).uhid;await exec(w,admin,"saveRegistration",{uhid,name:"Fictional CGHS Example"});});
afterAll(()=>w.close());
it("allocates unique bill numbers atomically and saves the lines for the billed month",async()=>{
 const results=await Promise.all(Array.from({length:3},()=>exec(w,admin,"saveCghsBill",{uhid,patientName:"Fictional CGHS Example",billDate:"05/11/2026",panel:"Demo panel",address:'Fictional original address',amount:500,lines:[{procedure:"Demo restoration",amount:500}]})));
 expect(results.every(r=>r.success),JSON.stringify(results)).toBe(true);expect(new Set(results.map(r=>r.billNo)).size).toBe(3);expect(results[0].billNo).toMatch(/^202611[0-9]{4}$/);
 const bills=await exec(w,admin,"getCghsBills",{uhid});expect(bills.bills).toHaveLength(3);expect(bills.bills[0].lines[0].procedure).toBe("Demo restoration");
 await exec(w,admin,'saveRegistration',{uhid,address:'Fictional changed address'});
 expect((await exec(w,admin,'getCghsBills',{uhid})).bills[0].address).toBe('Fictional original address');
 const beta=await execLogin(w,"beta","b-admin");expect((await exec(w,beta,"getCghsBills")).bills).toHaveLength(0);
});
it("rejects foreign/unknown patients, invalid amounts and unauthorized bill saves",async()=>{
 expect((await exec(w,desk,"saveCghsBill",{uhid,amount:5})).forbidden).toBe(true);
 expect((await exec(w,admin,"saveCghsBill",{uhid:"UNKNOWN",amount:5})).success).toBe(false);
 expect((await exec(w,admin,"saveCghsBill",{uhid,amount:-5})).success).toBe(false);
});
