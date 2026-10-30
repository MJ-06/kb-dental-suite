// The admin's view of the system log: failures that need a person, with the
// reference the screen showed, and a way to mark each one looked at.
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import { asActor } from "../http/context.js";
import { notFound } from "../http/errors.js";
import type { AppOptions } from "../app.js";

export const systemLogRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, { db }) => {
  app.get("/", {
    schema: {
      querystring: Type.Object({
        status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("all")], { default: "open" })),
        level: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("info"), Type.Literal("all")], { default: "error" })),
        ref: Type.Optional(Type.String({ maxLength: 20 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 }))
      })
    }
  }, async (req) => asActor(db, req, "audit:read", async (tx) => {
    const { status = "open", level = "error", ref = "", limit = 100 } = req.query;
    const rows = await sql<Record<string, unknown>>`
      SELECT l.id, l.ref, l.happened_at, l.level, l.kind, l.action, l.status, l.message, l.detail,
             u.username AS user, l.resolved_at, l.resolution, r.username AS resolved_by
        FROM system_log l
        LEFT JOIN app_users u ON u.id = l.user_id
        LEFT JOIN app_users r ON r.id = l.resolved_by
       WHERE (${level} = 'all' OR l.level = ${level})
         AND (${status} = 'all' OR (${status} = 'open' AND l.resolved_at IS NULL AND l.level = 'error')
                                OR (${status} = 'resolved' AND l.resolved_at IS NOT NULL))
         AND (${ref} = '' OR l.ref = upper(${ref}))
       ORDER BY l.happened_at DESC LIMIT ${limit}`.execute(tx);
    const c = (await sql<{ open: string; resolved: string; events: string }>`
      SELECT count(*) FILTER (WHERE level = 'error' AND resolved_at IS NULL) AS open,
             count(*) FILTER (WHERE level = 'error' AND resolved_at IS NOT NULL) AS resolved,
             count(*) FILTER (WHERE level = 'info') AS events
        FROM system_log`.execute(tx)).rows[0]!;
    return { rows: rows.rows, counts: { open: Number(c.open), resolved: Number(c.resolved), events: Number(c.events) } };
  }));

  app.post("/:id/resolve", {
    schema: {
      params: Type.Object({ id: Type.String({ format: "uuid" }) }),
      body: Type.Object({ resolution: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false })
    }
  }, async (req) => asActor(db, req, "audit:read", async (tx) => {
    const r = await sql<{ id: string }>`
      UPDATE system_log SET resolved_at = now(), resolved_by = app_user_id(), resolution = ${req.body.resolution?.trim() || null}
       WHERE id = ${req.params.id} AND level = 'error' AND resolved_at IS NULL RETURNING id`.execute(tx);
    if (!r.rows[0]) throw notFound("Open failure");
    return { success: true };
  }));
};
