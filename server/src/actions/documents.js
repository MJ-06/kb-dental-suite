// Patient documents: X-rays, scans, reports, and the printed prescription.
//
// The files themselves stay FILES. An X-ray does not belong inside a
// database — it belongs in a folder the backup copies, with a row here
// saying whose it is and what it is. That row is what makes it findable.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { query, tx } = require("../db");
const { nz, uhidOf, dateISO } = require("../util");

// One folder per patient, under a root the backup is pointed at.
const DOCS_ROOT = process.env.KB_DOCS_DIR || path.join(process.cwd(), "documents");

const actions = {};

function patientDir(uhid) {
  const dir = path.join(DOCS_ROOT, uhid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A file name from the browser is not a path. "../../etc/passwd" is a
// perfectly ordinary string until it is joined onto a directory.
function safeName(name) {
  return String(name || "file")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120) || "file";
}

actions.uploadPatientDocument = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A document needs a UHID" };
  const base64 = String(p.fileData || p.data || "").replace(/^data:[^;]*;base64,/, "");
  if (!base64) return { success: false, error: "No file was sent" };

  const bytes = Buffer.from(base64, "base64");
  const stored = `${Date.now()}-${safeName(p.fileName)}`;

  return tx(async (c) => {
    const known = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!known.rowCount) return { success: false, error: `Patient not found: ${uhid}` };
    // The row goes in first. If writing the row fails, no orphan file is
    // left on disk; if writing the file fails, the transaction rolls the row
    // back. The pair cannot come apart.
    const r = await c.query(
      `INSERT INTO patient_documents (uhid, file_name, mime_type, category, storage_ref, doc_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        uhid, safeName(p.fileName), String(p.mimeType || "application/octet-stream"),
        String(p.category || "Other"), path.join(uhid, stored), nz(p.docKey)
      ]
    );
    fs.writeFileSync(path.join(patientDir(uhid), stored), bytes);
    return { success: true, id: r.rows[0].id, fileName: safeName(p.fileName) };
  });
};

actions.getPatientDocuments = async (p) => {
  const r = await query(
    `SELECT id, file_name, mime_type, category, uploaded_at
       FROM patient_documents WHERE uhid = $1
      ORDER BY uploaded_at DESC`,
    [uhidOf(p.uhid)]
  );
  return {
    success: true,
    documents: r.rows.map((x) => ({
      id: x.id, fileName: x.file_name, mimeType: x.mime_type,
      category: x.category, uploadedAt: x.uploaded_at.toISOString(),
      date: dateISO(x.uploaded_at)
    }))
  };
};

actions.getPatientDocumentContent = async (p) => {
  const r = await query(
    "SELECT uhid, file_name, mime_type, storage_ref FROM patient_documents WHERE id = $1",
    [String(p.id)]
  );
  if (!r.rowCount) return { success: false, error: "Document not found" };
  const x = r.rows[0];
  const full = path.join(DOCS_ROOT, x.storage_ref);
  // The stored path is ours, but check it anyway: a row edited by hand must
  // not be able to read a file outside the documents folder.
  if (!path.resolve(full).startsWith(path.resolve(DOCS_ROOT) + path.sep)) {
    return { success: false, error: "Document not found" };
  }
  if (!fs.existsSync(full)) return { success: false, error: "The file is missing from the documents folder" };
  return {
    success: true,
    fileName: x.file_name,
    mimeType: x.mime_type,
    fileData: fs.readFileSync(full).toString("base64")
  };
};

actions.deletePatientDocument = async (p) => {
  return tx(async (c) => {
    const r = await c.query(
      "DELETE FROM patient_documents WHERE id = $1 RETURNING uhid, storage_ref", [String(p.id)]
    );
    if (!r.rowCount) return { success: false, error: "Document not found" };
    const full = path.join(DOCS_ROOT, r.rows[0].storage_ref);
    // The file goes to a .trash folder rather than away. A document deleted
    // by accident at the desk is otherwise gone, and these are X-rays.
    try {
      if (fs.existsSync(full)) {
        const trash = path.join(DOCS_ROOT, ".trash", r.rows[0].uhid);
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(full, path.join(trash, `${Date.now()}-${path.basename(full)}`));
      }
    } catch (e) {
      console.error("[documents] could not move the file to .trash:", e.message);
    }
    return { success: true };
  });
};

// ── the printed copy ─────────────────────────────────────────────────────
//
// A prescription is kept once. Pressing print again reprints the SAME
// document — it does not file a second one, which it used to, because the
// check now happens BEFORE the file is made and the key is a column with a
// unique index behind it.
function htmlToPdf(html) {
  return new Promise((resolve) => {
    // Chrome can do this with no extra software: the clinic PC has a
    // browser, and --headless --print-to-pdf is all this needs. If none is
    // found the HTML is kept instead, which still opens and still prints —
    // the document is never lost for want of a converter.
    const candidates = [
      process.env.KB_HTML_TO_PDF,
      "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ].filter(Boolean);
    const chrome = candidates.find((c) => { try { return fs.existsSync(c); } catch (_) { return false; } });
    if (!chrome) return resolve(null);

    const tmp = path.join(DOCS_ROOT, ".tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const stem = crypto.randomBytes(8).toString("hex");
    const htmlPath = path.join(tmp, `${stem}.html`);
    const pdfPath = path.join(tmp, `${stem}.pdf`);
    fs.writeFileSync(htmlPath, html);
    execFile(chrome, [
      "--headless", "--disable-gpu", "--no-sandbox",
      `--print-to-pdf=${pdfPath}`, "--no-pdf-header-footer",
      `file://${htmlPath}`
    ], { timeout: 30000 }, () => {
      let out = null;
      try { if (fs.existsSync(pdfPath)) out = fs.readFileSync(pdfPath); } catch (_) { out = null; }
      try { fs.unlinkSync(htmlPath); } catch (_) { /* best effort */ }
      try { fs.unlinkSync(pdfPath); } catch (_) { /* best effort */ }
      resolve(out);
    });
  });
}

