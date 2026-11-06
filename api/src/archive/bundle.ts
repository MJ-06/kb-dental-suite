// Operator-only filesystem/pg_dump code. Never imported by an HTTP download route.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {lstat,mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type pg from 'pg';
import {assertKey} from '../storage/types.js';

export class ArchiveError extends Error {constructor(public code:string){super(code);}}
export const archiveId=(id:string)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new ArchiveError('INVALID_ARCHIVE_ID');return id;};
export interface BundleOptions {root:string;documentRoot:string;organizationDocumentRoot?:string;databaseUrl:string;pgDump:string;pgRestore:string;organizationId:string}
export interface BundleManifest {format:1;id:string;organizationId:string;createdAt:string;dump:{sha256:string;bytes:number};files:{path:string;sha256:string;bytes:number}[]}
function inside(root:string,path:string){const r=relative(root,path);return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);}
async function noLinks(path:string){
 let at=resolve(path);
 for(;;){if((await lstat(at)).isSymbolicLink())throw new ArchiveError('SYMLINK_NOT_ALLOWED');const parent=dirname(at);if(parent===at)break;at=parent;}
}
export async function prepareRoot(root:string,organizationId:string){
 if(!isAbsolute(root))throw new ArchiveError('ARCHIVE_ROOT_MUST_BE_ABSOLUTE');
 await mkdir(root,{recursive:true,mode:0o700});await noLinks(root);
 const actual=await realpath(root),marker=join(actual,'.kb-archive-root.json');
 try{await writeFile(marker,JSON.stringify({format:1,organizationId}),{flag:'wx',mode:0o600});}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 await noLinks(marker);
 const saved=JSON.parse(await readFile(marker,'utf8'));
 if(saved.format!==1||saved.organizationId!==organizationId)throw new ArchiveError('ARCHIVE_ROOT_ORGANIZATION_MISMATCH');
 return actual;
}
export async function fileDigest(file:string){
 const h=createHash('sha256');let bytes=0;
 for await(const b of createReadStream(file)){h.update(b);bytes+=b.length;}
 return {sha256:h.digest('hex'),bytes};
}
export async function archiveCommand(program:string,args:string[],databaseUrl?:string){
 const env={...process.env};
 if(databaseUrl){const u=new URL(databaseUrl);Object.assign(env,{PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGSSLMODE:u.searchParams.get('sslmode')??'prefer'});}
 // No shell, password argument, or child stderr (which might contain row values).
 await new Promise<void>((done,fail)=>{
  const child=spawn(program,args,{env,stdio:'ignore',windowsHide:true});
  const timeout=setTimeout(()=>{child.kill();fail(new ArchiveError('ARCHIVE_TOOL_TIMEOUT'));},60*60*1000);
  child.once('error',()=>{clearTimeout(timeout);fail(new ArchiveError('ARCHIVE_TOOL_UNAVAILABLE'));});
  child.once('exit',code=>{clearTimeout(timeout);code===0?done():fail(new ArchiveError('ARCHIVE_TOOL_FAILED'));});
 });
}
async function copyFileChecked(sourceRoot:string,key:string,destination:string,expected:string|null,size:number){
 const root=await realpath(sourceRoot),source=resolve(root,...key.split('/'));
 if(!inside(root,source))throw new ArchiveError('INVALID_DOCUMENT_PATH');
 await noLinks(source);
 if(!inside(root,await realpath(source)))throw new ArchiveError('INVALID_DOCUMENT_PATH');
 if(!(await lstat(source)).isFile())throw new ArchiveError('DOCUMENT_NOT_FILE');
 await mkdir(dirname(destination),{recursive:true,mode:0o700});
 const hash=createHash('sha256');let bytes=0;
 await pipeline(createReadStream(source),new Transform({transform(chunk,_encoding,cb){hash.update(chunk);bytes+=chunk.length;cb(null,chunk);}}),createWriteStream(destination,{flags:'wx',mode:0o600}));
 const digest=hash.digest('hex');
 if(bytes!==size||(expected&&digest!==expected))throw new ArchiveError('DOCUMENT_CHECKSUM_MISMATCH');
 return {sha256:digest,bytes};
}
export async function createBundle(c:pg.Client,id:string,options:BundleOptions):Promise<BundleManifest>{
 archiveId(id);const root=await prepareRoot(options.root,options.organizationId),temp=join(root,id+'.partial');
 await mkdir(temp,{mode:0o700});
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const snapshot=(await c.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot;
  const files=(await c.query('SELECT storage_key,storage_backend,checksum_sha256,size_bytes FROM patient_documents')).rows;
  const organizationFiles=(await c.query('SELECT storage_key,sha256,bytes FROM org_documents')).rows;
  if(files.some(f=>f.storage_backend!=='local'))throw new ArchiveError('REMOTE_DOCUMENT_BACKUP_NOT_CONFIGURED');
  if(organizationFiles.length&&!options.organizationDocumentRoot)throw new ArchiveError('ORGANIZATION_DOCUMENT_ROOT_REQUIRED');
  await archiveCommand(options.pgDump,['--format=custom','--no-owner','--no-privileges','--snapshot='+snapshot,'--file='+join(temp,'database.dump')],options.databaseUrl);
  const manifest:BundleManifest={format:1,id,organizationId:options.organizationId,createdAt:new Date().toISOString(),dump:await fileDigest(join(temp,'database.dump')),files:[]};
  for(const f of files){assertKey(f.storage_key);const path='files/clinical/'+f.storage_key;manifest.files.push({path,...await copyFileChecked(options.documentRoot,f.storage_key,join(temp,...path.split('/')),f.checksum_sha256,Number(f.size_bytes))});}
  for(const f of organizationFiles){if(!/^[a-f0-9]{48}$/.test(f.storage_key))throw new ArchiveError('INVALID_DOCUMENT_PATH');const path='files/organization/'+f.storage_key;manifest.files.push({path,...await copyFileChecked(options.organizationDocumentRoot!,f.storage_key,join(temp,...path.split('/')),f.sha256,Number(f.bytes))});}
  await archiveCommand(options.pgRestore,['--list',join(temp,'database.dump')]);
  await writeFile(join(temp,'complete.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  await c.query('COMMIT');
  await rename(temp,join(root,id));
  return manifest;
 }catch(e){await c.query('ROLLBACK');throw e;}
}
export async function verifyBundle(root:string,id:string,organizationId:string){
 archiveId(id);const actual=await prepareRoot(root,organizationId),folder=join(actual,id);
 await noLinks(folder);await noLinks(join(folder,'complete.json'));
 const manifest:BundleManifest=JSON.parse(await readFile(join(folder,'complete.json'),'utf8'));
 if(manifest.format!==1||manifest.id!==id||manifest.organizationId!==organizationId||!Array.isArray(manifest.files))throw new ArchiveError('INVALID_ARCHIVE_MANIFEST');
 const paths=new Set<string>();
 for(const f of [{path:'database.dump',...manifest.dump},...manifest.files]){
  const file=resolve(folder,...f.path.split('/'));
  if(paths.has(f.path)||!inside(folder,file))throw new ArchiveError('INVALID_ARCHIVE_PATH');
  paths.add(f.path);await noLinks(file);
  const actual=await fileDigest(file);
  if(actual.sha256!==f.sha256||actual.bytes!==f.bytes)throw new ArchiveError('ARCHIVE_CHECKSUM_MISMATCH');
 }
 return manifest;
}
/** Only a complete, verified, organization-matching bundle below a marked root
 * can be removed. Live documents, partial runs and arbitrary folders are refused. */
export async function expireBundle(root:string,id:string,organizationId:string){
 await verifyBundle(root,id,organizationId);
 const actual=await realpath(root),target=await realpath(join(actual,archiveId(id)));
 if(!inside(actual,target)||dirname(target)!==actual)throw new ArchiveError('INVALID_ARCHIVE_PATH');
 await rm(target,{recursive:true});
}
