import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {expect,it} from 'vitest';
function load(){let confirm=true,alerts=0;const frames:any[]=[];const context:any={Map,document:{addEventListener(){},querySelectorAll:()=>frames},location:{origin:'http://clinic.local'},window:{KB_CLINIC_CONTEXT:{id:'fictional-clinic'},addEventListener(){},confirm:()=>confirm,alert:()=>{alerts++;}}};runInNewContext(readFileSync(new URL('../../save-safety.js',import.meta.url),'utf8'),context);return {api:context.window.KBSafeWrites,frames,setConfirm:(v:boolean)=>confirm=v,getAlerts:()=>alerts};}
it('coalesces identical in-flight saves and protects edits made while saving',async()=>{
 const h=load();let resolve:any,calls=0;
 await h.api.run('getTreatmentPlan',{uhid:'FICTIONAL'},async()=>({success:true,version:7}));
 const send=(p:any)=>{calls++;expect(p.version).toBe(7);return new Promise(r=>resolve=r);};
 h.api.markDirty();const first=h.api.run('saveTreatmentPlan',{uhid:'FICTIONAL'},send),second=h.api.run('saveTreatmentPlan',{uhid:'FICTIONAL'},send);
 expect(calls).toBe(1);expect(h.api.confirmLeave()).toBe(false);expect(h.getAlerts()).toBe(1);
 h.api.markDirty();resolve({success:true,version:8});await first;await second;
 h.setConfirm(false);expect(h.api.confirmLeave()).toBe(false);
});
it('rejects messages from unrelated windows and foreign iframe origins',()=>{
 const h=load(),source={};h.frames.push({contentWindow:source,hasAttribute:()=>false,getAttribute:()=> 'blob:http://clinic.local/fictional'});
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const fn=runInNewContext(html.slice(html.indexOf('function trustedClinicalMessage('),html.indexOf('function App()'))+';trustedClinicalMessage',{document:{querySelectorAll:()=>h.frames},location:{origin:'http://clinic.local'}});
 expect(fn({source:{},origin:'http://clinic.local'})).toBe(false);
 expect(fn({source,origin:'https://attacker.invalid'})).toBe(false);
 expect(fn({source,origin:'http://clinic.local'})).toBe(true);
});
