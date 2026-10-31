// The one gate every clinic route goes through.
//
//   cookie -> session_resume() sets the clinic + user -> role check -> handler
//
// all inside a single transaction. The clinic always comes from the session,
// never from the URL or the body, so a request cannot ask for another
// clinic's rows; and if a handler forgets a filter, RLS still applies.
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { can, type Permission } from "../auth/permissions.js";
import { hashToken, SESSION_COOKIE } from "../auth/tokens.js";
import { resumeSession, type Actor, type Tx } from "../db/index.js";
import type { DB } from "../db/schema.js";
import { HttpError } from "./errors.js";

export async function asActor<T>(
  db: Kysely<DB>,
  req: FastifyRequest,
  permission: Permission | null,
  fn: (tx: Tx, actor: Actor) => Promise<T>
): Promise<T> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw new HttpError(401, "signed_out", "Please sign in");

  return db.transaction().execute(async (tx) => {
    const actor = await resumeSession(tx, hashToken(token));
    if (!actor) throw new HttpError(401, "signed_out", "Your session has ended. Please sign in again.");
    if (permission && !can(actor, permission)) {
      throw new HttpError(403, "forbidden", "Your role does not allow this");
    }
    return fn(tx, actor);
  });
}
