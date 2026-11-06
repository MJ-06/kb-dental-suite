import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import pg from 'pg';
import {makeWorld,OWNER_URL,type World} from './setup.js';
import {execLogin} from './legacy.js';
import {DEFAULT_POLICY} from '../src/archive/policy.js';
let w:World,cookie:string,desk:string;
const org='00000000-0000-4000-8000-000000000001';
async function owner(fn:(c:pg.Client)=>Promise<void>){const c=new pg.Client({connectionString:OWNER_URL});await c.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.organization_id',$1,true)",[org]);await fn(c);await c.query('COMMIT');}finally{await c.end();}}
function headers(auth=cookie){return {cookie:auth,'x-kb-clinic':w.clinicA,'x-kb-clinic-revision':'1'};}
async function legacy(action:string,params:Record<string,unknown>={}){return (await w.app.inject({method:'POST',url:'/exec',headers:headers(),payload:{action,...params}})).json();}
beforeAll(async()=>{
 w=await makeWorld();
 await owner(async c=>{
  await c.query('INSERT INTO org_identity(id,code,name,hostname) VALUES($1,\'archive-test\',\'Fictional Organization\',\'test.localhost\')',[org]);
  for(const clinic of [w.clinicA,w.clinicB]){
   const unit=(await c.query('INSERT INTO org_units(code,name) VALUES($1,$1) RETURNING id',[clinic===w.clinicA?'first':'second'])).rows[0];
   await c.query('INSERT INTO org_clinical_units(organization_id,unit_id,clinic_id) VALUES($1,$2,$3)',[org,unit.id,clinic]);
  }
  await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicA]);
  const admin=(await c.query("SELECT id FROM app_users WHERE username='a-admin'")).rows[0].id;
  await c.query('INSERT INTO org_clinical_access VALUES($1,$2,$3,$2,$3,true)',[org,w.clinicA,admin]);
 });
 cookie=await execLogin(w,'alpha','a-admin');desk=await execLogin(w,'alpha','a-desk');
});
afterAll(async()=>{await w.close();});
describe('organization archive API',()=>{
 it('requires sign-in, organization management and the existing Master unlock',async()=>{
  expect((await w.app.inject({url:'/api/v1/archives/'})).statusCode).toBe(401);
  expect((await w.app.inject({url:'/api/v1/archives/',headers:headers(desk)})).statusCode).toBe(403);
  expect((await w.app.inject({url:'/api/v1/archives/',headers:headers()})).statusCode).toBe(403);
  expect((await legacy('verifyMasterPassword',{password:''})).correct).toBe(true);
  const r=await w.app.inject({url:'/api/v1/archives/',headers:headers()});
  expect(r.statusCode).toBe(200);expect(r.json().policy).toEqual(DEFAULT_POLICY);
 });
 it('saves policy with optimistic concurrency and rejects invalid fields',async()=>{
  const policy={...DEFAULT_POLICY,dailyAt:'22:15',dailyDays:14,monthlyMonths:6};
  const put=await w.app.inject({method:'PUT',url:'/api/v1/archives/policy',headers:headers(),payload:{policy,version:0}});
  expect(put.statusCode).toBe(200);
  expect((await w.app.inject({method:'PUT',url:'/api/v1/archives/policy',headers:headers(),payload:{policy,version:0}})).statusCode).toBe(409);
  expect((await w.app.inject({method:'PUT',url:'/api/v1/archives/policy',headers:headers(),payload:{policy:{...policy,dailyDays:0},version:put.json().version}})).statusCode).toBe(400);
  expect((await w.app.inject({url:'/api/v1/archives/',headers:headers()})).json().policy).toEqual(policy);
 });
 it('requires a live ready worker and refuses duplicate active jobs',async()=>{
  const request=()=>w.app.inject({method:'POST',url:'/api/v1/archives/runs',headers:headers(),payload:{}});
  expect((await request()).statusCode).toBe(503);
  await owner(async c=>{await c.query("INSERT INTO org_archive_worker(destination,ready) VALUES('Fictional personal drive',false)");});
  expect((await request()).statusCode).toBe(409);
  await owner(async c=>{await c.query('UPDATE org_archive_worker SET ready=true');});
  expect((await request()).statusCode).toBe(200);
  expect((await request()).statusCode).toBe(409);
  expect((await w.app.inject({url:'/api/v1/archives/',headers:headers()})).json().runs).toHaveLength(1);
 });
 it('does not expose archive files as static assets',async()=>{
  expect((await w.app.inject({url:'/archive-panel.js'})).statusCode).toBe(200);
  expect((await w.app.inject({url:'/archives/database.dump',headers:headers()})).statusCode).toBe(404);
 });
});
