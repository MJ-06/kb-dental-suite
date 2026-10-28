// Patient documents (scans, X-rays, reports) and generated PDFs, answering as
// the live Apps Script does. The file sits in storage under an opaque key;
// the screens address a document only by its id and never see where it is.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { htmlToPdf, PdfUnavailable } from "../pdf.js";
import { storage } from "../storage.js";
import { read, write, DeskError, type ActionTable } from "./types.js";
import { nz, str, uhidOf } from "./util.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Above this the viewer is told to download instead; base64 over /exec degrades past it.
const INLINE_MAX_BYTES = 7 * 1024 * 1024;

// A document is served back with the type stored here, and a page of the app
// can open it. So only types that cannot run anything are kept as they are;
// the rest are stored as an opaque download.
const SAFE_TYPES = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/tiff",
  "application/dicom", "text/plain", "text/csv", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

// What a printed document is filed as. It is not the caller's to choose: reception may make these PDFs,
// but only those with clinical access decide what else lives in a patient's folder.
const PDF_CATEGORY = "Progress Notes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const safeType = (v: unknown) => {
  const t = str(v).toLowerCase().split(";")[0]!.trim();
  return SAFE_TYPES.has(t) ? t : "application/octet-stream";
};

/** A name that is safe to show and to save under, whatever the browser sent. */
const safeName = (v: unknown, fallback: string) => {
  const cleaned = str(v).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").replace(/^[.\s-]+/, "").slice(0, 150).trim();
  return cleaned || fallback;
};

/** "x-ray.png" -> "x-ray_2026-10-28.png": still identifiable once it leaves the app. */
function stamped(name: string, day: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}_${day}${name.slice(dot)}` : `${name}_${day}`;
}

const mb = (n: number) => (n / 1048576).toFixed(1);

interface DocRow {
  id: string; uhid: string; file_name: string; mime_type: string; category: string;
  storage_key: string; size_bytes: number; uploaded: string;
}

async function fileAway(tx: Tx, clinicId: string, p: {
  uhid: string; name: string; mime: string; category: string; bytes: Buffer; docKey?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const key = `${clinicId}/${id}`;
  await storage.put(key, p.bytes);
  const patient = (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${p.uhid}`.execute(tx)).rows[0];
  await sql`
    INSERT INTO patient_documents (id, uhid, patient_id, file_name, mime_type, category, storage_key, size_bytes, doc_key)
    VALUES (${id}, ${p.uhid}, ${patient?.id ?? null}, ${p.name}, ${p.mime}, ${p.category}, ${key}, ${p.bytes.length}, ${p.docKey ?? null})`.execute(tx);
  return id;
}

async function today(tx: Tx): Promise<string> {
  return (await sql<{ d: string }>`SELECT clinic_today()::text AS d`.execute(tx)).rows[0]!.d;
}

