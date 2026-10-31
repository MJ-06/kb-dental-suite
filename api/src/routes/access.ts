// "Roles & access": the clinic's roles and what each may do, and the staff
// logins that use them. Every route needs "roles:manage".
//
// An administrator is whoever holds roles:manage through an active login. The
// clinic must always have at least one, so every change that could remove the
// last one (deactivating a login, moving it to another role, unticking the
// permission, deleting the role) is checked after it is made and rolled back
// if none would remain. Changes take the clinic's advisory lock first, so two
// admins demoting each other at the same moment queue instead of both passing.
//
// Each change is written to audit_log by the table triggers (who, before, after;
// never a password hash) and, in plain words, to the system log as an "access" event.
import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import type { AppOptions } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { isPermission, PERMISSION_INFO, type Permission } from "../auth/permissions.js";
import type { Actor, Tx } from "../db/index.js";
import { asActor } from "../http/context.js";
import { HttpError, notFound } from "../http/errors.js";
import { recordEvent } from "../syslog.js";

const MIN_PASSWORD = 10;
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // nothing that reads alike
const newPassword = () => Array.from(randomBytes(12), (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
const label = (p: string) => PERMISSION_INFO.find((i) => i.id === p)?.label ?? p;

const Name = Type.String({ minLength: 2, maxLength: 40 });
const Perms = Type.Array(Type.String({ maxLength: 40 }), { maxItems: 60 });
const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

/** Known permission names only, no repeats, in the page's order. */
function cleanPermissions(input: string[]): Permission[] {
  const unknown = input.filter((p) => !isPermission(p));
  if (unknown.length) throw new HttpError(400, "unknown_permission", `Not a permission: ${unknown[0]}`);
  const wanted = new Set(input);
  return PERMISSION_INFO.map((i) => i.id).filter((p) => wanted.has(p));
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length < 2) throw new HttpError(400, "invalid_request", "Give the role a name of at least 2 characters");
  return name;
}

const lockClinic = (tx: Tx, actor: Actor) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.clinicId}, 20))`.execute(tx);

async function assertAdminRemains(tx: Tx): Promise<void> {
  const n = (await sql<{ n: string }>`
    SELECT count(*) AS n FROM app_users u JOIN roles r ON r.clinic_id = u.clinic_id AND r.id = u.role_id
     WHERE u.active AND 'roles:manage' = ANY (r.permissions)`.execute(tx)).rows[0]!.n;
  if (Number(n) === 0) {
    throw new HttpError(409, "last_admin",
      "The clinic needs at least one active administrator (a login whose role holds Roles & access). Give someone else that role first.");
  }
}

async function roleRow(tx: Tx, id: string) {
  const r = (await sql<{ id: string; name: string; permissions: string[] }>`
    SELECT id, name::text, permissions FROM roles WHERE id = ${id} FOR UPDATE`.execute(tx)).rows[0];
  if (!r) throw notFound("Role");
  return r;
}

async function nameFree(tx: Tx, name: string, exceptId?: string) {
  const dup = (await sql`SELECT 1 FROM roles WHERE name = ${name} AND id IS DISTINCT FROM ${exceptId ?? null}`.execute(tx)).rows[0];
  if (dup) throw new HttpError(409, "duplicate", "There is already a role with that name");
}

export const accessRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, { db }) => {
  const limited = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const gate = <T>(req: Parameters<typeof asActor>[1], fn: (tx: Tx, actor: Actor) => Promise<T>) => asActor(db, req, "roles:manage", fn);

  app.get("/permissions", async (req) => gate(req, async () => ({ permissions: PERMISSION_INFO })));

  app.get("/roles", async (req) => gate(req, async (tx) => {
    const rows = await sql<{ id: string; name: string; permissions: string[]; users: string }>`
      SELECT r.id, r.name::text, r.permissions, count(u.id) AS users
        FROM roles r LEFT JOIN app_users u ON u.clinic_id = r.clinic_id AND u.role_id = r.id
       GROUP BY r.id ORDER BY r.created_at, r.name`.execute(tx);
    return { roles: rows.rows.map((r) => ({ ...r, permissions: r.permissions.filter(isPermission), users: Number(r.users) })) };
  }));

  app.post("/roles", {
    ...limited,
    schema: { body: Type.Object({ name: Name, permissions: Type.Optional(Perms), copy_from: Type.Optional(Type.String({ format: "uuid" })) }, { additionalProperties: false }) }
  }, async (req, reply) => gate(req, async (tx, actor) => {
    await lockClinic(tx, actor);
    const name = cleanName(req.body.name);
    await nameFree(tx, name);
    const permissions = req.body.permissions
      ? cleanPermissions(req.body.permissions)
      : req.body.copy_from ? cleanPermissions((await roleRow(tx, req.body.copy_from)).permissions.filter(isPermission)) : [];
    const id = (await sql<{ id: string }>`INSERT INTO roles (name, permissions) VALUES (${name}, ${permissions}::text[]) RETURNING id`.execute(tx)).rows[0]!.id;
    await recordEvent(tx, "access", "role.created", `${actor.username} created the role ${name} with ${permissions.length} permissions`, { role: name, permissions });
    reply.status(201);
    return { id, name, permissions };
  }));

  app.patch("/roles/:id", {
    ...limited,
    schema: { params: Id, body: Type.Object({ name: Type.Optional(Name), permissions: Type.Optional(Perms) }, { additionalProperties: false }) }
  }, async (req) => gate(req, async (tx, actor) => {
    if (req.body.name === undefined && req.body.permissions === undefined) throw new HttpError(400, "invalid_request", "Nothing to change");
    await lockClinic(tx, actor);
    const before = await roleRow(tx, req.params.id);
    const name = req.body.name === undefined ? before.name : cleanName(req.body.name);
    if (name !== before.name) await nameFree(tx, name, before.id);
    const permissions = req.body.permissions === undefined ? cleanPermissions(before.permissions.filter(isPermission)) : cleanPermissions(req.body.permissions);
    await sql`UPDATE roles SET name = ${name}, permissions = ${permissions}::text[] WHERE id = ${before.id}`.execute(tx);
    await assertAdminRemains(tx);

    const had = new Set(before.permissions);
    const added = permissions.filter((p) => !had.has(p)), removed = before.permissions.filter((p) => !permissions.includes(p as Permission));
    const parts = [
      name !== before.name ? `renamed ${before.name} to ${name}` : `changed ${name}`,
      added.length ? `added ${added.map(label).join(", ")}` : "",
      removed.length ? `removed ${removed.map(label).join(", ")}` : ""
    ].filter(Boolean);
    await recordEvent(tx, "access", "role.updated", `${actor.username} ${parts.join("; ")}`, { role: name, was: before.name, added, removed });
    return { id: before.id, name, permissions };
  }));

  app.delete("/roles/:id", { ...limited, schema: { params: Id } }, async (req) => gate(req, async (tx, actor) => {
    await lockClinic(tx, actor);
    const role = await roleRow(tx, req.params.id);
    const users = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM app_users WHERE role_id = ${role.id}`.execute(tx)).rows[0]!.n);
    if (users > 0) {
      throw new HttpError(409, "role_in_use", `${users} ${users === 1 ? "person is" : "people are"} still on the role ${role.name}. Move them to another role first.`);
    }
    await sql`DELETE FROM roles WHERE id = ${role.id}`.execute(tx);
    await recordEvent(tx, "access", "role.deleted", `${actor.username} deleted the role ${role.name}`, { role: role.name });
    return { success: true };
  }));

  app.get("/staff", async (req) => gate(req, async (tx) => {
    const rows = await sql<Record<string, unknown>>`
      SELECT u.id, u.username::text AS username, u.display_name, u.role_id, r.name::text AS role, u.active,
             coalesce(u.locked_until > now(), false) AS locked, u.created_at
        FROM app_users u JOIN roles r ON r.clinic_id = u.clinic_id AND r.id = u.role_id
       ORDER BY u.active DESC, u.display_name`.execute(tx);
    return { staff: rows.rows };
  }));

  app.post("/staff", {
    ...limited,
    schema: {
      body: Type.Object({
        username: Type.String({ pattern: "^[A-Za-z0-9._-]{2,40}$" }),
        display_name: Type.String({ minLength: 1, maxLength: 80 }),
        role_id: Type.String({ format: "uuid" }),
        password: Type.Optional(Type.String({ minLength: MIN_PASSWORD, maxLength: 200 }))
      }, { additionalProperties: false })
    }
  }, async (req, reply) => gate(req, async (tx, actor) => {
    await lockClinic(tx, actor);
    const role = await roleRow(tx, req.body.role_id);
    const username = req.body.username.toLowerCase();
    if ((await sql`SELECT 1 FROM app_users WHERE username = ${username}`.execute(tx)).rows[0]) {
      throw new HttpError(409, "duplicate", "That username is taken");
    }
    // Shown once. Only its hash is kept.
    const password = req.body.password ?? newPassword();
    const id = (await sql<{ id: string }>`
      INSERT INTO app_users (username, display_name, password_hash, role_id)
      VALUES (${username}, ${req.body.display_name.trim()}, ${await hashPassword(password)}, ${role.id}) RETURNING id`.execute(tx)).rows[0]!.id;
    await recordEvent(tx, "access", "staff.created", `${actor.username} created the login ${username} on the role ${role.name}`, { username, role: role.name });
    reply.status(201);
    return { id, username, ...(req.body.password ? {} : { password }) };
  }));

  app.patch("/staff/:id", {
    ...limited,
    schema: {
      params: Id,
      body: Type.Object({
        display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        role_id: Type.Optional(Type.String({ format: "uuid" })),
        active: Type.Optional(Type.Boolean())
      }, { additionalProperties: false })
    }
  }, async (req) => gate(req, async (tx, actor) => {
    const b = req.body;
    if (b.display_name === undefined && b.role_id === undefined && b.active === undefined) throw new HttpError(400, "invalid_request", "Nothing to change");
    await lockClinic(tx, actor);
    const before = (await sql<{ id: string; username: string; display_name: string; role_id: string; role: string; active: boolean }>`
      SELECT u.id, u.username::text AS username, u.display_name, u.role_id, r.name::text AS role, u.active
        FROM app_users u JOIN roles r ON r.clinic_id = u.clinic_id AND r.id = u.role_id
       WHERE u.id = ${req.params.id} FOR UPDATE OF u`.execute(tx)).rows[0];
    if (!before) throw notFound("Staff member");
    const role = b.role_id === undefined ? { id: before.role_id, name: before.role } : await roleRow(tx, b.role_id);
    const active = b.active ?? before.active;
    const displayName = b.display_name?.trim() || before.display_name;
    await sql`UPDATE app_users SET display_name = ${displayName}, role_id = ${role.id}, active = ${active} WHERE id = ${before.id}`.execute(tx);
    await assertAdminRemains(tx);
    // A deactivated login stops at its next click anyway; this also ends the session itself.
    if (!active) await sql`DELETE FROM sessions WHERE user_id = ${before.id}`.execute(tx);

    const parts = [
      active !== before.active ? (active ? "reactivated" : "deactivated") : "",
      role.id !== before.role_id ? `moved from ${before.role} to ${role.name}` : "",
      displayName !== before.display_name ? "changed the display name" : ""
    ].filter(Boolean);
    await recordEvent(tx, "access", "staff.updated", `${actor.username} ${parts.join(" and ") || "saved"} the login ${before.username}`,
      { username: before.username, role: role.name, was: before.role, active });
    return { id: before.id, role_id: role.id, role: role.name, active, display_name: displayName };
  }));

  app.post("/staff/:id/reset-password", {
    // Hashing is deliberately slow; a low ceiling keeps this from being a way to tie up the server.
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { params: Id, body: Type.Object({ password: Type.Optional(Type.String({ minLength: MIN_PASSWORD, maxLength: 200 })) }, { additionalProperties: false }) }
  }, async (req) => gate(req, async (tx, actor) => {
    await lockClinic(tx, actor);
    const user = (await sql<{ id: string; username: string }>`SELECT id, username::text AS username FROM app_users WHERE id = ${req.params.id} FOR UPDATE`.execute(tx)).rows[0];
    if (!user) throw notFound("Staff member");
    const password = req.body.password ?? newPassword();
    // The reset also clears a lock from too many wrong tries, and signs the person out everywhere.
    await sql`UPDATE app_users SET password_hash = ${await hashPassword(password)}, failed_attempts = 0, locked_until = NULL WHERE id = ${user.id}`.execute(tx);
    await sql`DELETE FROM sessions WHERE user_id = ${user.id} AND NOT (user_id = ${actor.userId})`.execute(tx);
    await recordEvent(tx, "access", "staff.password_reset", `${actor.username} reset the password of ${user.username}`, { username: user.username });
    return { id: user.id, username: user.username, ...(req.body.password ? {} : { password }) };
  }));

  app.get("/activity", async (req) => gate(req, async (tx) => {
    const rows = await sql<Record<string, unknown>>`
      SELECT l.happened_at, l.action, l.message, u.username AS by
        FROM system_log l LEFT JOIN app_users u ON u.id = l.user_id
       WHERE l.kind = 'access' ORDER BY l.happened_at DESC LIMIT 100`.execute(tx);
    return { activity: rows.rows };
  }));
};
