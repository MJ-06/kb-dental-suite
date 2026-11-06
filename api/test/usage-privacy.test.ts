import {expect,it} from 'vitest';import {usageConfig,usagePayload} from '../src/usage.js';
it('uses only allowlisted labels and pseudonymous staff/clinic keys',()=>{
 const config={url:'http://127.0.0.1:8091',website:'00000000-0000-4000-8000-000000000001',salt:'fictional-private-salt-which-is-long-enough'};
 const actor={organizationId:'fictional-org',principalId:'fictional-staff',userId:'fictional-staff',clinicId:'fictional-clinic'};
 const event=usagePayload(config,actor,'action','saveCarePlan',10,true,new Set(['saveCarePlan']));
 expect(event?.payload.data.action).toBe('saveCarePlan');expect(JSON.stringify(event)).not.toContain('fictional-staff');expect(JSON.stringify(event)).not.toContain('fictional-clinic');
 expect(usagePayload(config,actor,'screen','/patient/FICTIONAL',0,true,new Set())).toBeNull();
 expect(usagePayload(config,actor,'action','FictionalPatientName',0,true,new Set())).toBeNull();
});
it('refuses external analytics endpoints',()=>{
 const old=process.env.UMAMI_LOCAL_URL;process.env.UMAMI_LOCAL_URL='https://collector.invalid';expect(usageConfig()).toBeNull();if(old===undefined)delete process.env.UMAMI_LOCAL_URL;else process.env.UMAMI_LOCAL_URL=old;
});
