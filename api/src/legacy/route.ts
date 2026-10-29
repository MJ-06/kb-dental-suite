// /exec: where today's screens send every call, as they sent it to the Apps
// Script web app. GET with the action in the query string, or POST with a
// JSON body (sent as text/plain, as the screens do for long payloads).
//
// The session comes from the HttpOnly cookie set at sign-in. A `token`
// parameter is ignored: it no longer grants anything, so a URL copied into
// a log or a chat cannot sign anyone in.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { can } from "../auth/permissions.js";
import { attemptCounter, attemptLogin } from "../auth/login.js";
import { hashToken, SESSION_COOKIE, SESSION_TTL_MS } from "../auth/tokens.js";
import { resumeSession } from "../db/index.js";
import type { AppOptions } from "../app.js";
import { actions } from "./registry.js";
import { DeskError, type Params, type Result } from "./types.js";

const BATCH_MAX = 25;
const AUTH_REQUIRED: Result = { success: false, error: "AUTH_REQUIRED", authRequired: true };

export const legacyRoutes: FastifyPluginAsync<AppOptions> = async (app, opts) => {
  const { db } = opts;

  // The screens post long payloads as text/plain to avoid a CORS preflight.
  // Same origin now, but the body is still JSON.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(null, {}); }
  });

  const handler = async (req: FastifyRequest) => {
    const params: Params = { ...(req.query as Params), ...((req.body as Params | undefined) ?? {}) };
    const action = String(params.action ?? "").trim();
    const token = req.cookies[SESSION_COOKIE];

    if (action === "ping") return { success: true, message: "pong", timestamp: new Date().toISOString() };
    if (action === "authStatus") {
      const valid = token ? await db.transaction().execute(async (tx) => !!(await resumeSession(tx, hashToken(token)))) : false;
      return { success: true, authRequired: true, valid };
    }
    if (action === "staffLogin") {
      if (tooManyAttempts(req.ip)) return { success: false, error: "Too many attempts. Wait a minute and try again." };
      return staffLogin(params, req);
    }
    if (action === "staffLogout") return staffLogout(req);

    if (!token) return AUTH_REQUIRED;
    if (action === "batch") return batch(params, token);
    return run(action, params, token);
  };

  // A clinic's desks share one address behind its router and the screens
  // are chatty, so the general ceiling is generous; sign-in has its own.
  // Tighten with EXEC_RATE_LIMIT once the real traffic is known.
  const limits = { config: { rateLimit: { max: Number(process.env.EXEC_RATE_LIMIT ?? 900), timeWindow: "1 minute" } }, bodyLimit: 40 * 1024 * 1024 };
  app.get("/exec", limits, async (req) => handler(req));
  app.post("/exec", limits, async (req) => handler(req));

  // Sign-in attempts per address: 10 a minute, like /api/v1/auth/login.
  const tooManyAttempts = attemptCounter(10);

  /** One action in its own transaction. */
  async function run(action: string, params: Params, token: string): Promise<Result> {
    const def = actions[action];
    if (!def) return { success: false, error: `Unknown action: ${action}` };
    try {
      return await db.transaction().execute(async (tx) => {
        const actor = await resumeSession(tx, hashToken(token));
        if (!actor) return AUTH_REQUIRED;
        if (def.permission && !can(actor.role, def.permission)) {
          return { success: false, error: "Your role does not allow this", forbidden: true };
        }
        const out = await def.run(params, { tx, actor });
        // An action that reports failure must not leave half its work behind.
        if (!out.success) throw new Refused(out);
        return out;
      });
    } catch (e) {
      return describe(e, action, app.log);
    }
  }

  // Several reads in one round trip. Reads only: a half-applied batch of
  // writes is worse than a slow page.
  async function batch(params: Params, token: string): Promise<Result> {
    let entries: unknown;
    try { entries = typeof params.actions === "string" ? JSON.parse(params.actions) : params.actions; } catch { entries = null; }
    if (!Array.isArray(entries) || !entries.length) return { success: false, error: "batch: no actions given" };
    if (entries.length > BATCH_MAX) return { success: false, error: `batch: at most ${BATCH_MAX} actions, got ${entries.length}` };
    const results: Record<string, Result> = {};
    await Promise.all(entries.map(async (entry) => {
      const isObj = entry !== null && typeof entry === "object";
      const name = String((isObj ? (entry as Params).action : entry) ?? "").trim();
      const key = String((isObj && (entry as Params).key) || name || "?");
      if (!name.startsWith("get")) { results[key] = { success: false, error: "batch: reads only" }; return; }
      const p: Params = { ...((isObj && ((entry as Params).params as Params)) || {}) };
      results[key] = await run(name, { ...p, action: name }, token);
    }));
    return { success: true, results };
  }

  async function staffLogin(p: Params, req: FastifyRequest): Promise<Result> {
    const clinic = String(p.clinic ?? "").trim();
    const username = String(p.username ?? "").trim().toLowerCase();
    const password = String(p.password ?? "");
    if (!clinic || !username || !password) return { success: false, error: "Enter the clinic code, your username and your password" };

    const outcome = await db.transaction().execute((tx) => attemptLogin(tx, clinic, username, password));

    if (!outcome.ok) return { success: false, error: outcome.message };
    req.server.log.info({ user: outcome.me.username }, "staff signed in");
    // The reply hook below turns this into the cookie; the body carries only
    // a marker the screens treat as "signed in".
    (req as FastifyRequest & { _setSession?: string })._setSession = outcome.token;
    return { success: true, token: "session-cookie", expiresAt: Date.now() + SESSION_TTL_MS,
      user: { name: outcome.me.displayName, role: outcome.me.role } };
  }

  async function staffLogout(req: FastifyRequest): Promise<Result> {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const h = hashToken(token);
      await db.transaction().execute(async (tx) => {
        if (await resumeSession(tx, h)) await tx.deleteFrom("sessions").where("token_hash", "=", h).execute();
      });
    }
    (req as FastifyRequest & { _clearSession?: boolean })._clearSession = true;
    return { success: true };
  }

  app.addHook("onSend", async (req, reply) => {
    const r = req as FastifyRequest & { _setSession?: string; _clearSession?: boolean };
    if (r._setSession) {
      reply.setCookie(SESSION_COOKIE, r._setSession, {
        httpOnly: true, secure: opts.cookieSecure, sameSite: "strict", path: "/", maxAge: SESSION_TTL_MS / 1000
      });
    }
    if (r._clearSession) reply.clearCookie(SESSION_COOKIE, { path: "/" });
  });
};

class Refused extends Error {
  constructor(public result: Result) { super(String(result.error ?? "refused")); }
}

const PG_MESSAGES: Record<string, string> = {
  "23505": "That record already exists",
  "23503": "That refers to something that does not exist",
  "23514": "That would break one of the clinic's rules",
  "23P01": "That chair is already booked for part of that time",
  "22P02": "One of the values is not in the right format",
  "22007": "One of the dates is not valid",
  "22008": "One of the dates is not valid"
};

function describe(e: unknown, action: string, log: { error: (o: unknown, m: string) => void }): Result {
  if (e instanceof Refused) return e.result;
  if (e instanceof DeskError) return { success: false, error: e.message };
  const code = (e as { code?: string }).code;
  if (code && PG_MESSAGES[code]) return { success: false, error: PG_MESSAGES[code]!, rule: (e as { constraint?: string }).constraint };
  log.error({ err: e, action }, "legacy action failed");
  return { success: false, error: "Something went wrong saving that. It has been logged." };
}
