import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'kysely';
import {setTenant} from '../src/db/index.js';
import {makeWorld,type World} from './setup.js';
import {exec,execLogin} from './legacy.js';
let w:World,admin:string;
beforeAll(async()=>{w=await makeWorld();admin=await execLogin(w,'alpha','a-admin');});
afterAll(()=>w.close());
it('keeps imported opening financial estimates separate from clinical plan counts',async()=>{
 await w.db.transaction().execute(async tx=>{await setTenant(tx,w.clinicA);
  await sql`INSERT INTO treatment_plans(uhid,plan_rows,estimate) VALUES
   ('ZZ0101','[{"procedure":"Fictional restoration"}]'::jsonb,'{"total":200}'::jsonb),
   ('ZZ0102',NULL,'{"total":500,"source":"Finance sheet, Working for Balance"}'::jsonb)`.execute(tx);
 });
 const result=await exec(w,admin,'getClinicOverview');
 expect(result).toMatchObject({success:true,treatmentPlans:1,openingEstimates:1});
});
it('does not expose clinical plan or opening-finance counts to reception',async()=>{
 const reception=await execLogin(w,'alpha','a-desk');
 expect(await exec(w,reception,'getClinicOverview')).toMatchObject({success:true,treatmentPlans:null,openingEstimates:null});
});
