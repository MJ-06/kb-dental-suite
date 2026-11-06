import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
it('does not retry a UHID reservation after an ambiguous native connection failure',async()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const start=html.indexOf('async function apiDirect('),end=html.indexOf('\nfunction ',start);
 let calls=0;
 const context={URLSearchParams,KB_BACKEND_IS_APPS_SCRIPT:false,SCRIPT_URL:'http://fictional.local/exec',getSessionToken:()=>'',setTimeout:(fn:()=>void)=>fn(),fetch:async()=>{calls++;throw Error('Fictional dropped connection');},console:{error(){},warn(){}}};
 const api=runInNewContext(html.slice(start,end)+';apiDirect',context);
 await api('getNextUHID');expect(calls).toBe(1);
});
