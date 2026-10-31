// The one-off move of existing files to a clinic's newly chosen backend.
//
// For each document not yet on the target: read it from where it is, check it
// against its recorded checksum (and size), write it to the target, read it back
// and check again, and only then point the row at the new place. Nothing is
// deleted from the old place, so a bad run costs nothing and the move can simply
// be run again. A document that fails is written to the system log with a
// reference and skipped; the rest carry on.
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { recordEvent, recordJobFailure } from "../syslog.js";
import { sha256Hex, storeFor, type Kind } from "./index.js";

export interface CopyResult {
  moved: number;
  failed: number;
  /** Documents still not on the target (failed ones included). */
  remaining: number;
  /** Pass back as `after` to continue past this batch (failed documents are not retried within one pass). */
  lastId: string | null;
  failures: { id: string; ref: string }[];
}

interface Doc {
  id: string; file_name: string; mime_type: string; category: string; uhid: string; full_name: string | null;
  storage_key: string; size_bytes: number; storage_backend: Kind; storage_ref: string | null; checksum_sha256: string | null;
}

export async function copyDocuments(tx: Tx, to: Kind, opts: { after?: string | null; limit?: number } = {}): Promise<CopyResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const target = await storeFor(tx, to);
  const docs = (await sql<Doc>`
    SELECT d.id, d.file_name, d.mime_type, d.category, d.uhid, p.full_name,
           d.storage_key, d.size_bytes, d.storage_backend, d.storage_ref, d.checksum_sha256
      FROM patient_documents d LEFT JOIN patients p ON p.id = d.patient_id
     WHERE d.storage_backend <> ${to} AND d.id > ${opts.after ?? "00000000-0000-0000-0000-000000000000"}::uuid
     ORDER BY d.id LIMIT ${limit} FOR UPDATE OF d SKIP LOCKED`.execute(tx)).rows;

  let moved = 0;
  const failures: CopyResult["failures"] = [];
  for (const d of docs) {
    try {
      const bytes = await (await storeFor(tx, d.storage_backend)).get(d.storage_key, d.storage_ref);
      const sum = sha256Hex(bytes);
      if (bytes.length !== d.size_bytes) throw new Error(`size is ${bytes.length} bytes, recorded ${d.size_bytes}`);
      if (d.checksum_sha256 && d.checksum_sha256 !== sum) throw new Error("source does not match its recorded checksum");
      const ref = await target.put(d.storage_key, bytes, {
        name: d.file_name, mime: d.mime_type, folder: [d.full_name ? `${d.uhid}_${d.full_name}` : d.uhid, d.category]
      });
      if (sha256Hex(await target.get(d.storage_key, ref)) !== sum) throw new Error("copy read back differently from what was written");
      await sql`UPDATE patient_documents SET storage_backend = ${to}, storage_ref = ${ref}, checksum_sha256 = ${sum} WHERE id = ${d.id}`.execute(tx);
      moved++;
    } catch (e) {
      const ref = await recordJobFailure(tx, "storage_copy", "copyDocuments", `Could not move document ${d.id} to ${to}: ${(e as Error).message}`,
        { documentId: d.id, from: d.storage_backend, to });
      failures.push({ id: d.id, ref });
    }
  }
  const remaining = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM patient_documents WHERE storage_backend <> ${to}`.execute(tx)).rows[0]!.n);
  if (docs.length) {
    await recordEvent(tx, "storage_copy", "copyDocuments", `Moved ${moved} of ${docs.length} documents to ${to}`, { moved, failed: failures.length, remaining });
  }
  return { moved, failed: failures.length, remaining, lastId: docs.length === limit ? docs[docs.length - 1]!.id : null, failures };
}
