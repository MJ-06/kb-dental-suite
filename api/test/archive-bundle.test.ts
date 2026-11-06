import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {expireBundle,fileDigest,prepareRoot,verifyBundle} from '../src/archive/bundle.js';
import {checkDestination,expirePublished,publishArchive,type ArchiveDrive} from '../src/archive/destination.js';
import {DEFAULT_POLICY} from '../src/archive/policy.js';
let temp:string;
const org='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
beforeAll(async()=>{temp=await mkdtemp(join(tmpdir(),'kb-archive-test-'));});
afterAll(async()=>{const target=resolve(temp);if(!target.startsWith(resolve(tmpdir())+sep+'kb-archive-test-'))throw Error('Unsafe cleanup target');await rm(target,{recursive:true,force:true});});
async function fixture(root:string){
 await prepareRoot(root,org);await mkdir(join(root,id));
 await writeFile(join(root,id,'database.dump'),'fictional test dump');
 await writeFile(join(root,id,'complete.json'),JSON.stringify({format:1,id,organizationId:org,createdAt:new Date().toISOString(),dump:await fileDigest(join(root,id,'database.dump')),files:[]}));
}
describe('private archive bundle boundaries',()=>{
 it('detects corruption and refuses to delete a damaged archive',async()=>{
  const root=join(temp,'damaged');await fixture(root);
  expect((await verifyBundle(root,id,org)).id).toBe(id);
  await writeFile(join(root,id,'database.dump'),'corrupted');
  await expect(expireBundle(root,id,org)).rejects.toThrow('ARCHIVE_CHECKSUM_MISMATCH');
  expect(await readFile(join(root,id,'database.dump'),'utf8')).toBe('corrupted');
 });
 it('refuses cross-organization roots and path traversal',async()=>{
  const root=join(temp,'boundary');await fixture(root);
  await expect(verifyBundle(root,'../documents',org)).rejects.toThrow('INVALID_ARCHIVE_ID');
  await expect(verifyBundle(root,id,'other-organization')).rejects.toThrow('ARCHIVE_ROOT_ORGANIZATION_MISMATCH');
  await expireBundle(root,id,org);
  await expect(readFile(join(root,id,'complete.json'))).rejects.toThrow();
 });
 it('copies a verified bundle to a personal folder and expires only its own copy',async()=>{
  const root=join(temp,'staging'),personal=join(temp,'personal');await fixture(root);
  const policy={...DEFAULT_POLICY,destination:'folder' as const,folderPath:personal};
  const options={root,organizationId:org,tar:'unused'};
  const saved=await publishArchive(id,policy,options);
  expect(saved.kind).toBe('folder');expect((await verifyBundle(saved.ref,id,org)).id).toBe(id);
  await writeFile(join(personal,'unrelated.txt'),'keep');
  await expirePublished(id,saved,options);
  expect(await readFile(join(personal,'unrelated.txt'),'utf8')).toBe('keep');
  expect((await verifyBundle(root,id,org)).id).toBe(id);
 });
 it('does not publish before a Google Drive destination is connected',async()=>{
  await expect(checkDestination(DEFAULT_POLICY,{root:temp,organizationId:org,tar:'unused'})).rejects.toThrow('GOOGLE_DRIVE_CONNECTION_REQUIRED');
 });
 it('trashes only unchanged app-marked Drive archives in their recorded folder',async()=>{
  let trashed=0;
  const metadata={id:'file',md5Checksum:'expected',parents:['folder'],appProperties:{kbArchiveId:id,kbArchiveOrganization:org,kbArchiveFormat:'1'}};
  const drive:ArchiveDrive={metadata:async()=>metadata,uploadFile:async()=>'',trash:async()=>{trashed++;}};
  const published={kind:'drive' as const,ref:'file',parent:'folder',checksum:'expected'};
  await expirePublished(id,published,{root:temp,organizationId:org,tar:'unused',drive});
  expect(trashed).toBe(1);metadata.md5Checksum='changed';
  await expect(expirePublished(id,published,{root:temp,organizationId:org,tar:'unused',drive})).rejects.toThrow('GOOGLE_DRIVE_ARCHIVE_CHANGED');
  expect(trashed).toBe(1);
 });
});