actions.createDocumentPDF = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A document needs a UHID" };
  const html = String(p.html || p.content || "");
  if (!html) return { success: false, error: "Nothing was sent to save" };

  // The fingerprint of what is being printed. The browser sends one; if it
  // does not, the content is its own fingerprint.
  const docKey = nz(p.docKey) || crypto.createHash("sha256").update(html).digest("hex").slice(0, 32);

  const already = await query(
    "SELECT id, file_name FROM patient_documents WHERE uhid = $1 AND doc_key = $2",
    [uhid, docKey]
  );
  if (already.rowCount) {
    // Saved before. Say so plainly and hand back the one that exists.
    return { success: true, duplicate: true, id: already.rows[0].id, fileName: already.rows[0].file_name };
  }

  const pdf = await htmlToPdf(html);
  const isPdf = !!pdf;
  const base = safeName(p.fileName || "document").replace(/\.(pdf|html?)$/i, "");
  const stored = `${Date.now()}-${base}${isPdf ? ".pdf" : ".html"}`;

  return tx(async (c) => {
    const known = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!known.rowCount) return { success: false, error: `Patient not found: ${uhid}` };
    let r;
    try {
      r = await c.query(
        `INSERT INTO patient_documents (uhid, file_name, mime_type, category, storage_ref, doc_key)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, file_name`,
        [
          uhid, `${base}${isPdf ? ".pdf" : ".html"}`,
          isPdf ? "application/pdf" : "text/html",
          String(p.category || "Prescriptions"), path.join(uhid, stored), docKey
        ]
      );
    } catch (e) {
      // Two prints in the same second. The index refuses the second, which
      // is the point of it.
      if (e.constraint && e.constraint.includes("doc_key")) {
        const x = await query(
          "SELECT id, file_name FROM patient_documents WHERE uhid = $1 AND doc_key = $2",
          [uhid, docKey]
        );
        return { success: true, duplicate: true, id: x.rows[0].id, fileName: x.rows[0].file_name };
      }
      throw e;
    }
    fs.writeFileSync(path.join(patientDir(uhid), stored), isPdf ? pdf : html);
    return {
      success: true, duplicate: false, id: r.rows[0].id, fileName: r.rows[0].file_name,
      // Said out loud rather than guessed at: if no browser was found to
      // render it, the copy kept is HTML.
      format: isPdf ? "pdf" : "html"
    };
  });
};

module.exports = { actions, DOCS_ROOT, safeName };
