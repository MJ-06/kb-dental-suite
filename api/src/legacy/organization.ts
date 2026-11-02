import { sql } from "kysely";
import { createHash } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/password.js";
import type { Actor, Tx } from "../db/index.js";
import { read, write, type ActionTable } from "./types.js";
import { parseObject, str } from "./util.js";

const fingerprint = (value: string | null) => createHash("sha256").update(value ?? "unset").digest("hex");
export async function organizationMaster(tx: Tx): Promise<string | null> {
  return (await sql<{ value: string }>`SELECT value FROM org_settings WHERE unit_id IS NULL AND key='clinical_master_password'`.execute(tx)).rows[0]?.value ?? null;
}
export async function verifyOrganizationMaster(tx: Tx, actor: Actor, password: string) {
  const stored = await organizationMaster(tx);
  const correct = !stored || await verifyPassword(password, stored);
  if (correct) await sql`SELECT clinical_unlock_master(${actor.sessionHash!},${fingerprint(stored)})`.execute(tx);
  return { success: true, correct };
}
export async function saveOrganizationMaster(tx: Tx, actor: Actor, password: string) {
  if (!actor.manageOrganization || !actor.permissions.has("roles:manage")) return { success: false, error: "Organization management permission required" };
  const hashed = await hashPassword(password);
  await sql`INSERT INTO org_settings(key,value) VALUES('clinical_master_password',${JSON.stringify(hashed)}::jsonb)
    ON CONFLICT(organization_id,unit_id,key) DO UPDATE SET value=excluded.value`.execute(tx);
  return { success: true };
}
async function allowed(tx: Tx, actor: Actor) {
  if (!actor.organizationId) return { success: false, error: "This clinic has not been linked to an organization by the operator." };
  if (!actor.manageOrganization || !actor.permissions.has("roles:manage")) return { success: false, error: "Organization management permission required", forbidden: true };
  const stored = await organizationMaster(tx);
  const unlocked = (await sql<{ ok: boolean }>`SELECT clinical_master_is_unlocked(${actor.sessionHash!},${fingerprint(stored)}) AS ok`.execute(tx)).rows[0]!.ok;
  if (!unlocked) return { success: false, locked: true, error: "Unlock with the Master password to continue." };
  return null;
}

export const organizationActions: ActionTable = {
  getWorkingClinics: read(async (_p, { tx, actor }) => {
    const state = (await sql<{ state: Record<string, unknown> }>`SELECT clinical_clinics(${actor.sessionHash!}) AS state`.execute(tx)).rows[0]!.state;
    return { success: true, ...state };
  }),
  switchWorkingClinic: read(async (p, { tx, actor }) => {
    const id = str(p.clinicId);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { success: false, error: "Invalid clinic" };
    const next = (await sql<{ actor: Record<string, unknown> | null }>`SELECT clinical_switch(${actor.sessionHash!},${id}::uuid) AS actor`.execute(tx)).rows[0]!.actor;
    if (!next) return { success: false, forbidden: true, error: "Clinic access is not granted in this organization" };
    await sql`INSERT INTO org_audit(actor_id,unit_id,action) VALUES(${actor.principalId!},${next.unit_id as string},'clinical.clinic_switched')`.execute(tx);
    return { success: true, clinicId: next.clinic_id, revision: next.clinic_revision };
  }),
  getOrganizationProfile: read(async (_p, { tx, actor }) => {
    const denied = await allowed(tx, actor); if (denied) return denied;
    const identity = (await sql<Record<string, unknown>>`SELECT code,name,hostname,timezone,currency FROM org_identity`.execute(tx)).rows[0];
    const row = (await sql<{ value: unknown; version: number }>`SELECT value,version FROM org_settings WHERE unit_id IS NULL AND key='clinical_profile'`.execute(tx)).rows[0];
    return { success: true, identity, profile: row?.value ?? { displayName: identity?.name ?? "" }, version: row?.version ?? 0 };
  }, "masters:write"),
  saveOrganizationProfile: write("masters:write", async (p, { tx, actor }) => {
    const denied = await allowed(tx, actor); if (denied) return denied;
    const raw = parseObject(p.profile, "organization profile");
    const limits: Record<string, number> = { displayName: 120, legalName: 200, address: 500, phone: 60, email: 200, website: 200 };
    if (Object.keys(raw).some(k => !(k in limits)) || !Number.isInteger(p.version) || Number(p.version) < 0) return { success: false, error: "Invalid organization profile or version" };
    const profile: Record<string, string> = {};
    for (const [key, limit] of Object.entries(limits)) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") return { success: false, error: `Invalid ${key}` };
      profile[key] = str(raw[key]);
      if (profile[key]!.length > limit) return { success: false, error: `${key} is too long` };
    }
    if (!profile.displayName) return { success: false, error: "Organization name is required" };
    if (profile.email && !/^[^\s@]+@[^\s@]+[.][^\s@]+$/.test(profile.email)) return { success: false, error: "Invalid email address" };
    const value = JSON.stringify(profile);
    const saved = p.version === 0
      ? await sql<{ version: number }>`INSERT INTO org_settings(key,value) VALUES('clinical_profile',${value}::jsonb)
          ON CONFLICT(organization_id,unit_id,key) DO NOTHING RETURNING version`.execute(tx)
      : await sql<{ version: number }>`UPDATE org_settings SET value=${value}::jsonb WHERE unit_id IS NULL AND key='clinical_profile' AND version=${p.version as number} RETURNING version`.execute(tx);
    if (!saved.rows.length) return { success: false, conflict: true, error: "Organization details changed. Reload before saving again." };
    await sql`INSERT INTO org_audit(actor_id,action) VALUES(${actor.principalId!},'clinical.organization_profile_updated')`.execute(tx);
    return { success: true, profile, version: saved.rows[0]!.version };
  })
};
