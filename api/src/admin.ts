// Operator tasks that run as kb_owner, not through the API: onboarding a
// clinic and creating its first admin. kb_app cannot write to clinics.
import pg from "pg";
import { hashPassword } from "./auth/password.js";
import { DEFAULT_ROLES } from "./auth/permissions.js";

export interface NewClinic {
  code: string;
  name: string;
  uhidScheme?: "year-month" | "sequential";
  uhidPrefix?: string;
  timezone?: string;
}
export interface NewUser { username: string; displayName: string; password: string; role: string }

async function inClinic<T>(ownerUrl: string, clinicId: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query("BEGIN");
    if (clinicId) await c.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}

export function createClinic(ownerUrl: string, clinic: NewClinic): Promise<string> {
  return inClinic(ownerUrl, null, async (c) => {
    const r = await c.query<{ id: string }>(
      "INSERT INTO clinics (code, name, uhid_scheme, uhid_prefix, timezone) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [clinic.code.toLowerCase(), clinic.name, clinic.uhidScheme ?? "year-month",
       (clinic.uhidPrefix ?? "").toUpperCase(), clinic.timezone ?? "Asia/Kolkata"]
    );
    const id = r.rows[0]!.id;
    // The new clinic starts with a copy of the built-in roles; from here they are its own.
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [id]);
    for (const role of DEFAULT_ROLES) {
      await c.query("INSERT INTO roles (name, permissions) VALUES ($1, $2)", [role.name, role.permissions]);
    }
    return id;
  });
}

export async function createUser(ownerUrl: string, clinicId: string, user: NewUser): Promise<string> {
  const hash = await hashPassword(user.password);
  return inClinic(ownerUrl, clinicId, async (c) => {
    const role = await c.query<{ id: string }>("SELECT id FROM roles WHERE name = $1", [user.role]);
    if (!role.rows[0]) throw new Error(`This clinic has no role called "${user.role}"`);
    const r = await c.query<{ id: string }>(
      "INSERT INTO app_users (username, display_name, password_hash, role_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [user.username.toLowerCase(), user.displayName, hash, role.rows[0].id]
    );
    return r.rows[0]!.id;
  });
}
