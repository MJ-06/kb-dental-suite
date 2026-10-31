// The connection pool and the one way to touch clinic data: inTenant().
//
// Every request runs in ONE transaction that first resumes the session
// (which sets app.clinic_id and app.user_id with set_config(..., true)) and
// then runs the handler. The settings are transaction-local, so when the
// connection goes back to the pool the next request starts with no clinic,
// and RLS shows it nothing until it proves who it is.
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { isPermission, type Permission } from "../auth/permissions.js";
import type { DB } from "./schema.js";

// DATE columns come back as 'YYYY-MM-DD' strings, not JS Dates at local
// midnight, which would shift a date of birth by a day west of Greenwich.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Tx = Transaction<DB>;

export interface Actor {
  userId: string;
  clinicId: string;
  roleId: string;
  /** The role's name, for display. What the person may do is `permissions`. */
  role: string;
  permissions: ReadonlySet<Permission>;
  displayName: string;
  username: string;
  timezone: string;
}

export function createDb(connectionString: string, max = 10): Kysely<DB> {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    // A query that has not answered in 15 s is not going to; a clear error
    // at the desk beats a frozen screen.
    statement_timeout: 15_000
  });
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Resumes the session in this transaction. Returns null when signed out. */
export async function resumeSession(tx: Tx, tokenHash: Buffer): Promise<Actor | null> {
  // A phone session left idle too long is removed here, before it can resume.
  await sql`SELECT phone_session_expire(${tokenHash})`.execute(tx);
  const r = await sql<{
    user_id: string; clinic_id: string; role_id: string; role: string; permissions: string[]; display_name: string; username: string; timezone: string;
  }>`SELECT * FROM session_resume(${tokenHash})`.execute(tx);
  const row = r.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id, clinicId: row.clinic_id, roleId: row.role_id, role: row.role,
    permissions: new Set(row.permissions.filter(isPermission)),
    displayName: row.display_name, username: row.username, timezone: row.timezone
  };
}

/** Sets the tenant explicitly. For scripts and tests; requests use resumeSession. */
export async function setTenant(tx: Tx, clinicId: string, userId?: string): Promise<void> {
  await sql`SELECT set_config('app.clinic_id', ${clinicId}, true), set_config('app.user_id', ${userId ?? ""}, true)`.execute(tx);
}
