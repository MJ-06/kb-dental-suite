import {Type} from '@sinclair/typebox';
import {createHash} from 'node:crypto';
import {sql} from 'kysely';
import type {FastifyPluginAsyncTypebox} from '@fastify/type-provider-typebox';
import type {AppOptions} from '../app.js';
import {asActor} from '../http/context.js';
import {HttpError} from '../http/errors.js';
import type {Actor,Tx} from '../db/index.js';
import {organizationMaster} from '../legacy/organization.js';
import {archiveClock,DEFAULT_POLICY,validatePolicy} from '../archive/policy.js';

async function gate(tx:Tx,actor:Actor){
 if(!actor.organizationId||!actor.manageOrganization)throw new HttpError(403,'forbidden','Organization management permission required');
 const password=await organizationMaster(tx),fingerprint=createHash('sha256').update(password??'unset').digest('hex');
 const r=await sql<{ok:boolean}>`SELECT clinical_master_is_unlocked(${actor.sessionHash!},${fingerprint}) AS ok`.execute(tx);
 if(!r.rows[0]?.ok)throw new HttpError(403,'master_locked','Unlock Master before opening Data Archiving');
}
const Policy=Type.Object({enabled:Type.Boolean(),dailyAt:Type.String({pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'}),dailyDays:Type.Integer({minimum:1,maximum:3650}),monthlyMonths:Type.Integer({minimum:0,maximum:120}),destination:Type.Union([Type.Literal('drive'),Type.Literal('folder')]),driveFolderId:Type.String({maxLength:200}),folderPath:Type.String({maxLength:400})},{additionalProperties:false});
export const archiveRoutes:FastifyPluginAsyncTypebox<AppOptions>=async(app,{db})=>{
 app.get('/',async req=>asActor(db,req,'roles:manage',async(tx,actor)=>{
  await gate(tx,actor);
  const setting=(await sql<{value:unknown;version:number}>`SELECT value,version FROM org_settings WHERE unit_id IS NULL AND key='archive_policy'`.execute(tx)).rows[0];
  const org=(await sql<{timezone:string}>`SELECT timezone FROM org_identity`.execute(tx)).rows[0]!;
  const worker=(await sql<{heartbeat_at:Date;destination:string;last_error:string|null;ready:boolean}>`SELECT heartbeat_at,destination,last_error,ready FROM org_archive_worker`.execute(tx)).rows[0];
  const runs=(await sql`SELECT id,kind,archive_day,status,created_at,started_at,finished_at,file_count,total_bytes,error_code,destination_kind FROM org_archive_runs ORDER BY created_at DESC LIMIT 40`.execute(tx)).rows;
  return {policy:setting?validatePolicy(setting.value):DEFAULT_POLICY,version:setting?.version??0,timezone:org.timezone,
   worker:worker?{...worker,online:Date.now()-new Date(worker.heartbeat_at).getTime()<180000}:null,runs};
 }));
 app.put('/policy',{schema:{body:Type.Object({policy:Policy,version:Type.Integer({minimum:0})},{additionalProperties:false})}},async req=>asActor(db,req,'roles:manage',async(tx,actor)=>{
  await gate(tx,actor);const p=validatePolicy(req.body.policy);
  const saved=req.body.version===0
   ?await sql`INSERT INTO org_settings(key,value) VALUES('archive_policy',${JSON.stringify(p)}::jsonb) ON CONFLICT(organization_id,unit_id,key) DO NOTHING RETURNING version`.execute(tx)
   :await sql`UPDATE org_settings SET value=${JSON.stringify(p)}::jsonb WHERE unit_id IS NULL AND key='archive_policy' AND version=${req.body.version} RETURNING version`.execute(tx);
  if(!saved.rows.length)throw new HttpError(409,'conflict','Archive settings changed. Reload before saving.');
  await sql`INSERT INTO org_audit(actor_id,action) VALUES(${actor.principalId!},'archive.policy_updated')`.execute(tx);
  return {success:true,version:(saved.rows[0] as {version:number}).version};
 }));
 app.post('/runs',{schema:{body:Type.Object({},{additionalProperties:false})}},async req=>asActor(db,req,'roles:manage',async(tx,actor)=>{
  await gate(tx,actor);
  const worker=(await sql<{ok:boolean;ready:boolean}>`SELECT heartbeat_at>now()-interval '3 minutes' AS ok,ready FROM org_archive_worker`.execute(tx)).rows[0];
  if(!worker?.ok)throw new HttpError(503,'worker_offline','The archive worker is offline. Start it on the server before creating an archive.');
  if(!worker.ready)throw new HttpError(409,'destination_not_ready','Configure the archive destination and refresh worker status before creating an archive.');
  const timezone=(await sql<{timezone:string}>`SELECT timezone FROM org_identity`.execute(tx)).rows[0]!.timezone;
  const r=await sql`INSERT INTO org_archive_runs(kind,archive_day) VALUES('manual',${archiveClock(new Date(),timezone).day}::date) ON CONFLICT DO NOTHING RETURNING id`.execute(tx);
  if(!r.rows.length)throw new HttpError(409,'archive_busy','An archive is already queued or running.');
  await sql`INSERT INTO org_audit(actor_id,action) VALUES(${actor.principalId!},'archive.requested')`.execute(tx);
  return {success:true,id:(r.rows[0] as {id:string}).id};
 }));
};
