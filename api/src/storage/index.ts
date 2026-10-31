// Where uploaded files live, per clinic. Every clinic starts on the server's
// folder; an admin can switch to an S3-compatible bucket or to Google Drive.
// Callers ask storeFor(tx) and use the same put/get whichever it is.
//
// A document remembers its own backend, so switching never strands old files:
// reads go to wherever the file is (storeFor(tx, doc.storage_backend)), new
// writes go to the active one, and copyDocuments() moves the rest over.
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { open } from "../secrets.js";
import { driveBackend, type DriveConfig } from "./drive.js";
import { localBackend } from "./local.js";
import { s3Backend, type S3Config, type S3Secret } from "./s3.js";
import type { Backend, Kind } from "./types.js";

export { documentRoot } from "./local.js";
export type { Backend, Kind, PutOpts } from "./types.js";

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function buildBackend(kind: Kind, config: unknown, secret: unknown): Backend {
  if (kind === "local") return localBackend;
  if (kind === "s3") return s3Backend(config as S3Config, secret as S3Secret);
  return driveBackend(config as DriveConfig, secret);
}

interface Row { clinic_id: string; config: unknown; secret_enc: string | null; stamp: string }
const built = new Map<string, Backend>();

/** One query: the clinic's chosen backend, or the one named (to read a file where it actually is). */
export async function storeFor(tx: Tx, kind?: Kind): Promise<Backend> {
  if (kind === "local") return localBackend;
  const r = await sql<Row & { kind: Kind }>`
    SELECT clinic_id, kind, config, secret_enc, (version::text || ':' || extract(epoch FROM updated_at)::text) AS stamp
      FROM clinic_storage WHERE ${kind ? sql`kind = ${kind}` : sql`active`}`.execute(tx);
  const row = r.rows[0];
  if (!row) {
    if (kind) throw new Error(`Storage "${kind}" is not set up for this clinic`);
    return localBackend;
  }
  const id = `${row.clinic_id}:${row.kind}`;
  const stamp = `${id}:${row.stamp}`;
  const hit = built.get(stamp);
  if (hit) return hit;
  for (const k of built.keys()) if (k.startsWith(id + ":")) built.delete(k);
  const backend = buildBackend(row.kind, row.config, row.secret_enc ? open(row.secret_enc) : null);
  built.set(stamp, backend);
  return backend;
}

export async function activeKind(tx: Tx): Promise<Kind> {
  const r = await sql<{ kind: Kind }>`SELECT kind FROM clinic_storage WHERE active`.execute(tx);
  return r.rows[0]?.kind ?? "local";
}
