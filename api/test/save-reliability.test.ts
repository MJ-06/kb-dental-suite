import {afterAll,beforeAll,expect,it} from 'vitest';
import {makeWorld,type World} from './setup.js';
import {execLogin} from './legacy.js';
let w:World,cookie:string,uhid:string;
const call=async(action:string,params:Record<string,unknown>={})=>(await w.app.inject({method:'POST',url:'/exec',headers:{cookie},payload:{action,...params}})).json();
beforeAll(async()=>{w=await makeWorld();cookie=await execLogin(w,'alpha','a-admin');uhid=(await call('getNextUHID')).uhid;await call('saveRegistration',{uhid,name:'Fictional Concurrent Patient',regStatus:'Quick'});});
afterAll(async()=>{await w.close();});
it('rejects a stale treatment plan instead of replacing another user’s saved plan',async()=>{
 const initial=await call('getTreatmentPlan',{uhid});expect(initial.version).toBe(0);
 const save=await call('saveTreatmentPlan',{uhid,version:0,rows:JSON.stringify([{procedure:'Fictional first plan'}]),estimate:'{}'});expect(save.success).toBe(true);
 const stale=await call('saveTreatmentPlan',{uhid,version:0,rows:'[]',estimate:'{}'});expect(stale).toMatchObject({success:false,conflict:true});
 expect((await call('getTreatmentPlan',{uhid})).rows[0].procedure).toBe('Fictional first plan');
});
it('protects a care plan on stale save and returns a new version',async()=>{
 const save=await call('saveCarePlan',{uhid,version:0,page1:{note:'fictional'},page2:{},page3:{},page4:{}});expect(save.version).toBeGreaterThan(0);
 expect(await call('saveCarePlan',{uhid,version:0,page1:{note:'stale'},page2:{},page3:{},page4:{}})).toMatchObject({success:false,conflict:true});
 expect((await call('getCarePlan',{uhid})).page1.note).toBe('fictional');
});
it('preserves different clinical templates sharing the same situation',async()=>{
 const templates=[{situation:'Consultation',text:'Fictional first note',category:'General'},{situation:'Consultation',text:'Fictional second note',category:'General'}];
 expect((await call('saveClinicalNoteTemplates',{templates})).success).toBe(true);
 expect((await call('getClinicalNoteTemplates')).templates).toEqual(templates);
 await call('saveClinicalNoteTemplates',{templates:[]});expect((await call('getClinicalNoteTemplates')).templates).toEqual([]);
});
it('refuses a write delivered through a GET URL',async()=>{
 const response=await w.app.inject({url:'/exec',headers:{cookie},query:{action:'saveTreatmentPlan',uhid,rows:'[]',estimate:'{}'}});
 expect(response.json().success).toBe(false);
});
it('classifies malformed JSON as a client error without logging a false server failure',async()=>{
 const response=await w.app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{cookie,'content-type':'application/json'},payload:''});
 expect(response.statusCode).toBe(400);
});
