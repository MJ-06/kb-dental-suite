import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const helpers=html.slice(html.indexOf('function monthKeyOf('),html.indexOf('function Bar('));
const computations=html.slice(html.indexOf('function computeReports('),html.indexOf('// Sits in front of the whole app'));
function compute(data:Record<string,unknown>,detail=false){
 const details=html.includes('function computeDetailedReports(')?html.slice(html.indexOf('function computeDetailedReports('),html.indexOf('function computeReports(')):'';
 return runInNewContext(helpers+details+computations+`;${detail?'computeDetailedReports':'computeReports'}(data,'2026-10-01','2026-10-31')`,{data});
}
function records(){return {patients:[{uhid:'TEST01',name:'Same Name',registeredOn:'2026-10-02'},{uhid:'TEST02',name:'Same Name',registeredOn:''}],register:[{date:'2026-10-03',uhid:'TEST01',patientName:'Same Name',operatingDoctor:'Doctor Actual',procedureDone:'Restoration'},{date:'2026-09-30',uhid:'TEST01',operatingDoctor:'Doctor Actual'}],receipts:[{date:'2026-10-03',uhid:'TEST01',fee:125,service:'Restoration'},{date:'2026-09-30',uhid:'TEST01',fee:900}],expenses:[{date:'2026-10-04',amount:25},{date:'2026-11-01',amount:500}],appts:[{date:'2026-10-03',uhid:'TEST01',doctor:'Doctor Planned',status:'Completed'},{date:'2026-10-05',uhid:'TEST02',patientName:'Same Name',doctor:'Doctor Planned',status:'No Show'}],treatments:[]};}
it('uses the same date-bounded source records for summary and detail tabs',()=>{
 const data=records(),summary=compute(data),detail=compute(data,true);
 expect(summary.revenue).toBe(125);expect(summary.expenseTotal).toBe(25);expect(summary.register).toHaveLength(1);
 expect(detail.patients.find((p:any)=>p.uhid==='TEST01')).toMatchObject({visits:1,collections:125,appointments:1});
 expect(data.register).toHaveLength(2);
});
it('keeps planned and recorded doctors distinct and never attributes patient payments as doctor revenue',()=>{
 const detail=compute(records(),true);
 expect(detail.doctors.find((p:any)=>p.name==='Doctor Actual')).toMatchObject({visits:1,patients:1,appointments:0});
 expect(detail.doctors.find((p:any)=>p.name==='Doctor Planned')).toMatchObject({visits:0,appointments:2});
 expect(detail.doctors.every((p:any)=>!('revenue' in p))).toBe(true);
 expect(detail.patients).toHaveLength(2);
});
it('does not classify a missing or later registration date as a returning patient',()=>{
 const data=records();data.patients[0]!.registeredOn='2026-11-02';
 data.register.push({date:'2026-10-05',uhid:'TEST02',operatingDoctor:'Doctor Actual'} as any);
 const summary=compute(data);expect(summary.byMonth[0].returning).toBe(0);
 expect(summary.byMonth[0].uncertainRegistration).toBe(2);
});
it('does not join anonymous history by name or split combined doctor attribution',()=>{
 const data=records();data.register.push({date:'2026-10-05',uhid:'',patientName:'Same Name',operatingDoctor:'Doctor A / Doctor B'} as any);
 data.receipts.push({date:'2026-10-05',uhid:'',fee:50} as any);
 const detail=compute(data,true);expect(detail.unlinkedRecords).toBe(2);expect(detail.patients).toHaveLength(2);
 expect(detail.doctors.find((p:any)=>p.name==='Doctor A / Doctor B')).toMatchObject({visits:1,patients:0});
});
it('marks the unimplemented Sales Tracker without offering a broken destination',()=>{
 const sales=html.slice(html.indexOf('    sales: () =>'),html.indexOf('    organizationProfile: () =>'));
 const tree=runInNewContext('({'+sales+'}).sales()', {React:{createElement:(type:unknown,props:unknown,...children:unknown[])=>({type,props,children})},BORDER:'#ddd',T:'#0080a0'});
 expect(JSON.stringify(tree)).toContain('Not implemented');
 expect(JSON.stringify(tree)).not.toContain('KB_Sales_Tracker.html');
});
