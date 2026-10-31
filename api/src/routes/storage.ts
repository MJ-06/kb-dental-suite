// The admin's storage setting: where this clinic's attachments live, a button to
// test it, and the one-off move of existing files. Credentials go in sealed and
// are never sent back; the page only learns that they are set.
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { asActor } from "../http/context.js";
import { HttpError } from "../http/errors.js";
import { parseCredential } from "../drive/client.js";
import { open, seal } from "../secrets.js";
import { buildBackend, type Kind } from "../storage/index.js";
import { copyDocuments } from "../storage/copy.js";
import type { AppOptions } from "../app.js";

// Administrators only: this decides where every patient file is kept.
const ADMIN = "roles:manage" as const;

const Remote = Type.Union([Type.Literal("s3"), Type.Literal("drive")]);
type Remote = "s3" | "drive";

interface Row {
  kind: Remote; config: Record<string, unknown>; secret_enc: string | null; active: boolean;
  last_check_at: string | null; last_check_ok: boolean | null; last_check_message: string | null;
}

const text = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Turns what the admin typed into stored config and secret, refusing anything unusable. */
function shape(kind: Remote, config: Record<string, unknown>, secret: Record<string, unknown> | undefined) {
  if (kind === "s3") {
    const cfg = {
      endpoint: text(config.endpoint, 300), region: text(config.region, 30), bucket: text(config.bucket, 63),
      prefix: text(config.prefix, 100), pathStyle: config.pathStyle !== false
    };
    const sec = secret && { accessKeyId: text(secret.accessKeyId, 128), secretAccessKey: text(secret.secretAccessKey, 256) };
    if (sec && (!sec.accessKeyId || !sec.secretAccessKey)) throw new HttpError(400, "invalid_request", "Enter both the access key and its secret");
    return { cfg, sec };
  }
  const cfg = { folderName: text(config.folderName, 120), folderId: text(config.folderId, 100) };
  let sec: unknown;
  if (secret) {
    try { sec = parseCredential(secret); } catch (e) { throw new HttpError(400, "invalid_request", (e as Error).message); }
  }
  return { cfg, sec };
}

function sealed(value: unknown): string {
  try { return seal(value); } catch (e) { throw new HttpError(503, "secrets_key_missing", (e as Error).message); }
}

async function rowOf(tx: Tx, kind: Remote): Promise<Row | undefined> {
  return (await sql<Row>`
    SELECT kind, config, secret_enc, active, last_check_at, last_check_ok, last_check_message
      FROM clinic_storage WHERE kind = ${kind}`.execute(tx)).rows[0];
}

export const storageRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, { db }) => {
  app.get("/", async (req) => asActor(db, req, ADMIN, async (tx) => {
    const rows = (await sql<Row>`
      SELECT kind, config, secret_enc, active, last_check_at, last_check_ok, last_check_message FROM clinic_storage`.execute(tx)).rows;
    const counts = (await sql<{ storage_backend: Kind; n: string }>`
      SELECT storage_backend, count(*) AS n FROM patient_documents GROUP BY 1`.execute(tx)).rows;
    const backends: Record<string, unknown> = {};
    for (const r of rows) {
      backends[r.kind] = {
        config: r.config, secretSet: !!r.secret_enc, active: r.active,
        lastCheck: r.last_check_at ? { at: r.last_check_at, ok: r.last_check_ok, message: r.last_check_message } : null
      };
    }
    return {
      active: rows.find((r) => r.active)?.kind ?? "local",
      backends,
      documents: Object.fromEntries(counts.map((c) => [c.storage_backend, Number(c.n)]))
    };
  }));

  // Save a backend's settings. Leaving the credentials out keeps the ones already stored.
  app.put("/:kind", {
    schema: {
      params: Type.Object({ kind: Remote }),
      body: Type.Object({ config: Type.Record(Type.String(), Type.Unknown()), secret: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false })
    }
  }, async (req) => asActor(db, req, ADMIN, async (tx) => {
    const kind = req.params.kind as Remote;
    const had = await rowOf(tx, kind);
    const { cfg, sec } = shape(kind, req.body.config, req.body.secret);
    if (!sec && !had?.secret_enc) throw new HttpError(400, "invalid_request", "Enter the sign-in details for this storage");
    const secretEnc = sec ? sealed(sec) : had!.secret_enc!;
    try { buildBackend(kind, cfg, open(secretEnc)); } catch (e) { throw new HttpError(400, "invalid_request", (e as Error).message); }
    await sql`
      INSERT INTO clinic_storage (kind, config, secret_enc) VALUES (${kind}, ${JSON.stringify(cfg)}::jsonb, ${secretEnc})
      ON CONFLICT (clinic_id, kind) DO UPDATE
        SET config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc,
            last_check_at = NULL, last_check_ok = NULL, last_check_message = NULL`.execute(tx);
    return { success: true };
  }));

  // Write and read back a tiny test file. Switching to a backend requires this to have passed.
  app.post("/:kind/check", { schema: { params: Type.Object({ kind: Remote }) } }, async (req) =>
    asActor(db, req, ADMIN, async (tx) => {
      const kind = req.params.kind as Remote;
      const row = await rowOf(tx, kind);
      if (!row?.secret_enc) throw new HttpError(404, "not_found", "That storage is not set up yet");
      let ok = true;
      let message: string;
      try { message = await buildBackend(kind, row.config, open(row.secret_enc)).check(); } catch (e) { ok = false; message = (e as Error).message; }
      await sql`UPDATE clinic_storage SET last_check_at = now(), last_check_ok = ${ok}, last_check_message = ${message.slice(0, 300)} WHERE kind = ${kind}`.execute(tx);
      return { success: ok, message };
    }));

  // Where new files go from now on. Existing files stay readable where they are until moved.
  app.post("/active", {
    schema: { body: Type.Object({ kind: Type.Union([Type.Literal("local"), Remote]) }, { additionalProperties: false }) }
  }, async (req) => asActor(db, req, ADMIN, async (tx) => {
    const kind = req.body.kind as Kind;
    if (kind !== "local") {
      const row = await rowOf(tx, kind);
      if (!row?.last_check_ok) throw new HttpError(409, "not_tested", "Run the test for this storage first; it has to pass before you switch");
    }
    await sql`UPDATE clinic_storage SET active = false WHERE active`.execute(tx);
    if (kind !== "local") await sql`UPDATE clinic_storage SET active = true WHERE kind = ${kind}`.execute(tx);
    return { success: true, active: kind };
  }));

  // Moves existing files, a batch at a time: call again with the returned `lastId` until it is null.
  app.post("/copy", {
    schema: {
      body: Type.Object({
        to: Type.Union([Type.Literal("local"), Remote]),
        after: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
      }, { additionalProperties: false })
    }
  }, async (req) => asActor(db, req, ADMIN, async (tx) => {
    const to = req.body.to as Kind;
    if (to !== "local") {
      const row = await rowOf(tx, to);
      if (!row?.last_check_ok) throw new HttpError(409, "not_tested", "Run the test for this storage first; it has to pass before files are moved");
    }
    return { success: true, ...(await copyDocuments(tx, to, { after: req.body.after, limit: req.body.limit })) };
  }));
};
