import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../db/schema.js";
export type OrgTx = Transaction<DB>;
export const ORG_PERMISSIONS = ["access:manage", "settings:manage", "forms:manage", "metrics:read", "audit:read"];
export const UNIT_PERMISSIONS = ["patients:read", "patients:write", "appointments:read", "appointments:write", "clinical:read", "clinical:write", "forms:fill", "finance:read", "finance:write", "settings:write"];
export const TEMPLATES: Record<string, string[]> = {
  "clinic-admin": ["settings:write", "appointments:read"],
  doctor: ["patients:read", "patients:write", "appointments:read", "appointments:write", "clinical:read", "clinical:write", "forms:fill"],
  reception: ["patients:read", "patients:write", "appointments:read", "appointments:write"],
  accounts: ["patients:read", "finance:read", "finance:write"]
};
export class OrgError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export function fail(status: number, code: string, message: string): never { throw new OrgError(status, code, message); }
export function text(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(400,"invalid_request",`Invalid ${name}`);
  return v.trim();
}
export function uuid(v: unknown): string {
  const s = text(v,"ID",36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) fail(400,"invalid_request","Invalid ID");
  return s;
}
export async function context(tx: OrgTx, id: string, user?: string) {
  await sql`SELECT set_config('app.organization_id',${id},true),set_config('app.user_id',${user ?? ""},true)`.execute(tx);
}
export async function audit(tx: OrgTx, actor: string, action: string, subject?: string, unit?: string) {
  await sql`INSERT INTO org_audit(actor_id,action,subject_id,unit_id) VALUES(${actor},${action},${subject ?? null},${unit ?? null})`.execute(tx);
}
export async function counter(tx: OrgTx, key: string): Promise<number> {
  return (await sql<{value:number}>`INSERT INTO org_counters(key,value) VALUES(${key},1)
    ON CONFLICT(organization_id,key) DO UPDATE SET value=org_counters.value+1 RETURNING value`.execute(tx)).rows[0]!.value;
}
export async function patient(tx: OrgTx, id: string) {
  const p = (await sql<any>`SELECT id,uhid,name,phone,gender,dob,version FROM org_patients WHERE id=${uuid(id)}`.execute(tx)).rows[0];
  if (!p) fail(404,"not_found","Patient not found");
  return p;
}
export type OrgDb = Kysely<DB>;
