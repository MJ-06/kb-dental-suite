import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=html.indexOf('function ClinicalSheets('),end=html.indexOf('\n// ═',start);
const tabs=html.slice(html.indexOf('const CS_TABS = ['),html.indexOf('];',html.indexOf('const CS_TABS = ['))+2);
it('previews the populated patient sheet without relying on popup windows or saving data',()=>{
 const patient={name:'Fictional Print Patient',uhid:'ZZ9901'},teeth=[{toothNo:'11',visits:[{doctor:'Fictional Doctor',material:'Fictional Material'}]}];
 const states:any[]=[patient.uhid,patient,false,'restoration','',{}, {restoration:teeth},{restoration:true},{}];let hook=0;
 const node=(type:any,props:any,...children:any[])=>({type,props,children});
 const context:any={React:{createElement:node,useEffect:()=>{},useState:(initial:any)=>{const i=hook++;if(!(i in states))states[i]=initial;return [states[i],(v:any)=>{states[i]=typeof v==='function'?v(states[i]):v;}];}},
  window:{open:()=>{throw Error('Popup unavailable');}},api:()=>{throw Error('Unexpected request');},T:'#0080a0',TL:'#eef',TM:'#ddf',BGS:'#fafafa',BORDER:'#ddd',
  ClinicHeader:()=>{},PatientBanner:()=>{},ToothCard:()=>{},PreviewModal:()=>{},
  sampleTeethFor:()=>teeth,buildRestorationHTML:(p:any,rows:any[])=>`<main>${p.uhid} ${rows[0].visits[0].doctor} ${rows[0].visits[0].material}</main>`};
 const render=runInNewContext(tabs+html.slice(start,end)+';ClinicalSheets',context);
 const flatten=(tree:any):any[]=>!tree||typeof tree!=='object'?[]:[tree,...(tree.children||[]).flat(Infinity).flatMap(flatten)];
 let tree=render({globalPat:patient,setGlobalPat:()=>{}});
 const print=flatten(tree).find(n=>n.type==='button'&&n.children.join('').includes('Print All'));
 expect(print).toBeDefined();expect(()=>print.props.onClick()).not.toThrow();
 hook=0;tree=render({globalPat:patient,setGlobalPat:()=>{}});
 const preview=flatten(tree).find(n=>n.type===context.PreviewModal);
 expect(preview?.props.html).toBe('<main>ZZ9901 Fictional Doctor Fictional Material</main>');
 preview.props.onClose();hook=0;expect(flatten(render({globalPat:patient,setGlobalPat:()=>{}})).some(n=>n.type===context.PreviewModal)).toBe(false);
 hook=0;tree=render({globalPat:patient,setGlobalPat:()=>{}});
 flatten(tree).find(n=>n.type==='button'&&n.children.join('')==='Print Sample').props.onClick();
 hook=0;tree=render({globalPat:patient,setGlobalPat:()=>{}});
 expect(flatten(tree).find(n=>n.type===context.PreviewModal).props.html).toBe('<main>SAMPLE Fictional Doctor Fictional Material</main>');
});
