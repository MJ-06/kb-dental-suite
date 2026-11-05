import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
it('renders staff and grouped role definitions in the clinical page without an iframe',()=>{
 const role={id:'role-1',name:'Clinic administrator',users:1,permissions:['roles:manage']};
 const staff={id:'staff-1',username:'fictional-admin',display_name:'Fictional Administrator',role_id:role.id,active:true};
 const states:any[]=[{roles:[role],staff:[staff],permissions:[{id:'roles:manage',group:'Administration',label:'Manage staff',about:'Change staff access'}],activity:[]},'','','',false,{username:'',display_name:'',role_id:'',password:''},'','',{[role.id]:{name:role.name,permissions:role.permissions}},{[staff.id]:{display_name:staff.display_name,role_id:role.id}}];
 let index=0;const context:any={window:{},React:{createElement:(type:any,props:any,...children:any[])=>({type,props,children}),useState:()=>[states[index++],()=>{}],useEffect:()=>{}},fetch:()=>{throw Error('Unexpected request while rendering');},confirm:()=>false};
 const ui=readFileSync(new URL('../../roles-access.js',import.meta.url),'utf8');runInNewContext(ui,context);const tree=context.window.KBRolesAccess();const text=JSON.stringify(tree);
 expect(tree.type).toBe('section');expect(text.includes('Role definitions')).toBe(true);expect(text.includes('Fictional Administrator')).toBe(true);expect(text.includes('Manage staff')).toBe(true);expect(text.includes('iframe')).toBe(false);expect(text.includes('Create role')).toBe(true);
});
