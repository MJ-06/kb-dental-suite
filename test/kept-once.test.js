// Printing a prescription keeps a PDF in the patient's Documents. Printing
// the SAME prescription again must not keep a second one.
//
// Deduped on a fingerprint of the document's own content, not on a flag in
// the form: the form can be closed and reopened between prints, and a flag
// would be gone while the document is unchanged. A prescription that has
// actually been edited is a different document and is kept.
const fs = require("fs");
const path = require("path");
const GS = fs.readFileSync(path.resolve(__dirname, "../apps-script/out/Code.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

function slice(marker) {
  const i = GS.indexOf(marker);
  if (i < 0) throw new Error("not found: " + marker);
  return GS.slice(i, GS.indexOf("\n}", i) + 2);
}
// The headers are a var, not a function, so they end at the "];" not a brace.
const HEADERS_SRC = (() => {
  const i = GS.indexOf("var PATIENT_DOCS_HEADERS = [");
  return GS.slice(i, GS.indexOf("];", i) + 2);
})();
const SRC = HEADERS_SRC + "\n" +
            slice("function patientDocsKeyCol_(") +
            slice("function findDocByKey_(") +
            slice("function createDocumentPDF(");

// A sheet and a Drive folder, just real enough.
function env(grid) {
  const g = (grid || []).map(r => r.slice());
  const made = [];
  const sheet = {
    grid: g,
    getLastRow: () => g.length,
    getLastColumn: () => g.reduce((n, r) => Math.max(n, r.length), 0),
    getDataRange: () => ({ getValues: () => g.map(r => r.slice()) }),
    appendRow: r => g.push(r.slice()),
    getRange(r, c) {
      return {
        getValues: () => [ (g[r - 1] || []).slice(c - 1) ],
        setValue(v) { while (!g[r - 1]) g.push([]); while (g[r - 1].length < c) g[r - 1].push(""); g[r - 1][c - 1] = v; }
      };
    }
  };
  const folder = { createFile: (blob) => { made.push(blob.getName()); return { getId: () => "drive" + made.length, setSharing() {} }; } };
  return { sheet, folder, made };
}
let uuid = 0;
function run(e, p) {
  return new Function("getSheet", "getPatientDocsFolder_", "SpreadsheetApp", "Utilities",
    "MimeType", "DriveApp", "DOC_INLINE_MAX_BYTES", "PATIENT_DOCS_SHEET", "__p",
    SRC + "\nreturn createDocumentPDF(__p);")(
    () => e.sheet,
    () => e.folder,
    { getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => "Asia/Kolkata" }) },
    { formatDate: () => "2026-10-26",
      getUuid: () => "id" + (++uuid),
      base64Encode: () => "b64",
      newBlob: (html, type, name) => ({
        getAs: () => ({ _n: name.replace(".html", ".pdf"),
                        setName(n) { this._n = n; },
                        getName() { return this._n; },
                        getBytes: () => [1, 2, 3] }) }) },
    { HTML: "text/html", PDF: "application/pdf" },
    { Access: { PRIVATE: 1 }, Permission: { NONE: 1 } },
    999999, "Patient Documents", p);
}

const doc = (key, html) => ({
  uhid: "KB0001", patientName: "Asha Verma", html: html || "<p>Paracetamol 500</p>",
  docName: "Prescription", category: "Prescriptions", dedupeKey: key
});

// ── printed once ─────────────────────────────────────────────────────────
let e = env([]);
let r = run(e, doc("k1"));
ok("the first print keeps a copy", r.success && !r.duplicate, JSON.stringify(r));
eq("one PDF was made", e.made.length, 1);
eq("and one row indexed", e.sheet.grid.length, 2);
ok("the file is named for the patient and the day",
   /^Prescription_KB0001_2026-10-26\.pdf$/.test(e.made[0]), e.made[0]);

// ── printed again, unchanged ─────────────────────────────────────────────
r = run(e, doc("k1"));
ok("printing it again keeps nothing further", r.success && r.duplicate, JSON.stringify(r));
eq("no second PDF was made", e.made.length, 1);
eq("and no second row", e.sheet.grid.length, 2);
ok("it hands back the copy already there", !!r.fileName, JSON.stringify(r));
// The check must come before any work: a reprint should cost neither a PDF
// nor a file in the patient's folder.
ok("and does that before making anything",
   GS.indexOf("Checked before anything is made") > 0 &&
   GS.indexOf("var already = findDocByKey_") < GS.indexOf("var pdf = Utilities.newBlob"));

// ── edited, then printed ─────────────────────────────────────────────────
r = run(e, doc("k2", "<p>Paracetamol 650</p>"));
ok("a prescription that has changed is kept", r.success && !r.duplicate, JSON.stringify(r));
eq("so there are two now", e.made.length, 2);

// ── another patient, same words ──────────────────────────────────────────
e = env([]);
run(e, doc("k1"));
r = run(e, { uhid: "KB0002", patientName: "B", html: "<p>Paracetamol 500</p>",
             docName: "Prescription", category: "Prescriptions", dedupeKey: "k1" });
ok("the same key for a different patient is a different document",
   r.success && !r.duplicate, JSON.stringify(r));
eq("and both are kept", e.made.length, 2);

// ── a book that predates the column ──────────────────────────────────────
e = env([["ID", "UHID", "File Name", "Mime Type", "Category", "Drive File ID", "URL", "Uploaded At"],
         ["old1", "KB0001", "Scan.pdf", "application/pdf", "Radiographs", "d0", "", "2026-01-01"]]);
r = run(e, doc("k9"));
ok("a Doc Key column is added rather than assumed", e.sheet.grid[0].indexOf("Doc Key") >= 0,
   JSON.stringify(e.sheet.grid[0]));
ok("the document is still kept", r.success && !r.duplicate);
eq("the row already there is not disturbed",
   e.sheet.grid[1].slice(0, 8),
   ["old1", "KB0001", "Scan.pdf", "application/pdf", "Radiographs", "d0", "", "2026-01-01"]);
r = run(e, doc("k9"));
ok("and from then on a reprint is recognised", r.duplicate === true, JSON.stringify(r));

// ── no key given ─────────────────────────────────────────────────────────
// Other callers do not send one, and must go on working exactly as before.
e = env([]);
run(e, { uhid: "KB0003", html: "<p>x</p>", docName: "Procedure Done", category: "Progress Notes" });
r = run(e, { uhid: "KB0003", html: "<p>x</p>", docName: "Procedure Done", category: "Progress Notes" });
eq("a caller that sends no fingerprint is never deduped", e.made.length, 2);
ok("and is not reported as a duplicate", !r.duplicate);

// ── nothing to keep ──────────────────────────────────────────────────────
e = env([]);
ok("no UHID is refused", !run(e, { html: "<p>x</p>", dedupeKey: "k" }).success);
ok("no content is refused", !run(e, { uhid: "KB1", dedupeKey: "k" }).success);
eq("and neither makes a file", e.made.length, 0);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
