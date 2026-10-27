import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import { burnPasswordCheck, verifyPassword } from "../auth/password.js";
import { hashToken, newToken, SESSION_COOKIE, SESSION_TTL_MS } from "../auth/tokens.js";
import { resumeSession } from "../db/index.js";
import { asActor } from "../http/context.js";
import { HttpError } from "../http/errors.js";
import type { AppOptions } from "../app.js";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
// One message for every failure, so a stranger cannot learn which clinic
// codes or usernames exist.
const WRONG = "Clinic code, username or password is wrong";

export const authRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, opts) => {
  const { db } = opts;

  app.post("/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      body: Type.Object({
        clinic: Type.String({ minLength: 2, maxLength: 32 }),
        username: Type.String({ minLength: 2, maxLength: 40 }),
        password: Type.String({ minLength: 1, maxLength: 200 })
      })
    }
  }, async (req, reply) => {
    const { clinic, username, password } = req.body;

    // The outcome is decided inside the transaction but thrown after it,
    // so a failed attempt's counter is committed, not rolled back.
    const outcome = await db.transaction().execute(async (tx) => {
      const cid = (await sql<{ id: string | null }>`SELECT begin_login(${clinic}) AS id`.execute(tx)).rows[0]?.id;
      const user = cid
        ? await tx.selectFrom("app_users")
            .select(["id", "password_hash", "active", "locked_until", "failed_attempts"])
            .where("username", "=", username.toLowerCase())
            .executeTakeFirst()
        : undefined;

      if (!user || !user.active) {
        await burnPasswordCheck(password);
        return { ok: false as const, message: WRONG };
      }
      await sql`SELECT set_config('app.user_id', ${user.id}, true)`.execute(tx);

      if (user.locked_until && user.locked_until > new Date()) {
        const mins = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
        return { ok: false as const, message: `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
      }

      if (!(await verifyPassword(password, user.password_hash))) {
        const failures = user.failed_attempts + 1;
        await tx.updateTable("app_users")
          .set({
            failed_attempts: failures >= MAX_FAILURES ? 0 : failures,
            locked_until: failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null
          })
          .where("id", "=", user.id)
          .execute();
        return { ok: false as const, message: WRONG };
      }

      if (user.failed_attempts || user.locked_until) {
        await tx.updateTable("app_users").set({ failed_attempts: 0, locked_until: null }).where("id", "=", user.id).execute();
      }
      const token = newToken();
      await tx.insertInto("sessions")
        .values({ token_hash: hashToken(token), user_id: user.id, expires_at: new Date(Date.now() + SESSION_TTL_MS) })
        .execute();
      // Old sessions go now rather than on a schedule.
      await tx.deleteFrom("sessions").where("expires_at", "<=", new Date()).execute();
      const me = await resumeSession(tx, hashToken(token));
      if (!me) throw new Error("A session just created could not be resumed");
      return { ok: true as const, token, me };
    });

    if (!outcome.ok) throw new HttpError(401, "login_failed", outcome.message);

    reply.setCookie(SESSION_COOKIE, outcome.token, {
      httpOnly: true,
      secure: opts.cookieSecure,
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000
    });
    return { user: publicActor(outcome.me) };
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const h = hashToken(token);
      await db.transaction().execute(async (tx) => {
        if (await resumeSession(tx, h)) await tx.deleteFrom("sessions").where("token_hash", "=", h).execute();
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const me = await asActor(db, req, null, async (_tx, a) => a);
    return { user: publicActor(me) };
  });
};

function publicActor(a: { userId: string; displayName: string; username: string; role: string; timezone: string }) {
  return { id: a.userId, name: a.displayName, username: a.username, role: a.role, timezone: a.timezone };
}
