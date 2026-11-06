import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {expect,it} from 'vitest';
it('keeps the newest patient selection when opening responses arrive out of order',async()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),start=html.indexOf('  const selectPat = async (p) =>'),end=html.indexOf('  // Was its own copy',start);
 const requests:any[]=[],opened:any[]=[];const context:any={selectionVersion:{current:0},organizationDirectory:true,setOpening(){},setLoading(){},setError(){},setSelected(){},setGlobalPat:(p:any)=>opened.push(p.uhid),onNavigate(){},api:()=>new Promise(resolve=>requests.push(resolve))};
 const fn=runInNewContext('(function(){'+html.slice(start,end)+';return selectPat;})()',context);
 const first=fn({organization_patient_id:'fictional-one',uhid:'ZZ9901'}),second=fn({organization_patient_id:'fictional-two',uhid:'ZZ9902'});
 requests[1]({success:true,uhid:'ZZ9902'});await second;requests[0]({success:true,uhid:'ZZ9901'});await first;
 expect(opened).toEqual(['ZZ9902']);
});
