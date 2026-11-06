import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const start=html.indexOf('function Daysheet('),end=html.indexOf('const FOLDER_MENU_ITEMS',start);
function harness(){
 const states:any[]=[],refs:any[]=[],requests:{date:string;resolve:(r:any)=>void}[]=[];let state=0,ref=0,effect:any,deps='',cleanup:any;
 const node=(type:any,props:any,...children:any[])=>({type,props,children});
 const useState=(v:any)=>{const i=state++;if(!(i in states))states[i]=v;return [states[i],(next:any)=>states[i]=typeof next==='function'?next(states[i]):next];};
 const useRef=(v:any)=>refs[ref++]??(refs[ref-1]={current:v});
 const context:any={React:{createElement:node,useRef},useState,useEffect:(fn:any,d:any)=>{effect={fn,d};},useDoctors:()=>[],clinicISODate:()=> '2026-01-01',
  api:(_action:string,p:any)=>new Promise(resolve=>requests.push({date:p.date,resolve})),T:'#0080a0',BORDER:'#ddd',BGS:'#fafafa',inp:{},ClinicHeader:()=>{},Lbl:()=>{},DMYDate:()=>{},DailyRegister:()=>{},QuickApptModal:()=>{},APPT_NEXT_ACTION:{},APPT_UNDO_ACTION:{},reasonWithStep:()=>'',stampTime:()=>'',APPT_STATUS_COLOR:{}};
 const renderFn=runInNewContext(html.slice(start,end)+';Daysheet',context);
 const flatten=(n:any):any[]=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(flatten)];
 function render(){state=0;ref=0;const tree=renderFn({});if(JSON.stringify(effect.d)!==deps){cleanup?.();deps=JSON.stringify(effect.d);cleanup=effect.fn();}return flatten(tree);}
 const changeDate=(date:string)=>{render().find(n=>n.type===context.DMYDate).props.onChange(date);render();};
 return {states,requests,render,changeDate,unmount:()=>cleanup?.()};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
it('does not let an older day overwrite the latest chosen day',async()=>{
 const h=harness();h.render();h.changeDate('2026-01-02');
 h.requests[1]!.resolve({success:true,appointments:[{id:'new',status:'Scheduled'}]});await flush();
 h.requests[0]!.resolve({success:true,appointments:[{id:'old',status:'Scheduled'}]});await flush();
 expect(h.states[3].map((r:any)=>r.id)).toEqual(['new']);
});
it('keeps loading the newest day when an older request finishes first',async()=>{
 const h=harness();h.render();h.changeDate('2026-01-02');h.requests[0]!.resolve({success:true,appointments:[]});await flush();
 expect(h.states[4]).toBe(true);
 h.requests[1]!.resolve({success:false,error:'Fictional transport failure'});await flush();
 const text=JSON.stringify(h.render());expect(text).toContain('Fictional transport failure');expect(text).not.toContain('No appointments scheduled for this date.');
});
it('ignores responses after leaving the Daysheet',async()=>{
 const h=harness();h.render();h.unmount();h.requests[0]!.resolve({success:true,appointments:[{id:'old'}]});await flush();expect(h.states[3]).toEqual([]);
});
