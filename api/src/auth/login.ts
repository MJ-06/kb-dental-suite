// Password sign-in, shared by /api/v1/auth/login and the screens' /exec.
//
// - One message for every failure, locked accounts included, so nobody can
//   learn which clinic codes or usernames exist, which accounts are locked,
//   or (during a lock) whether a guess was right.
// - The user row is locked (FOR UPDATE) before the password is checked, so
//   parallel guesses queue and each one counts towards the lockout.
// - While an account is locked no password is checked at all.
import { sql } from "kysely";
import { resumeSession, type Actor, type Tx } from "../db/index.js";
import { burnPasswordCheck, verifyPassword } from "./password.js";
import { hashToken, newToken, SESSION_TTL_MS } from "./tokens.js";

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;
export const WRONG =
  "Clinic code, username or password is wrong. After 5 wrong tries the account is paused for 15 minutes.";

export type LoginOutcome = { ok: true; token: string; me: Actor } | { ok: false; message: string };

export async function attemptLogin(tx: Tx, clinic: string, username: string, password: string): Promise<LoginOutcome> {
  const cid = (await sql<{ id: string | null }>`SELECT begin_login(${clinic}) AS id`.execute(tx)).rows[0]?.id;
  const user = cid
    ? (await sql<{ id: string; password_hash: string; active: boolean; locked_until: Date | null }>`
        SELECT id, password_hash, active, locked_until FROM app_users
         WHERE username = ${username.toLowerCase()} FOR UPDATE`.execute(tx)).rows[0]
    : undefined;

  if (!user || !user.active) {
    await burnPasswordCheck(password);
    return { ok: false, message: WRONG };
  }
  await sql`SELECT set_config('app.user_id', ${user.id}, true)`.execute(tx);

  if (user.locked_until && user.locked_until > new Date()) {
    await burnPasswordCheck(password); // same time taken, nothing learned
    return { ok: false, message: WRONG };
  }

  const correct = await verifyPassword(password, user.password_hash);

  if (!correct) {
    // One statement decides the count and the lock, from the locked row.
    await sql`UPDATE app_users
                 SET failed_attempts = CASE WHEN failed_attempts + 1 >= ${MAX_FAILURES} THEN 0 ELSE failed_attempts + 1 END,
                     locked_until    = CASE WHEN failed_attempts + 1 >= ${MAX_FAILURES}
                                            THEN now() + make_interval(mins => ${LOCK_MINUTES}) END
               WHERE id = ${user.id}`.execute(tx);
    return { ok: false, message: WRONG };
  }

  await sql`UPDATE app_users SET failed_attempts = 0, locked_until = NULL
             WHERE id = ${user.id} AND (failed_attempts <> 0 OR locked_until IS NOT NULL)`.execute(tx);
  const token = newToken();
  await tx.insertInto("sessions")
    .values({ token_hash: hashToken(token), user_id: user.id, expires_at: new Date(Date.now() + SESSION_TTL_MS) })
    .execute();
  // Old sessions go now rather than on a schedule.
  await tx.deleteFrom("sessions").where("expires_at", "<=", new Date()).execute();
  const me = await resumeSession(tx, hashToken(token));
  if (!me) throw new Error("A session just created could not be resumed");
  return { ok: true, token, me };
}

/** Sign-in attempts per address in the last minute, bounded in memory. */
export function attemptCounter(limitPerMinute: number, maxAddresses = 10_000) {
  const seen = new Map<string, number[]>();
  return (ip: string): boolean => {
    const now = Date.now();
    const recent = (seen.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    seen.delete(ip);
    seen.set(ip, recent); // re-inserted, so Map order is least recently seen first
    while (seen.size > maxAddresses) seen.delete(seen.keys().next().value!);
    return recent.length > limitPerMinute;
  };
}