export const documents: ActionTable = {
  uploadPatientDocument: write("clinical:write", async (p, { tx, actor }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid) return { success: false, error: "UHID required" };
    const raw = str(p.base64Data);
    if (!raw) return { success: false, error: "No file data received" };
    if (raw.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8) {
      return { success: false, error: `File is larger than the ${MAX_UPLOAD_BYTES / 1048576} MB limit` };
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return { success: false, error: "The file arrived damaged and was not saved" };
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length) return { success: false, error: "No file data received" };
    if (bytes.length > MAX_UPLOAD_BYTES) return { success: false, error: `File is larger than the 25 MB limit (${mb(bytes.length)} MB)` };

    const name = stamped(safeName(p.fileName, "document"), await today(tx));
    const id = await fileAway(tx, actor.clinicId, {
      uhid, name, mime: safeType(p.mimeType), category: str(p.category) || "Other", bytes
    });
    return { success: true, id, fileName: name };
  }),

  getPatientDocuments: read(async (p, { tx }) => {
    const r = await sql<DocRow>`
      SELECT id, uhid, file_name, mime_type, category,
             to_char(uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS uploaded
        FROM patient_documents WHERE upper(uhid) = ${uhidOf(p.uhid)} AND deleted_at IS NULL ORDER BY uploaded_at, id`.execute(tx);
    return {
      success: true,
      documents: r.rows.map((d) => ({
        id: d.id, uhid: d.uhid, fileName: d.file_name, mimeType: d.mime_type, category: d.category, uploadedAt: d.uploaded
      }))
    };
  }, "clinical:read"),

  // The caller names a document by id, never a file; when it also names a
  // patient, the document must be theirs.
  getPatientDocumentContent: read(async (p, { tx }) => {
    const id = str(p.id);
    if (!id) return { success: false, error: "Document id required" };
    const doc = UUID.test(id)
      ? (await sql<DocRow>`
          SELECT id, uhid, file_name, mime_type, storage_key, size_bytes
            FROM patient_documents WHERE id = ${id} AND deleted_at IS NULL`.execute(tx)).rows[0]
      : undefined;
    if (!doc) return { success: false, error: "Document not found" };
    const asked = uhidOf(p.uhid);
    if (asked && asked !== doc.uhid.toUpperCase()) return { success: false, error: "Document does not belong to this patient" };
    if (doc.size_bytes > INLINE_MAX_BYTES) {
      return {
        success: false, tooLarge: true, fileName: doc.file_name, sizeMB: mb(doc.size_bytes), maxMB: String(INLINE_MAX_BYTES / 1048576),
        error: `This file is ${mb(doc.size_bytes)} MB, above the ${INLINE_MAX_BYTES / 1048576} MB in-app viewing limit.`
      };
    }
    try {
      const bytes = await storage.get(doc.storage_key);
      return { success: true, fileName: doc.file_name, mimeType: doc.mime_type, uhid: doc.uhid, base64: bytes.toString("base64") };
    } catch {
      return { success: false, error: "File unavailable" };
    }
  }, "clinical:read"),

  // Taken out of the folder; the file stays in storage, so a mistake can be
  // undone by whoever looks after the server.
  deletePatientDocument: write("clinical:write", async (p, { tx, actor }) => {
    const id = str(p.id);
    if (!UUID.test(id)) return { success: false, error: "Document not found" };
    const r = await sql`
      UPDATE patient_documents SET deleted_at = now(), deleted_by = ${actor.userId}
       WHERE id = ${id} AND deleted_at IS NULL RETURNING id`.execute(tx);
    return r.rows.length ? { success: true } : { success: false, error: "Document not found" };
  }),

  createDocumentPDF: write("patients:write", async (p, { tx, actor }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid) return { success: false, error: "UHID required" };
    const html = str(p.html);
    if (!html) return { success: false, error: "No document content received" };

    // Only a patient on the register has documents filed under them.
    if (!(await sql`SELECT 1 FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows.length) return { success: false, error: "Patient not found" };

    // A reprint is recognised before anything is made, so it costs neither a PDF nor a second file.
    const key = str(p.dedupeKey);
    if (key) {
      const had = (await sql<{ file_name: string }>`
        SELECT file_name FROM patient_documents
         WHERE upper(uhid) = ${uhid} AND doc_key = ${key} AND deleted_at IS NULL`.execute(tx)).rows[0];
      if (had) return { success: true, duplicate: true, fileName: had.file_name };
    }

    let pdf: Buffer;
    try { pdf = await htmlToPdf(html); } catch (e) {
      if (e instanceof PdfUnavailable) throw new DeskError(e.message);
      throw e;
    }
    const name = `${safeName(p.docName, "Document")}_${uhid}_${await today(tx)}.pdf`;
    const id = await fileAway(tx, actor.clinicId, {
      uhid, name, mime: "application/pdf", category: PDF_CATEGORY, bytes: pdf, docKey: nz(key)
    });
    // Returned inline so the screen can save or attach it; no public link is made.
    return pdf.length <= INLINE_MAX_BYTES
      ? { success: true, id, fileName: name, base64: pdf.toString("base64") }
      : { success: true, id, fileName: name, tooLarge: true };
  })
};
