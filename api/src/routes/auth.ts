import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { attemptLogin } from "../auth/login.js";
import { hashToken, SESSION_COOKIE } from "../auth/tokens.js";
import { resumeSession } from "../db/index.js";
import { HttpError } from "../http/errors.js";
import { sql } from "kysely";
import type { AppOptions } from "../app.js";

export const authRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, opts) => {
  const { db } = opts;

  app.post("/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      body: Type.Object({
        clinic: Type.String({ minLength: 2, maxLength: 32 }),
        username: Type.String({ minLength: 2, maxLength: 40 }),
        password: Type.String({ minLength: 1, maxLength: 200 }),
        device: Type.Optional(Type.Union([Type.Literal("desk"), Type.Literal("phone")]))
      })
    }
  }, async (req, reply) => {
    const { clinic, username, password } = req.body;

    // Decided inside the transaction, thrown after it, so a failed
    // attempt's counter is committed rather than rolled back.
    const outcome = await db.transaction().execute((tx) => attemptLogin(tx, clinic, username, password, req.body.device));

    if (!outcome.ok) throw new HttpError(401, "login_failed", outcome.message);

    reply.setCookie(SESSION_COOKIE, outcome.token, {
      httpOnly: true,
      secure: opts.cookieSecure,
      sameSite: "strict",
      path: "/",
      maxAge: outcome.maxAgeSeconds
    });
    return { user: publicActor(outcome.me) };
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const h = hashToken(token);
      await db.transaction().execute(async (tx) => {
        await sql`SELECT clinical_end_session(${h})`.execute(tx);
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    const me = token ? await db.transaction().execute(tx => resumeSession(tx, hashToken(token))) : null;
    if (!me) throw new HttpError(401, "signed_out", "Please sign in");
    return { user: publicActor(me), clinic: { id: me.clinicId, revision: me.clinicRevision }, organizationId: me.organizationId };
  });
};

function publicActor(a: { userId: string; displayName: string; username: string; role: string; permissions: ReadonlySet<string>; timezone: string }) {
  return { id: a.userId, name: a.displayName, username: a.username, role: a.role, permissions: [...a.permissions], timezone: a.timezone };
}
