import {expect,it} from 'vitest';
import {alignCrmStorageRows} from '../src/migration/crm-identity.js';
it('compares stable CRM entities after a collection save regenerates storage UUIDs',()=>{
 const original={id:'old-row',collection:'contacts',position:1,data:{id:'fictional-contact',name:'Fictional Contact'}};
 const current={...original,id:'new-row'};
 expect(alignCrmStorageRows([original],[current])).toEqual({rows:[original],additionalRows:0,regenerated:1});
 expect(current.id).toBe('new-row');
});
it('preserves review edits for fingerprint checking and refuses missing or ambiguous entities',()=>{
 const original={id:'old-row',collection:'leads',position:1,data:{id:'fictional-lead',stageId:'old-stage'}};
 const changed={...original,id:'new-row',data:{...original.data,stageId:'review-stage'}};
 expect(alignCrmStorageRows([original],[changed]).rows[0]!.data.stageId).toBe('review-stage');
 expect(()=>alignCrmStorageRows([original],[])).toThrow('Missing or ambiguous');
 expect(()=>alignCrmStorageRows([original],[changed,{...changed,id:'another-row'}])).toThrow('Missing or ambiguous');
});
it('does not merge pre-existing duplicate entity IDs and keeps additional review records separate',()=>{
 const a={id:'old-a',collection:'contacts',position:1,data:{id:'fictional-duplicate',name:'First record'}},b={id:'old-b',collection:'contacts',position:2,data:{id:'fictional-duplicate',name:'Second record'}};
 const extra={id:'extra',collection:'contacts',position:3,data:{id:'fictional-extra'}};
 expect(alignCrmStorageRows([a,b],[{...b,id:'new-b'},{...a,id:'new-a'},extra])).toEqual({rows:[a,b],additionalRows:1,regenerated:2});
});
