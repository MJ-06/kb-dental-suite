import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {cp,realpath,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DriveClient,FOLDER_MIME} from '../drive/client.js';
import {ArchiveError,archiveCommand,archiveId,expireBundle,prepareRoot,verifyBundle} from './bundle.js';
import type {ArchivePolicy} from './policy.js';
export type ArchiveDrive=Pick<DriveClient,'metadata'|'uploadFile'|'trash'>;
export interface DestinationOptions {root:string;organizationId:string;tar:string;drive?:ArchiveDrive}
export interface PublishedArchive {kind:'drive'|'folder';ref:string;parent:string;checksum:string|null}
const repo=fileURLToPath(new URL('../../../',import.meta.url));
function folderRoot(path:string,organizationId:string){
 const absolute=resolve(path),r=relative(repo,absolute);
 if(!isAbsolute(path)||r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r)))throw new ArchiveError('PRIVATE_DESTINATION_FOLDER_REQUIRED');
 return join(absolute,'KB Dental Archives',organizationId);
}
export async function checkDestination(policy:ArchivePolicy,options:DestinationOptions){
 if(policy.destination==='folder'){
  if(!policy.folderPath)throw new ArchiveError('DESTINATION_NOT_CONFIGURED');
  return {label:await prepareRoot(folderRoot(policy.folderPath,options.organizationId),options.organizationId)};
 }
 if(!policy.driveFolderId||!options.drive)throw new ArchiveError('GOOGLE_DRIVE_CONNECTION_REQUIRED');
 const folder=await options.drive.metadata(policy.driveFolderId);
 if(folder.trashed||folder.mimeType!==FOLDER_MIME||folder.capabilities?.canAddChildren!==true)throw new ArchiveError('GOOGLE_DRIVE_FOLDER_NOT_WRITABLE');
 return {label:'Google Drive folder '+policy.driveFolderId};
}
export async function publishArchive(id:string,policy:ArchivePolicy,options:DestinationOptions):Promise<PublishedArchive>{
 archiveId(id);await verifyBundle(options.root,id,options.organizationId);
 const destination=await checkDestination(policy,options);
 if(policy.destination==='folder'){
  const root=destination.label,source=await realpath(join(options.root,id));
  if(await realpath(options.root)!==root){
   const temp=join(root,id+'.uploading');
   await cp(source,temp,{recursive:true,force:false,errorOnExist:true,dereference:false});
   await rename(temp,join(root,id));
  }
  await verifyBundle(root,id,options.organizationId);
  return {kind:'folder',ref:root,parent:root,checksum:null};
 }
 const compressed=join(options.root,id+'.tar.gz');
 await archiveCommand(options.tar,['-czf',compressed,'-C',options.root,id]);
 const md5=createHash('md5');let size=0;
 for await(const b of createReadStream(compressed)){md5.update(b);size+=b.length;}
 const checksum=md5.digest('hex');
 const ref=await options.drive!.uploadFile({name:'kb-archive-'+id+'.tar.gz',parentId:policy.driveFolderId,file:compressed,appProperties:{kbArchiveFormat:'1',kbArchiveOrganization:options.organizationId,kbArchiveId:id}});
 const remote=await options.drive!.metadata(ref);
 if(remote.md5Checksum!==checksum||Number(remote.size)!==size||remote.appProperties?.kbArchiveId!==id||remote.appProperties?.kbArchiveOrganization!==options.organizationId||!remote.parents?.includes(policy.driveFolderId)||remote.trashed)throw new ArchiveError('GOOGLE_DRIVE_VERIFY_FAILED');
 await unlink(compressed);
 return {kind:'drive',ref,parent:policy.driveFolderId,checksum};
}
export async function expirePublished(id:string,published:PublishedArchive,options:DestinationOptions){
 archiveId(id);
 if(published.kind==='folder'){await expireBundle(published.ref,id,options.organizationId);return;}
 if(!options.drive)throw new ArchiveError('GOOGLE_DRIVE_CONNECTION_REQUIRED');
 const file=await options.drive.metadata(published.ref);
 if(file.appProperties?.kbArchiveId!==id||file.appProperties?.kbArchiveOrganization!==options.organizationId||file.appProperties?.kbArchiveFormat!=='1'||file.md5Checksum!==published.checksum||!file.parents?.includes(published.parent))throw new ArchiveError('GOOGLE_DRIVE_ARCHIVE_CHANGED');
 if(!file.trashed)await options.drive.trash(published.ref);
}
