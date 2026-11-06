import {sql} from 'kysely';
import type {Tx} from '../db/index.js';
import {DeskError} from './types.js';
export class SaveConflict extends DeskError {constructor(){super('This record changed after you opened it. Reload its latest version before saving. Your edits have not been saved.');}}
type Versioned='care_plans'|'treatment_plans'|'clinical_sheets'|'patients';
export async function checkVersion(tx:Tx,table:Versioned,uhid:string,expected:unknown,sheetType?:string){
 // Serialize creation too: SELECT FOR UPDATE alone cannot lock a missing row.
 await sql`SELECT pg_advisory_xact_lock(hashtextextended(app_clinic_id()::text||${':'+table+':'+uhid+':'+(sheetType??'')},0))`.execute(tx);
 const rows=await sql<{version:number}>`SELECT version FROM ${sql.table(table)} WHERE upper(uhid)=${uhid} ${table==='clinical_sheets'?sql`AND sheet_type=${sheetType??''}`:sql``}`.execute(tx);
 const version=rows.rows[0]?.version??0;
 if(expected!==undefined){const n=Number(expected);if(!Number.isSafeInteger(n)||n<0)throw new DeskError('Invalid record version');if(n!==version)throw new SaveConflict();}
 return version;
}
export async function currentVersion(tx:Tx,table:Versioned,uhid:string,sheetType?:string){
 return (await sql<{version:number}>`SELECT version FROM ${sql.table(table)} WHERE upper(uhid)=${uhid} ${table==='clinical_sheets'?sql`AND sheet_type=${sheetType??''}`:sql``}`.execute(tx)).rows[0]?.version??0;
}
