// Optional operator-level rehearsal against fictional kb_pms_test data only.
// No existing real-data database is dumped or restored by this test.
import {existsSync,readFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {describe,expect,it} from 'vitest';
import {makeWorld,OWNER_URL} from './setup.js';
import {archiveTick} from '../src/archive/worker.js';
import {archiveCommand,verifyBundle} from '../src/archive/bundle.js';
import {DEFAULT_POLICY} from '../src/archive/policy.js';
const passFile=join(homedir(),'.kb-pms','postgres-superuser.txt');
const pgBin=process.env.PG_BIN??'C:/Program Files/PostgreSQL/18/bin';
const available=existsSync(passFile)&&existsSync(join(pgBin,'pg_dump.exe'));
describe.skipIf(!available)('actual synthetic archive and restore rehearsal',()=>{
 it('restores the organization database and both clinics with checked documents',async()=>{
  const source=new URL(OWNER_URL);if(source.pathname!=='/kb_pms_test')throw Error('Only the disposable test database is allowed');
  source.username='postgres';source.password=readFileSync(passFile,'utf8').trim();
  const targetName='kb_archive_roundtrip_'+randomBytes(6).toString('hex');
  const backupRole='kb_archive_test_'+randomBytes(6).toString('hex'),backupPassword=randomBytes(24).toString('base64url');
  const target=new URL(source);target.pathname='/'+targetName;
  const w=await makeWorld(),temp=await mkdtemp(join(tmpdir(),'kb-archive-roundtrip-'));
  const c=new pg.Client({connectionString:source.href});await c.connect();let targetCreated=false,roleCreated=false;
  try{
   const org=randomUUID(),root=join(temp,'staging'),docs=join(temp,'documents'),personal=join(temp,'personal');
   await c.query('INSERT INTO org_identity(id,code,name,hostname) VALUES($1,\'fictional-archive\',\'Fictional Archive Clinic\',\'test.localhost\')',[org]);
   await c.query("SELECT set_config('app.organization_id',$1,false)",[org]);
   const keys:string[]=[];
   for(const [i,clinic] of [w.clinicA,w.clinicB].entries()){
    const unit=(await c.query('INSERT INTO org_units(code,name) VALUES($1,$1) RETURNING id',['unit'+i])).rows[0].id;
    await c.query('INSERT INTO org_clinical_units(organization_id,unit_id,clinic_id) VALUES($1,$2,$3)',[org,unit,clinic]);
    await c.query("SELECT set_config('app.clinic_id',$1,false)",[clinic]);
    const uhid='FICTIONAL-'+i,key=clinic+'/'+randomUUID(),bytes=Buffer.from('fictional document '+i);keys.push(key);
    const patient=(await c.query('INSERT INTO patients(uhid,full_name) VALUES($1,$2) RETURNING id',[uhid,'Fictional Patient '+i])).rows[0].id;
    await mkdir(join(docs,clinic),{recursive:true});await writeFile(join(docs,...key.split('/')),bytes);
    await c.query("INSERT INTO patient_documents(uhid,patient_id,file_name,mime_type,storage_key,size_bytes,checksum_sha256) VALUES($1,$2,'fictional.txt','text/plain',$3,$4,$5)",[uhid,patient,key,bytes.length,createHash('sha256').update(bytes).digest('hex')]);
   }
   await c.query("INSERT INTO org_settings(key,value) VALUES('archive_policy',$1::jsonb)",[JSON.stringify({...DEFAULT_POLICY,destination:'folder',folderPath:personal})]);
   await c.query("INSERT INTO org_archive_runs(kind,archive_day) VALUES('manual','2026-11-06')");
   await c.query(`CREATE ROLE ${backupRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '${backupPassword}'`);roleCreated=true;
   await c.query(`GRANT CONNECT ON DATABASE kb_pms_test TO ${backupRole}; GRANT USAGE ON SCHEMA public TO ${backupRole}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backupRole}; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${backupRole}; GRANT INSERT,UPDATE ON org_archive_runs,org_archive_worker TO ${backupRole}; GRANT INSERT ON org_audit TO ${backupRole}`);
   const backupUrl=new URL(source);backupUrl.username=backupRole;backupUrl.password=backupPassword;
   await archiveTick({databaseUrl:backupUrl.href,root,documentRoot:docs,pgDump:join(pgBin,'pg_dump.exe'),pgRestore:join(pgBin,'pg_restore.exe'),tar:'C:/Windows/System32/tar.exe'},new Date('2026-11-06T18:30:00Z'));
   const run=(await c.query('SELECT id,status,file_count,error_code,destination_ref FROM org_archive_runs')).rows[0];
   expect(run.error_code).toBeNull();expect(run.status).toBe('succeeded');expect(run.file_count).toBe(2);
   await verifyBundle(run.destination_ref,run.id,org);
   await c.query('CREATE DATABASE '+targetName);targetCreated=true;
   await archiveCommand(join(pgBin,'pg_restore.exe'),['--exit-on-error','--single-transaction','--no-owner','--no-privileges','--dbname='+targetName,join(root,run.id,'database.dump')],target.href);
   const restored=new pg.Client({connectionString:target.href});await restored.connect();
   try{
    expect(Number((await restored.query('SELECT count(*) n FROM patients')).rows[0].n)).toBe(2);
    expect(Number((await restored.query('SELECT count(DISTINCT clinic_id) n FROM patients')).rows[0].n)).toBe(2);
    expect(Number((await restored.query('SELECT count(*) n FROM patient_documents')).rows[0].n)).toBe(2);
    expect(Number((await restored.query('SELECT count(*) n FROM org_identity')).rows[0].n)).toBe(1);
    for(const [i,key] of keys.entries())expect(await readFile(join(run.destination_ref,run.id,'files','clinical',...key.split('/')),'utf8')).toBe('fictional document '+i);
   }finally{await restored.end();}
  }finally{
   if(targetCreated){if(!/^kb_archive_roundtrip_[a-f0-9]{12}$/.test(targetName))throw Error('Unsafe cleanup target');await c.query('DROP DATABASE '+targetName);}
   if(roleCreated){if(!/^kb_archive_test_[a-f0-9]{12}$/.test(backupRole))throw Error('Unsafe cleanup role');await c.query('DROP OWNED BY '+backupRole);await c.query('DROP ROLE '+backupRole);}
   await c.end();await w.close();const folder=resolve(temp);if(!folder.startsWith(resolve(tmpdir())+sep+'kb-archive-roundtrip-'))throw Error('Unsafe cleanup folder');await rm(folder,{recursive:true,force:true});
  }
 },60000);
});
