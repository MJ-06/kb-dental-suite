import pg from 'pg';
import {archiveClock,DEFAULT_POLICY,expiredArchives,scheduledDay,validatePolicy} from './policy.js';
import {ArchiveError,createBundle,expireBundle,prepareRoot,verifyBundle,type BundleOptions} from './bundle.js';
import {checkDestination,publishArchive,expirePublished,type ArchiveDrive} from './destination.js';

export type WorkerOptions=Omit<BundleOptions,'organizationId'>&{tar:string;drive?:ArchiveDrive};
/** Separate local process with a dedicated database-only backup role. The web
 * application never receives its password or access to archive files. */
export async function archiveTick(options:WorkerOptions,now=new Date()){
 const c=new pg.Client({connectionString:options.databaseUrl});await c.connect();
 let locked=false,heartbeat:NodeJS.Timeout|undefined,heartbeatClient:pg.Client|undefined;
 try{
  locked=(await c.query('SELECT pg_try_advisory_lock(833003,1) ok')).rows[0].ok;
  if(!locked)return;
  const role=(await c.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(!role.rolsuper&&!role.rolbypassrls)throw new ArchiveError('BACKUP_ROLE_REQUIRES_BYPASSRLS');
  const organizations=(await c.query('SELECT id,timezone FROM org_identity')).rows;
  if(organizations.length!==1)throw new ArchiveError('ONE_ORGANIZATION_DATABASE_REQUIRED');
  const org=organizations[0];
  const unlinked=await c.query('SELECT 1 FROM clinics c LEFT JOIN org_clinical_units u ON u.clinic_id=c.id AND u.organization_id=$1 WHERE u.clinic_id IS NULL LIMIT 1',[org.id]);
  if(unlinked.rowCount)throw new ArchiveError('UNLINKED_CLINIC_IN_DATABASE');
  await c.query("SELECT set_config('app.organization_id',$1,false)",[org.id]);
  const root=await prepareRoot(options.root,org.id),bundleOptions={...options,root,organizationId:org.id};
  // A free advisory lock proves a previous worker no longer owns an active run.
  await c.query("UPDATE org_archive_runs SET status='failed',finished_at=now(),error_code='WORKER_INTERRUPTED' WHERE status='running'");
  const setting=(await c.query("SELECT value FROM org_settings WHERE unit_id IS NULL AND key='archive_policy'")).rows[0];
  const policy=setting?validatePolicy(setting.value):DEFAULT_POLICY;
  let destination:string,ready=true,destinationError:string|null=null;
  try{destination=(await checkDestination(policy,bundleOptions)).label;}
  catch(e){destination=policy.destination==='drive'?'Google Drive — connection required':'Personal storage folder — not configured';ready=false;destinationError=e instanceof ArchiveError?e.code:'DESTINATION_CHECK_FAILED';}
  await c.query("INSERT INTO org_archive_worker(organization_id,destination,ready,last_error) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id) DO UPDATE SET heartbeat_at=now(),destination=excluded.destination,ready=excluded.ready,last_error=excluded.last_error",[org.id,destination,ready,destinationError]);
  if(!ready)return;
  const clock=archiveClock(now,org.timezone);
  const days=(await c.query('SELECT archive_day::text AS "day" FROM org_archive_runs WHERE kind=\'scheduled\' AND archive_day=$1::date',[clock.day])).rows.map(r=>r.day);
  const day=scheduledDay(policy,now,org.timezone,days);
  if(day)await c.query("INSERT INTO org_archive_runs(kind,archive_day) VALUES('scheduled',$1::date) ON CONFLICT DO NOTHING",[day]);
  const run=(await c.query("UPDATE org_archive_runs SET status='running',started_at=now() WHERE id=(SELECT id FROM org_archive_runs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING id")).rows[0];
  if(!run)return;
  // Keep the screen truthful while a large dump/upload owns a read-only snapshot
  // on the main connection. Never issue heartbeat writes inside that snapshot.
  heartbeatClient=new pg.Client({connectionString:options.databaseUrl});await heartbeatClient.connect();
  const pulse=heartbeatClient;
  heartbeat=setInterval(()=>{void pulse.query('UPDATE org_archive_worker SET heartbeat_at=now() WHERE organization_id=$1',[org.id]).catch(()=>{});},30000);heartbeat.unref();
  try{
   const manifest=await createBundle(c,run.id,bundleOptions);
   const published=await publishArchive(run.id,policy,bundleOptions);
   await c.query("UPDATE org_archive_runs SET status='succeeded',finished_at=now(),file_count=$2,total_bytes=$3,dump_sha256=$4,destination_kind=$5,destination_ref=$6,destination_parent=$7,destination_checksum=$8 WHERE id=$1",[run.id,manifest.files.length,manifest.dump.bytes+manifest.files.reduce((n,f)=>n+f.bytes,0),manifest.dump.sha256,published.kind,published.ref,published.parent,published.checksum]);
   await c.query("INSERT INTO org_audit(action,subject_id) VALUES('archive.completed',$1)",[run.id]);
   await c.query('UPDATE org_archive_worker SET heartbeat_at=now(),last_error=NULL');
  }catch(e){
   const code=e instanceof ArchiveError?e.code:'ARCHIVE_FAILED';
   await c.query("UPDATE org_archive_runs SET status='failed',finished_at=now(),error_code=$2 WHERE id=$1",[run.id,code]);
   await c.query('UPDATE org_archive_worker SET heartbeat_at=now(),last_error=$1',[code]);
   return;
  }
  // Expiration runs only after a new successful recovery copy exists.
  const runs=(await c.query('SELECT id,archive_day::text AS "day",status,destination_kind,destination_ref,destination_parent,destination_checksum FROM org_archive_runs WHERE status=\'succeeded\' ORDER BY created_at')).rows;
  for(const id of expiredArchives(runs,clock.day,policy)){
   try{
    const run=runs.find(r=>r.id===id)!;
    // Verify the local recovery copy before expiring its published counterpart.
    await verifyBundle(root,id,org.id);
    await expirePublished(id,{kind:run.destination_kind,ref:run.destination_ref,parent:run.destination_parent,checksum:run.destination_checksum},bundleOptions);
    if(run.destination_kind!=='folder'||run.destination_ref!==root)await expireBundle(root,id,org.id);
    await c.query("UPDATE org_archive_runs SET status='expired' WHERE id=$1",[id]);
    await c.query("INSERT INTO org_audit(action,subject_id) VALUES('archive.expired',$1)",[id]);
   }catch{
    await c.query("UPDATE org_archive_worker SET last_error='RETENTION_REVIEW_REQUIRED'");
    break;
   }
  }
 }finally{
  if(heartbeat)clearInterval(heartbeat);
  if(heartbeatClient)await heartbeatClient.end();
  if(locked)await c.query('SELECT pg_advisory_unlock(833003,1)');
  await c.end();
 }
}
