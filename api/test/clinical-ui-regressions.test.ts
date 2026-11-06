import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {it,expect} from "vitest";
const html=readFileSync(new URL("../../index.html",import.meta.url),"utf8");
function helper(name:string,next:string){return html.slice(html.indexOf(`function ${name}(`),html.indexOf(`function ${next}(`));}
it("uses clinic day across UTC midnight for diary, daysheet and register",()=>{
 const day=runInNewContext(helper("clinicISODate","treatmentProcedures")+`;clinicISODate(new Date('2026-11-02T22:00:00Z'))`,{window:{KB_CLINIC_TIMEZONE:"Asia/Kolkata"},Intl});expect(day).toBe("2026-11-03");
 for(const start of ["Appointments","Daysheet","DailyRegister"]){
  const pos=html.indexOf(`function ${start}(`);const code=html.slice(pos,pos+1800);expect(code.includes("const todayISO = clinicISODate()")).toBe(true);
 }
});
it("retains a saved procedure when its old department is missing from the current master",()=>{
 const list=runInNewContext(helper("treatmentProcedures","mkRow")+`;treatmentProcedures({}, {dept:'Historical department',procedure:'Historical procedure'})`);expect(Array.from(list)).toEqual(["Historical procedure"]);
 expect(helper("TreatmentPlan","Appointments").includes("DEPTS[row.dept].map")).toBe(false);
});
