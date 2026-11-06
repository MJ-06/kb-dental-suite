import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {DriveClient} from '../src/drive/client.js';
let base:string,temp:string,received=Buffer.alloc(0),properties:unknown,trashed=false;
const server=createServer(async(req,res)=>{
 const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const bytes=Buffer.concat(chunks);
 res.setHeader('content-type','application/json');
 if(req.url==='/token'){res.end(JSON.stringify({access_token:'fictional-token',expires_in:3600}));return;}
 if(req.url?.startsWith('/upload/drive/v3/files')){const meta=JSON.parse(bytes.toString());properties=meta.appProperties;res.setHeader('location',base+'/session');res.end('{}');return;}
 if(req.url==='/session'){received=bytes;res.end(JSON.stringify({id:'fictional-file'}));return;}
 if(req.method==='PATCH'){trashed=JSON.parse(bytes.toString()).trashed;res.end('{}');return;}
 res.end(JSON.stringify({id:'fictional-file',md5Checksum:createHash('md5').update(received).digest('hex'),size:String(received.length),appProperties:properties,parents:['fictional-folder'],trashed}));
});
const previous={api:process.env.DRIVE_API_BASE,token:process.env.DRIVE_TOKEN_URL};
beforeAll(async()=>{temp=await mkdtemp(join(tmpdir(),'kb-archive-drive-'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+(server.address() as {port:number}).port;process.env.DRIVE_API_BASE=base;process.env.DRIVE_TOKEN_URL=base+'/token';});
afterAll(async()=>{if(previous.api)process.env.DRIVE_API_BASE=previous.api;else delete process.env.DRIVE_API_BASE;if(previous.token)process.env.DRIVE_TOKEN_URL=previous.token;else delete process.env.DRIVE_TOKEN_URL;await new Promise<void>(r=>server.close(()=>r()));const target=resolve(temp);if(!target.startsWith(resolve(tmpdir())+sep+'kb-archive-drive-'))throw Error('Unsafe cleanup target');await rm(target,{recursive:true,force:true});});
it('streams a marked archive to a resumable Drive session and reads its checksum',async()=>{
 const file=join(temp,'fictional.tar.gz'),bytes=Buffer.alloc(6*1024*1024,17);await writeFile(file,bytes);
 const client=new DriveClient({type:'oauth',client_id:'fictional-client',client_secret:'fictional-secret',refresh_token:'fictional-refresh'});
 const id=await client.uploadFile({name:'fictional.tar.gz',parentId:'fictional-folder',file,appProperties:{kbArchiveId:'fictional-run'}});
 expect(id).toBe('fictional-file');expect(received.equals(bytes)).toBe(true);
 const metadata=await client.metadata(id);expect(metadata.md5Checksum).toBe(createHash('md5').update(bytes).digest('hex'));expect(metadata.appProperties).toEqual({kbArchiveId:'fictional-run'});
 await client.trash(id);expect(trashed).toBe(true);
});
