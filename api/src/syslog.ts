// The system log: unexpected failures with a reference, and a few accountable
// events. Writing it must never make a failure worse, so nothing here throws.
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { hashToken } from "./auth/tokens.js";
import { resumeSession, type Tx } from "./db/index.js";
import type { DB } from "./db/schema.js";

let logDb: Kysely<DB> | null = null;
/** Called once by buildApp. */
export function configureSystemLog(db: Kysely<DB>) { logDb = db; }

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I, so it reads aloud cleanly
const newRef = () => "E-" + Array.from(randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** Postgres messages quote the offending values: "Key (uhid)=(AL0705) ...". Drop them. */
export function scrub(message: string): string {
  return message
    .replace(/\(([^()]*)\)=\(([^()]*)\)/g, "($1)=(…)")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "…")      // email addresses
    .replace(/\b\d{6,}\b/g, "…")                    // phone, card and similar numbers
    .replace(/'[^']{0,200}'/g, "'…'")
    .replace(/"[^"]{0,200}"/g, '"…"')
    .slice(0, 300);
}

/** A database error says only what rule broke, never the offending values: those are patient data. */
function describeFailure(err: { message?: string; code?: string; constraint?: string } | undefined, fallback: unknown): string {
  if (err?.code && /^[0-9A-Z]{5}$/.test(err.code)) return `Database error ${err.code}${err.constraint ? ` (rule ${err.constraint})` : ""}`;
  return scrub(String(err?.message ?? fallback));
}

export interface Failure { kind: string; action?: string; status?: number; error: unknown }

/**
 * Records an unexpected failure in a transaction of its own and returns its
 * reference. `token` is the session cookie, which gives the clinic and user;
 * without one (or with an ended session) the failure is logged to the console only.
 */
export async function recordFailure(token: string | undefined, f: Failure, log?: FastifyBaseLogger): Promise<string> {
  const ref = newRef();
  const err = f.error as { message?: string; code?: string; constraint?: string; table?: string; stack?: string } | undefined;
  log?.error({ err: f.error, action: f.action, ref }, "unexpected failure");
  if (!logDb || !token) return ref;
  try {
    await logDb.transaction().execute(async (tx) => {
      const actor = await resumeSession(tx, hashToken(token));
      if (!actor) return;
      const stack = (err?.stack ?? "").split("\n").slice(1, 7).map((l) => l.trim().replace(/\(.*[\/]api[\/]/, "(")).join("\n");
      await sql`
        INSERT INTO system_log (level, kind, ref, action, status, message, detail)
        VALUES ('error', ${f.kind}, ${ref}, ${f.action ?? null}, ${f.status ?? 500}, ${describeFailure(err, f.error)},
                ${JSON.stringify({ code: err?.code ?? null, constraint: err?.constraint ?? null, table: err?.table ?? null, stack })}::jsonb)`.execute(tx);
    });
  } catch (e) {
    log?.error({ err: e, ref }, "could not write the system log");
  }
  return ref;
}

/** An accountable event (for example "export") inside the caller's own transaction. */
export async function recordEvent(tx: Tx, kind: string, action: string, message: string, detail: Record<string, unknown> = {}): Promise<void> {
  await sql`
    INSERT INTO system_log (level, kind, action, status, message, detail)
    VALUES ('info', ${kind}, ${action}, 200, ${scrub(message)}, ${JSON.stringify(detail)}::jsonb)`.execute(tx);
}

/** A failure worth an admin's attention found by a background job (not a request), in the caller's transaction. */
export async function recordJobFailure(tx: Tx, kind: string, action: string, message: string, detail: Record<string, unknown> = {}): Promise<string> {
  const ref = newRef();
  await sql`
    INSERT INTO system_log (level, kind, ref, action, status, message, detail)
    VALUES ('error', ${kind}, ${ref}, ${action}, 500, ${scrub(message)}, ${JSON.stringify(detail)}::jsonb)`.execute(tx);
  return ref;
}
