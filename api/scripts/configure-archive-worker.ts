// Local operator setup. No HTTP handler ever reads the backup credentials.
// --review uses only the marked dedicated review; otherwise use the normal env.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../src/migrator.js';
import {prepareRoot} from '../src/archive/bundle.js';
import {DEFAULT_POLICY} from '../src/archive/policy.js';
const review=process.argv.includes('--review');
const root=fileURLToPath(new URL('../.organization-demo-runtime/realdata-review/',import.meta.url));
const envFile=review?join(root,'app.env'):process.env.KB_APP_ENV_FILE??fileURLToPath(new URL('../.env',import.meta.url));
const config=parseEnv(readFileSync(envFile,'utf8'));
const privateFolder=review?root:join(homedir(),'.kb-pms');
const workerFile=join(privateFolder,'archive-worker.env'),stateFile=join(privateFolder,'archive-worker-state.json');
const previousWorker=existsSync(workerFile)?parseEnv(readFileSync(workerFile,'utf8')):{};
const appUrl=new URL(config.DATABASE_URL!);
let ownerUrl:string,marker:string|undefined;
if(review){const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));const u=new URL(appUrl);u.username=state.owner;u.password=state.ownerPassword;ownerUrl=u.href;marker=state.marker;}
else{const owner=parseEnv(readFileSync(process.env.KB_OWNER_ENV??join(homedir(),'.kb-pms','owner.env'),'utf8'));ownerUrl=owner.OWNER_DATABASE_URL!;if(new URL(ownerUrl).pathname!==appUrl.pathname)throw Error('Owner/app databases differ');}
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"',literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const database=decodeURIComponent(appUrl.pathname.slice(1));
const admin=new pg.Client({host:appUrl.hostname,port:Number(appUrl.port||5432),database,user:'postgres',password:readFileSync(join(homedir(),'.kb-pms','postgres-superuser.txt'),'utf8').trim()});
await admin.connect();
try{
 const actualMarker=(await admin.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;
 if(review&&actualMarker!==marker)throw Error('Unexpected review database');
 const orgs=(await admin.query('SELECT id FROM org_identity')).rows;
 if(orgs.length!==1)throw Error('Archive setup requires one organization per database');
 const orgId=orgs[0].id;
 if((await admin.query('SELECT 1 FROM clinics c LEFT JOIN org_clinical_units u ON u.clinic_id=c.id AND u.organization_id=$1 WHERE u.clinic_id IS NULL LIMIT 1',[orgId])).rowCount)throw Error('All clinics must belong to this organization');
 if(!process.argv.includes('--apply')){console.log('Dry run: set up a private organization archive worker. Add --apply to provision.');}
 else{
  await migrate(ownerUrl,()=>{},{applyGrants:false});
  const saved=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{database,orgId,role:'kb_archive_'+randomBytes(8).toString('hex'),password:randomBytes(32).toString('base64url')};
  if(saved.database!==database||saved.orgId!==orgId)throw Error('Archive worker belongs to a different database');
  writeFileSync(stateFile,JSON.stringify(saved),{mode:0o600});
  if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[saved.role])).rowCount)await admin.query(`CREATE ROLE ${ident(saved.role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD ${literal(saved.password)}`);
  await admin.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(saved.role)}; GRANT USAGE ON SCHEMA public TO ${ident(saved.role)}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ident(saved.role)}; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(saved.role)}`);
  await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(decodeURIComponent(new URL(ownerUrl).username))} IN SCHEMA public GRANT SELECT ON TABLES TO ${ident(saved.role)}`);
  await admin.query(`GRANT INSERT,UPDATE ON org_archive_runs,org_archive_worker TO ${ident(saved.role)}; GRANT INSERT ON org_audit TO ${ident(saved.role)}`);
  await admin.query(`GRANT SELECT,INSERT ON org_archive_runs TO ${ident(decodeURIComponent(appUrl.username))}; GRANT SELECT ON org_archive_worker TO ${ident(decodeURIComponent(appUrl.username))}`);
  const backupUrl=new URL(appUrl);backupUrl.username=saved.role;backupUrl.password=saved.password;
  const archives=await prepareRoot(process.env.ARCHIVE_DIR??previousWorker.ARCHIVE_DIR??join(homedir(),'.kb-pms','archives',orgId),orgId);
  const pgBin=process.env.PG_BIN??'C:/Program Files/PostgreSQL/18/bin';
  const driveCredentialFile=process.env.ARCHIVE_DRIVE_CREDENTIAL_FILE??previousWorker.ARCHIVE_DRIVE_CREDENTIAL_FILE;
  const workerConfig={ARCHIVE_DATABASE_URL:backupUrl.href,ARCHIVE_DIR:archives,DOCUMENT_DIR:config.DOCUMENT_DIR??join(homedir(),'.kb-pms','documents'),...(config.ORG_DOCUMENT_DIR?{ORG_DOCUMENT_DIR:config.ORG_DOCUMENT_DIR}:{}),PG_DUMP:process.env.PG_BIN?join(pgBin,'pg_dump.exe'):previousWorker.PG_DUMP??join(pgBin,'pg_dump.exe'),PG_RESTORE:process.env.PG_BIN?join(pgBin,'pg_restore.exe'):previousWorker.PG_RESTORE??join(pgBin,'pg_restore.exe'),ARCHIVE_TAR:process.env.ARCHIVE_TAR??previousWorker.ARCHIVE_TAR??'C:/Windows/System32/tar.exe',...(driveCredentialFile?{ARCHIVE_DRIVE_CREDENTIAL_FILE:driveCredentialFile}:{})};
  writeFileSync(workerFile,Object.entries(workerConfig).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
  await admin.query("SELECT set_config('app.organization_id',$1,false)",[orgId]);
  if(process.argv.includes('--enable-defaults'))await admin.query("INSERT INTO org_settings(key,value) VALUES('archive_policy',$1::jsonb) ON CONFLICT(organization_id,unit_id,key) DO NOTHING",[JSON.stringify({...DEFAULT_POLICY,enabled:true})]);
  console.log('Archive worker configured. Private env file: '+workerFile+'. No credentials printed.');
 }
}finally{await admin.end();}
