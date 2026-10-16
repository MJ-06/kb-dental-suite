// ============================================================
// KB DENTAL CLINICAL SUITE — Apps Script Backend v1
// Google Sheet: "KB Dental Clinical Data"
// Tabs Required:
//   Pending | Registrations | Care Plans | Treatment Plans |
//   Treatment Progress | Clinical Sheets | Daily Register |
//   Appointments | Consents | Signatures | Doctors
// ============================================================

var SS_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

// ── Where a registration lives ──────────────────────────────────
// Panel patients are registered and billed in their own book; everything else
// about them — clinical records, appointments, the UHID sequence — is shared
// with every other patient, because they are the same patients.
var PANEL_PMS_SHEET_ID = "1yg9Umwwkxao-RUwxXuycjG7CVXjRAQUmMvMHa_l6sjo";

// Every Registrations sheet the clinic has, for anything that reads: searching,
// the patient list, birthdays, duplicates and the UHID sequence must all see
// both books or a panel patient becomes invisible to the rest of the app.
//
// The panel book is opened, never created. If it is unreachable the clinic
// still works on the main book rather than failing outright — a receptionist
// cannot fix a sharing permission at the counter.
// Opening the panel book costs a round trip, and reading both Registrations
// sheets in full costs another two. Ten call sites do that, and the batched
// read runs several of them inside ONE request — so a single refresh was
// opening the panel book again and again and re-reading every registration
// each time. That is why the app got slower after the routing went in, not
// faster.
//
// Both are memoised for the length of one request. Apps Script gives every
// request its own execution, so these start empty for each caller and cannot
// serve one receptionist's data to another — the cache cannot outlive the
// request that filled it.
var _regSheetsCache = null;
var _regAllRowsCache = null;
// A write makes the cached table wrong, so it is dropped rather than left to
// answer the next read in the same request with the row it is missing.
function regCacheClear_() { _regSheetsCache = null; _regAllRowsCache = null; }

function regSheets_() {
  if (_regSheetsCache) return _regSheetsCache;
  var list = [getSheet("Registrations")];
  if (SS_ID === PANEL_PMS_SHEET_ID) { _regSheetsCache = list; return list; }
  try {
    var sh = SpreadsheetApp.openById(PANEL_PMS_SHEET_ID).getSheetByName("Registrations");
    if (sh) list.push(sh);
  } catch (e) {
    Logger.log("Panel book unreachable, carrying on with the main book: " + e.message);
  }
  _regSheetsCache = list;
  return list;
}

// Every registration in the clinic, from both books, as one table with one
// header row — the shape every reader here already expects, so each changes by
// one line rather than growing a loop of its own.
//
// The header row is the union of the two books: the panel book has Panel and
// Card ID columns the main book does not, and dropping them would make a panel
// patient look like an ordinary one everywhere they are listed. Columns are
// matched by name, never by position, because the two books drift.
function regAllRows_() {
  if (_regAllRowsCache) return _regAllRowsCache;
  var sheets = regSheets_();
  var base = sheets[0].getDataRange().getValues();
  if (!base.length) return [];
  var headers = base[0].slice();

  var extra = [];
  for (var k = 1; k < sheets.length; k++) {
    if (sheets[k].getLastRow() === 0) continue;
    var h = sheets[k].getRange(1, 1, 1, sheets[k].getLastColumn()).getValues()[0];
    for (var c = 0; c < h.length; c++) {
      if (h[c] && findRegColumn_(headers, [h[c]]) < 0 && extra.indexOf(h[c]) < 0) extra.push(h[c]);
    }
  }
  headers = headers.concat(extra);

  var out = [headers];
  function take(data) {
    if (data.length <= 1) return;
    var map = headers.map(function (hh) { return findRegColumn_(data[0], [hh]); });
    for (var r = 1; r < data.length; r++) {
      out.push(map.map(function (col) { return col >= 0 ? data[r][col] : ""; }));
    }
  }
  take(base);
  for (var i2 = 1; i2 < sheets.length; i2++) take(sheets[i2].getDataRange().getValues());
  _regAllRowsCache = out;
  return out;
}

// The sheet a NEW registration is written to. Only ever called once the UHID
// has been looked for in both books, so an existing patient is updated where
// they already are rather than copied into the other book.
function regSheetFor_(isPanel) {
  if (!isPanel || SS_ID === PANEL_PMS_SHEET_ID) return getSheet("Registrations");
  var ss = SpreadsheetApp.openById(PANEL_PMS_SHEET_ID);
  var sh = ss.getSheetByName("Registrations");
  if (!sh) sh = ss.insertSheet("Registrations");
  return sh;
}

// A column that does not exist swallows whatever is written to it, silently —
// findRegColumn_ returns -1 and the value is dropped. The panel fields are the
// claim, so the columns are added rather than assumed.
function ensureRegColumns_(sh, names) {
  if (sh.getLastRow() === 0) return;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var missing = names.filter(function (n) { return findRegColumn_(headers, [n]) < 0; });
  if (!missing.length) return;
  sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
}

function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

// ── Patient Documents (X-rays, scans, reports) ──────────────────
// Files live in Drive (a Sheet cell can't hold a scan/X-ray); only the
// metadata + Drive link is tracked in the "Patient Documents" sheet, so a
// document uploaded once stays viewable from the patient's folder at any time.
var PATIENT_DOCS_SHEET = "Patient Documents";
var PATIENT_DOCS_ROOT_FOLDER = "KB Dental - Patient Documents";

// Drive layout: <root>/<UHID_PatientName>/<Document Type>/ — grouping by
// patient first then by document type keeps a patient's whole record in one
// place while still separating X-rays from reports, consents, etc.
function getOrCreateChildFolder_(parent, name) {
  var safe = String(name || "Other").replace(/[\\\/:*?"<>|]/g, "-").trim() || "Other";
  var existing = parent.getFoldersByName(safe);
  return existing.hasNext() ? existing.next() : parent.createFolder(safe);
}

function getPatientDocsFolder_(uhid, patientName, category) {
  var root = DriveApp.getFoldersByName(PATIENT_DOCS_ROOT_FOLDER);
  var rootFolder = root.hasNext() ? root.next() : DriveApp.createFolder(PATIENT_DOCS_ROOT_FOLDER);
  var label = patientName ? (uhid + "_" + patientName) : String(uhid);
  var patientFolder = getOrCreateChildFolder_(rootFolder, label);
  return getOrCreateChildFolder_(patientFolder, category || "Other");
}

// ════════════════════════════════════════════════════════════
// RUN THIS ONCE, MANUALLY, AFTER DEPLOYING
// ════════════════════════════════════════════════════════════
// Document upload and PDF export were added after this script was first
// authorized, so the saved authorization has no Drive permission and every
// upload fails with "You do not have permission to call DriveApp...".
// Google only shows the consent screen when a function is run from the editor
// — a web-app request can't trigger it. So:
//   1. In the Apps Script editor, pick authorizeDriveAccess from the function
//      dropdown and press Run.
//   2. Approve the Google permission prompt (it will mention Drive access).
//   3. Re-deploy (Deploy → Manage deployments → New version).
// It only creates the documents folder, nothing else.
function authorizeDriveAccess() {
  var folders = DriveApp.getFoldersByName(PATIENT_DOCS_ROOT_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PATIENT_DOCS_ROOT_FOLDER);
  Logger.log("Drive access OK. Documents folder ready: " + folder.getName() + " (" + folder.getId() + ")");
  return "Drive access authorized. Folder: " + folder.getName();
}

var MAX_DOC_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// Apps Script can only hand a file back as base64 through ContentService — it
// cannot stream, and cannot mint time-limited signed Drive URLs. Base64 adds
// ~33%, and responses degrade badly past ~10 MB within the 6-minute execution
// limit. 7 MB raw (~9.4 MB encoded) is the safe ceiling for in-app viewing.
var DOC_INLINE_MAX_BYTES = 7 * 1024 * 1024;

// Serves a patient document's bytes to an authenticated session.
//
// IDOR protection: the caller supplies the document's SHEET row id, never a
// Drive file id. The Drive id is looked up server-side, so a caller cannot
// point this at an arbitrary Drive file, and cannot reach any file that is not
// a registered KuBi patient document. When a uhid is supplied it must match the
// document's own uhid, so one patient's record cannot serve another's file.
function getPatientDocumentContent(p) {
  var id = String(p.id || "").trim();
  if (!id) return { success: false, error: "Document id required" };

  var sh = getSheet(PATIENT_DOCS_SHEET);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== id) continue;

    var docUhid = String(data[i][1] || "").trim();
    var requestedUhid = String(p.uhid || "").trim();
    if (requestedUhid && requestedUhid.toUpperCase() !== docUhid.toUpperCase()) {
      return { success: false, error: "Document does not belong to this patient" };
    }

    var fileName = data[i][2] || "document";
    var mimeType = data[i][3] || "application/octet-stream";
    var driveId  = data[i][5];
    try {
      var file = DriveApp.getFileById(driveId);
      var size = file.getSize();
      if (size > DOC_INLINE_MAX_BYTES) {
        return {
          success: false, tooLarge: true, fileName: fileName,
          sizeMB: (size / 1048576).toFixed(1),
          maxMB: (DOC_INLINE_MAX_BYTES / 1048576).toFixed(0),
          error: "This file is " + (size / 1048576).toFixed(1) + " MB, above the "
               + (DOC_INLINE_MAX_BYTES / 1048576).toFixed(0) + " MB in-app viewing limit."
        };
      }
      return {
        success: true, fileName: fileName, mimeType: mimeType, uhid: docUhid,
        base64: Utilities.base64Encode(file.getBlob().getBytes())
      };
    } catch (e) {
      return { success: false, error: "File unavailable: " + e.message };
    }
  }
  return { success: false, error: "Document not found" };
}

function uploadPatientDocument(p) {
  var uhid = String(p.uhid || "").trim();
  if (!uhid) return { success: false, error: "UHID required" };
  if (!p.base64Data) return { success: false, error: "No file data received" };

  var bytes = Utilities.base64Decode(p.base64Data);
  if (bytes.length > MAX_DOC_UPLOAD_BYTES) {
    return { success: false, error: "File is larger than the 25 MB limit (" + (bytes.length / 1048576).toFixed(1) + " MB)" };
  }

  var category = p.category || "Other";
  var folder = getPatientDocsFolder_(uhid, p.patientName, category);

  // Stamp the upload date into the stored filename so the file is still
  // identifiable when viewed directly in Drive, outside the app.
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var original = String(p.fileName || "document");
  var dot = original.lastIndexOf(".");
  var base = dot > 0 ? original.substring(0, dot) : original;
  var ext = dot > 0 ? original.substring(dot) : "";
  var storedName = base + "_" + stamp + ext;

  var blob = Utilities.newBlob(bytes, p.mimeType || "application/octet-stream", storedName);
  var file = folder.createFile(blob);
  // PRIVATE, never ANYONE_WITH_LINK: a Drive "anyone with the link" URL is a
  // permanent, unauthenticated, non-revocable handle on a patient's X-ray.
  // Documents are served only via getPatientDocumentContent(), behind a session.
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);

  var sh = getSheet(PATIENT_DOCS_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(["ID", "UHID", "File Name", "Mime Type", "Category", "Drive File ID", "URL", "Uploaded At"]);
  var now = new Date().toISOString();
  var id = Utilities.getUuid();
  // URL column retained for schema compatibility with existing rows, but left
  // blank: no public URL is minted for new documents.
  sh.appendRow([id, uhid, storedName, p.mimeType || "", category, file.getId(), "", now]);

  return { success: true, id: id, fileName: storedName };
}

function getPatientDocuments(p) {
  var uhid = String(p.uhid || "").trim();
  var sh = getSheet(PATIENT_DOCS_SHEET);
  var data = sh.getDataRange().getValues();
  var docs = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === uhid) {
      // Neither the Drive file id nor any legacy public URL is sent to the
      // client: the browser addresses documents solely by their sheet row id,
      // so nothing reusable against Drive directly ever reaches the page.
      docs.push({
        id: data[i][0], uhid: data[i][1], fileName: data[i][2], mimeType: data[i][3],
        category: data[i][4], uploadedAt: data[i][7]
      });
    }
  }
  return { success: true, documents: docs };
}

// Renders a generated document (progress notes, etc.) to a real PDF in Drive
// and returns a shareable link. WhatsApp can't accept a file from a wa.me
// link — only text — so sharing a PDF means sharing its Drive URL, and that
// URL has to exist server-side before the message can be composed.
function createDocumentPDF(p) {
  var uhid = String(p.uhid || "").trim();
  if (!uhid) return { success: false, error: "UHID required" };
  if (!p.html) return { success: false, error: "No document content received" };

  var category = p.category || "Progress Notes";
  var folder = getPatientDocsFolder_(uhid, p.patientName, category);

  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var baseName = (p.docName || "Document") + "_" + uhid + "_" + stamp;

  var pdf = Utilities.newBlob(p.html, MimeType.HTML, baseName + ".html").getAs(MimeType.PDF);
  pdf.setName(baseName + ".pdf");
  var file = folder.createFile(pdf);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);

  // Also index it alongside uploaded documents so it shows up in the
  // patient's Documents tab instead of only existing in Drive.
  var sh = getSheet(PATIENT_DOCS_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(["ID", "UHID", "File Name", "Mime Type", "Category", "Drive File ID", "URL", "Uploaded At"]);
  var id = Utilities.getUuid();
  sh.appendRow([id, uhid, baseName + ".pdf", "application/pdf", category, file.getId(), "", new Date().toISOString()]);

  // Returned inline so the caller can save/attach it directly — no public link
  // is created, so patient-facing sharing is done by attaching the file itself.
  var pdfBytes = pdf.getBytes();
  var out = { success: true, id: id, fileName: baseName + ".pdf" };
  if (pdfBytes.length <= DOC_INLINE_MAX_BYTES) out.base64 = Utilities.base64Encode(pdfBytes);
  else out.tooLarge = true;
  return out;
}

// ════════════════════════════════════════════════════════════
// ONE-TIME MIGRATION — revoke public sharing on existing documents
// ════════════════════════════════════════════════════════════
// Files uploaded before this change carry ANYONE_WITH_LINK, i.e. permanent
// public URLs. Run from the Apps Script editor:
//   1. migrateDocumentSharing_DryRun()   — inspects only, changes NOTHING
//   2. migrateDocumentSharing_EXECUTE()  — revokes public access
// Both walk the patient-documents folder tree, write a per-file report to the
// "Document Migration Report" sheet, and never delete, move or rename a file.
// Ownership, folder structure and sheet metadata are untouched.

var DOC_MIGRATION_REPORT_SHEET = "Document Migration Report";

function migrateDocumentSharing_DryRun()  { return migrateDocumentSharing_(true); }
function migrateDocumentSharing_EXECUTE() { return migrateDocumentSharing_(false); }

function migrateDocumentSharing_(dryRun) {
  var roots = DriveApp.getFoldersByName(PATIENT_DOCS_ROOT_FOLDER);
  if (!roots.hasNext()) return "No '" + PATIENT_DOCS_ROOT_FOLDER + "' folder found — nothing to migrate.";
  var root = roots.next();

  var report = [];
  var stats = { scanned: 0, public: 0, changed: 0, alreadyPrivate: 0, failed: 0 };

  function walk(folder, path) {
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      stats.scanned++;
      var access = "UNKNOWN", action = "", err = "";
      try {
        access = String(f.getSharingAccess());
        if (access === "ANYONE" || access === "ANYONE_WITH_LINK") {
          stats.public++;
          if (dryRun) {
            action = "WOULD REVOKE";
          } else {
            f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
            action = "REVOKED";
            stats.changed++;
          }
        } else {
          stats.alreadyPrivate++;
          action = "already private";
        }
      } catch (e) {
        stats.failed++; action = "FAILED"; err = e.message;
      }
      report.push([path, f.getName(), f.getId(), access, action, err]);
    }
    var subs = folder.getFolders();
    while (subs.hasNext()) { var s = subs.next(); walk(s, path + "/" + s.getName()); }
  }

  walk(root, root.getName());

  var sh = getSheet(DOC_MIGRATION_REPORT_SHEET);
  sh.clearContents();
  sh.appendRow(["Run", dryRun ? "DRY RUN (no changes made)" : "EXECUTED", new Date().toISOString(), "", "", ""]);
  sh.appendRow(["Folder Path", "File Name", "Drive File ID", "Sharing Before", "Action", "Error"]);
  if (report.length) sh.getRange(sh.getLastRow() + 1, 1, report.length, 6).setValues(report);

  var summary = (dryRun ? "DRY RUN — no changes made. " : "EXECUTED. ")
    + "Scanned " + stats.scanned + " file(s); "
    + stats.public + " publicly shared; "
    + (dryRun ? stats.public + " would be revoked; " : stats.changed + " revoked; ")
    + stats.alreadyPrivate + " already private; "
    + stats.failed + " failed. Full report in the '" + DOC_MIGRATION_REPORT_SHEET + "' sheet.";
  Logger.log(summary);
  return summary;
}

var DOC_CATEGORIES_SHEET = "Document Categories";
var DEFAULT_DOC_CATEGORIES = [
  "X-Ray / RVG", "OPG", "CBCT", "Blood Reports", "Clinical Photograph",
  "Digital Scan", "Prescription (Scanned PDF)", "Referral Letter", "Consent Form (Scanned PDF)"
];

// ── Guard for every list save ────────────────────────────────
// A save used to clear the tab and THEN look at what it had been given. If
// the payload never arrived, or arrived cut short, JSON.parse threw, the list
// came out empty — and the tab had already been emptied. Every doctor, every
// employee, gone, and { success: true } sent back, so the app had nothing to
// show and the loss only surfaced at the next refresh.
//
// This parses first and refuses to touch the sheet unless it holds a real
// list. An empty list is still allowed: removing the last row is a thing the
// clinic may legitimately do. What is refused is a payload that is missing or
// damaged, which is not the same thing and must never be read as "delete
// everything".
function parseList_(raw, label) {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === "") {
    return { __bad: "the " + label + " never reached the sheet" };
  }
  var arr;
  try { arr = JSON.parse(raw); }
  catch (e) {
    return { __bad: "the " + label + " arrived damaged — " + String(raw).length +
                    " characters, cut short in transit" };
  }
  if (!Array.isArray(arr)) return { __bad: "the " + label + " was not a list" };
  return arr;
}

function getDocumentCategoriesList() {
  var sh = getSheet(DOC_CATEGORIES_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(["Category", "Updated At"]);
    var now = new Date().toISOString();
    DEFAULT_DOC_CATEGORIES.forEach(function(c) { sh.appendRow([c, now]); });
  }
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  return { success: true, categories: items };
}

function saveDocumentCategoriesList(p) {
  var arr = parseList_(p.categories, "document categories");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet(DOC_CATEGORIES_SHEET);
  sh.clearContents();
  sh.appendRow(["Category", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(v) { sh.appendRow([v, now]); });
  return { success: true };
}

function deletePatientDocument(p) {
  var sh = getSheet(PATIENT_DOCS_SHEET);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.id)) {
      try { DriveApp.getFileById(data[i][5]).setTrashed(true); } catch (e) {}
      sh.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, error: "Document not found" };
}

// ── CORS wrapper ─────────────────────────────────────────────
function doGet(e) {
  var result = route(e.parameter);
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var params = {};
  try { params = JSON.parse(e.postData.contents); } catch(x) {}
  var result = route(params);
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Router ───────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
// STAFF AUTH — session tokens for the /exec endpoint
// ════════════════════════════════════════════════════════════
// Setup (Project Settings → Script Properties):
//   APP_PASSWORD  = the shared staff password for signing in to the app
//   REQUIRE_AUTH  = "true" to start enforcing (leave unset/false to roll out safely)
//
// REQUIRE_AUTH defaults to OFF so deploying this can't lock anyone out: turn
// it on only once you've confirmed logging in works. A token is never stored
// in the page source — it's issued per sign-in and expires — so knowing the
// /exec URL alone is no longer enough to read patient data.

var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
// Always session-protected, even while the global rollout flag is off.
var DOCUMENT_ACTIONS = [
  "uploadPatientDocument", "getPatientDocuments", "deletePatientDocument",
  "getPatientDocumentContent", "createDocumentPDF"
];

var PUBLIC_ACTIONS = [
  "staffLogin", "staffLogout", "authStatus", "ping",
  // Patient-facing (chatbot.html) — these users have no login by design.
  "chatbotReply", "saveChatbotAppointment", "findAppointmentsByPhone",  "patientLookup", "patientCompleteRegistration"
];

function authRequired_() {
  return String(PropertiesService.getScriptProperties().getProperty("REQUIRE_AUTH") || "").toLowerCase() === "true";
}

function getSessions_() {
  var raw = PropertiesService.getScriptProperties().getProperty("SESSIONS");
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function saveSessions_(sessions) {
  PropertiesService.getScriptProperties().setProperty("SESSIONS", JSON.stringify(sessions));
}

// Drops expired tokens so the stored session map can't grow without bound.
function pruneSessions_(sessions) {
  var now = new Date().getTime();
  Object.keys(sessions).forEach(function(k) {
    if (!sessions[k] || sessions[k] < now) delete sessions[k];
  });
  return sessions;
}

function isValidSession_(token) {
  if (!token) return false;
  var sessions = getSessions_();
  var expiry = sessions[String(token)];
  return !!(expiry && expiry > new Date().getTime());
}

function staffLogin(p) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty("APP_PASSWORD") || props.getProperty("MASTER_PASSWORD");
  if (!expected) return { success: false, error: "No APP_PASSWORD set in Script Properties" };
  if (String(p.password || "") !== String(expected)) return { success: false, error: "Incorrect password" };

  var token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  var sessions = pruneSessions_(getSessions_());
  var expiresAt = new Date().getTime() + SESSION_TTL_MS;
  sessions[token] = expiresAt;
  saveSessions_(sessions);
  return { success: true, token: token, expiresAt: expiresAt };
}

function staffLogout(p) {
  var sessions = getSessions_();
  if (p.token && sessions[String(p.token)]) {
    delete sessions[String(p.token)];
    saveSessions_(sessions);
  }
  return { success: true };
}

// Every api() call from the browser is its own HTTPS request, and Apps Script
// charges roughly a second of start-up for each one as well as limiting how
// many run at once for a single user. The Master page asks for eighteen lists,
// so they queued and took far longer to appear than the amount of data
// warranted. This runs them inside one invocation.
//
// It re-enters route() per action rather than special-casing anything, so each
// action keeps its own auth check and its own behaviour. One action failing is
// reported against that action and does not spoil the rest.
var BATCH_MAX = 25;
function batchRead_(p) {
  var names = [];
  try { names = JSON.parse(p.actions || "[]"); } catch (e) { names = []; }
  if (!names.length) return { success: false, error: "batch: no actions given" };
  if (names.length > BATCH_MAX) {
    return { success: false, error: "batch: at most " + BATCH_MAX + " actions, got " + names.length };
  }
  var out = {};
  for (var i = 0; i < names.length; i++) {
    // An entry is either a bare action name or {key, action, params}. Only the
    // parameterless reads could batch before, which left every read carrying a
    // UHID or a date — the patient screens, in other words — making its own
    // request. Those are the ones the clinic was waiting on.
    var entry = names[i];
    var isObj = entry && typeof entry === "object";
    var name  = String((isObj ? entry.action : entry) || "").trim();
    // The key is how the browser finds its answer: the same action asked twice
    // with different parameters must not overwrite itself in the result.
    var key   = String((isObj && entry.key) || name);

    // No batch inside a batch — it buys nothing and makes the depth unbounded.
    if (!name || name === "batch") { out[key || "?"] = { success: false, error: "batch: not allowed" }; continue; }
    // Reads only. A half-applied batch of writes is a worse problem than a
    // slow page, and nothing this is for needs to write.
    if (name.indexOf("get") !== 0) { out[key] = { success: false, error: "batch: reads only" }; continue; }

    var payload = { action: name, token: p.token };
    if (isObj && entry.params && typeof entry.params === "object") {
      Object.keys(entry.params).forEach(function (k) {
        // action and token are the batch's own, never the caller's: letting an
        // entry set them would let one read impersonate another, or carry a
        // different session than the request was authorised with.
        if (k !== "action" && k !== "token") payload[k] = entry.params[k];
      });
    }
    try {
      out[key] = route(payload);
    } catch (err) {
      out[key] = { success: false, error: String((err && err.message) || err) };
    }
  }
  return { success: true, results: out };
}

function route(p) {
  try {
    // Patient documents (X-rays, scans, reports) ALWAYS require a valid session,
    // regardless of the global REQUIRE_AUTH rollout flag. These files are no
    // longer reachable by a public Drive link, so this endpoint is the only way
    // to them — leaving it open would simply move the exposure, not remove it.
    if (DOCUMENT_ACTIONS.indexOf(p.action) >= 0 && !isValidSession_(p.token)) {
      return { success: false, error: "AUTH_REQUIRED", authRequired: true };
    }

    // Gate every clinical/patient-data action behind a valid staff session.
    // Only the patient-facing chatbot endpoints and login itself stay open —
    // patients using chatbot.html have no account to log in with.
    if (authRequired_() && PUBLIC_ACTIONS.indexOf(p.action) < 0 && !isValidSession_(p.token)) {
      return { success: false, error: "AUTH_REQUIRED", authRequired: true };
    }

    switch (p.action) {

      // ── Several reads in one round trip ────────────────────
      case "batch":       return batchRead_(p);

      // ── Auth ───────────────────────────────────────────────
      case "staffLogin":  return staffLogin(p);
      case "staffLogout": return staffLogout(p);
      case "authStatus":  return { success: true, authRequired: authRequired_(), valid: isValidSession_(p.token) };

      // ── Health ─────────────────────────────────────────────
      case "ping":
        return { success: true, message: "pong", timestamp: new Date().toISOString() };
      case "debugSheetHeaders": return debugSheetHeaders(p);

      // ── Registration ───────────────────────────────────────
      case "getNextUHID":       return getNextUHID();
      case "checkDuplicate":    return checkDuplicate(p);
      case "saveRegistration":  return saveRegistration(p);
      case "patientLookup":     return patientLookup(p);
      case "patientCompleteRegistration": return patientCompleteRegistration(p);
      case "getPending":        return getPending();
      case "getPatient":        return getPatient(p);
      case "getAllPatients":     return getAllPatients();
      case "searchPatients":    return searchPatients(p);
      case "getTodaysBirthdays": return getTodaysBirthdays();
      case "getFollowUps":       return getFollowUps();

      // ── Patient Documents ───────────────────────────────────
      case "uploadPatientDocument": return uploadPatientDocument(p);
      case "getPatientDocuments":   return getPatientDocuments(p);
      case "deletePatientDocument": return deletePatientDocument(p);
      case "getDocumentCategoriesList":  return getDocumentCategoriesList();
      case "saveDocumentCategoriesList": return saveDocumentCategoriesList(p);
      case "createDocumentPDF":         return createDocumentPDF(p);
      case "getPatientDocumentContent": return getPatientDocumentContent(p);

      // ── Care Plan ──────────────────────────────────────────
      case "getCarePlan":       return getCarePlan(p);
      case "saveCarePlan":      return saveCarePlan(p);

      // ── Treatment Plan ─────────────────────────────────────
      case "getTreatmentPlan":  return getTreatmentPlan(p);
      case "saveTreatmentPlan": return saveTreatmentPlan(p);

      // ── Treatment Progress (read-only — pulls from Daily Register) ──
      case "getTreatmentProgress":  return getTreatmentProgress(p);

      // ── Clinical Sheets ────────────────────────────────────
      case "getClinicalSheets":  return getClinicalSheets(p);
      case "saveClinicalSheets": return saveClinicalSheets(p);

      // ── Daily Register ─────────────────────────────────────
      case "getDailyRegister":   return getDailyRegister(p);
      case "saveToDailyRegister": return saveToDailyRegister(p);

      // ── Clinical Records ──────────────────────────────────
      case "getClinicalRecords":    return getClinicalRecords(p);
      case "savePathology":         return savePathology(p);
      case "saveRadiology":         return saveRadiology(p);
      case "saveRadiograph":        return saveRadiograph(p);
      case "saveLocalAnesthesia":   return saveLocalAnesthesia(p);
      case "saveIntraOralScanning": return saveIntraOralScanning(p);
      case "saveScaling":           return saveScaling(p);
      case "saveMinorSurgery":      return saveMinorSurgery(p);
      case "saveTMJoint":           return saveTMJoint(p);
      case "saveRestoration":       return saveRestoration(p);
      case "saveOrthodontics":      return saveOrthodontics(p);
      case "saveOrthodonticsProgress": return saveOrthodonticsProgress(p);
      case "saveDenture":           return saveDenture(p);
      case "savePedo":              return savePedo(p);
      case "saveLabLog":            return saveLabLog(p);

      // ── Appointments ───────────────────────────────────────
      case "getAppointments":         return getAppointments(p);
      case "saveAppointment":         return saveAppointment(p);
      case "updateAppointmentStatus": return updateAppointmentStatus(p);
      case "updateAppointment":       return updateAppointment(p);
      case "deleteAppointment":       return deleteAppointment(p);
      case "getReasonsList":          return getReasonsList();
      case "saveReasonsList":         return saveReasonsList(p);
      case "getBlockedSlots":         return getBlockedSlots(p);
      case "saveBlockedSlot":         return saveBlockedSlot(p);
      case "deleteBlockedSlot":       return deleteBlockedSlot(p);

      // ── Multi-visit treatment tracking (Treatment Cases) ────
      case "getProcedureLibrary":     return getProcedureLibrary();
      case "saveProcedureLibrary":    return saveProcedureLibrary(p);
      case "startTreatmentCase":      return startTreatmentCase(p);
      case "getOpenCase":             return getOpenCase(p);
      case "getCaseState":            return getCaseState(p);
      case "resolveStageOutcome":     return resolveStageOutcome(p);
      case "appendCaseStage":         return appendCaseStage(p);

      // ── Consents ───────────────────────────────────────────
      case "saveConsent":      return saveConsent(p);

      // ── Signatures ─────────────────────────────────────────
      case "getSignatures":    return getSignatures();
      case "saveSignature":    return saveSignature(p);

      // ── Doctors ────────────────────────────────────────────

      // ── Finance ────────────────────────────────────────────
      case "getReceipts":          return getReceipts(p);
      case "saveReceipt":          return saveReceipt(p);
      case "getDailyCollection":   return getDailyCollection(p);
      case "getPatientOutstanding":return getPatientOutstanding(p);
      case "getOutstandingList":   return getOutstandingList(p);
      case "getFinanceSummary":    return getFinanceSummary(p);
      case "getProfitLoss":        return getProfitLoss(p);
      case "getExpenses":              return getExpenses(p);
      case "saveExpense":              return saveExpense(p);
      case "deleteExpense":            return deleteExpense(p);
      case "getExpenseCategoriesList": return getExpenseCategoriesList();
      case "saveExpenseCategoriesList":return saveExpenseCategoriesList(p);
      case "getTreatmentsMaster":      return getTreatmentsMaster();
      case "saveTreatmentsMaster":     return saveTreatmentsMaster(p);
      case "getMedicinesMaster":       return getMedicinesMaster();
      case "saveMedicinesMaster":      return saveMedicinesMaster(p);
      case "getImplantBrandsList":         return getImplantBrandsList();
      case "saveImplantBrandsList":       return saveImplantBrandsList(p);
      case "getMedicineDosagesList":       return getMedicineDosagesList();
      case "saveMedicineDosagesList":      return saveMedicineDosagesList(p);
      case "getMedicineFrequenciesList":   return getMedicineFrequenciesList();
      case "saveMedicineFrequenciesList":  return saveMedicineFrequenciesList(p);
      case "getMedicineDurationsList":     return getMedicineDurationsList();
      case "saveMedicineDurationsList":    return saveMedicineDurationsList(p);
      case "getMedicineInstructionsList":  return getMedicineInstructionsList();
      case "saveMedicineInstructionsList": return saveMedicineInstructionsList(p);
      case "getMedicineNotesList":         return getMedicineNotesList();
      case "saveMedicineNotesList":        return saveMedicineNotesList(p);
      case "getClinicProfile":             return getClinicProfile();
      case "saveClinicProfile":            return saveClinicProfile(p);
      case "savePrescription":         return savePrescription(p);
      case "getDoctorDetailsList":     return getDoctorDetailsList();
      case "saveDoctorDetailsList":    return saveDoctorDetailsList(p);
      case "getEmployeesList":         return getEmployeesList();
      case "saveEmployeesList":        return saveEmployeesList(p);
      case "getPaymentModesList":      return getPaymentModesList();
      case "savePaymentModesList":     return savePaymentModesList(p);
      case "getPanelRates":           return getPanelRates(p);
      case "savePanelRates":          return savePanelRates(p);
      case "getPanelsList":            return getPanelsList();
      case "savePanelsList":           return savePanelsList(p);
      case "getChairsList":            return getChairsList();
      case "saveChairsList":           return saveChairsList(p);
      case "getClinicalNoteTemplates":  return getClinicalNoteTemplates();
      case "saveClinicalNoteTemplates": return saveClinicalNoteTemplates(p);
      case "getSettings":          return getSettings();
      case "saveSettings":         return saveSettings(p);
      case "saveFinancePassword":  return saveFinancePassword(p);
      case "verifyFinancePassword":return verifyFinancePassword(p);
      case "saveMasterPassword":   return saveMasterPassword(p);
      case "verifyMasterPassword": return verifyMasterPassword(p);
      case "saveReportsPassword":  return saveReportsPassword(p);
      case "verifyReportsPassword": return verifyReportsPassword(p);

      // ── SOAP Notes (AI) ────────────────────────────────────
      case "generateSOAPNotes": return generateSOAPNotes(p);

      // ── Patient Chatbot ────────────────────────────────────
      case "chatbotReply":              return chatbotReply(p);
      case "saveChatbotAppointment":    return saveChatbotAppointment(p);
      case "findAppointmentsByPhone":   return findAppointmentsByPhone(p);

      default:
        return { success: false, error: "Unknown action: " + p.action };
    }
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════
// REGISTRATION
// ════════════════════════════════════════════════════════════

// UHID format: two-letter year code + 2-digit month + that month's running
// number. The year code started at AA for 2015 and advances one letter a year,
// so 2026 is AL — AL0777 is the 77th new patient of July 2026. The number
// restarts at 01 on the 1st of every month.
function uhidYearCode_(year) {
  var i = year - 2015;
  if (i < 0) i = 0;
  return String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
}

function getNextUHID() {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var now = new Date();
  var prefix = uhidYearCode_(Number(Utilities.formatDate(now, tz, "yyyy")))
             + Utilities.formatDate(now, tz, "MM");

  // Read the highest number already issued this month instead of counting
  // rows: a row deleted for any reason would otherwise send the counter
  // backwards and reissue a UHID that already belongs to a patient.
  var data = regAllRows_();
  var highest = 0;
  if (data.length > 1) {
    var uhidCol = findRegColumn_(data[0], ["UHID", "Registration ID"]);
    if (uhidCol >= 0) {
      for (var i = 1; i < data.length; i++) {
        var v = String(data[i][uhidCol] || "").trim().toUpperCase();
        if (v.indexOf(prefix) !== 0) continue;
        var n = parseInt(v.substring(prefix.length), 10);
        if (!isNaN(n) && n > highest) highest = n;
      }
    }
  }

  // Two digits normally (AL0801 … AL0899); a month busy enough to pass 99
  // simply grows to three (AL08100) rather than wrapping or colliding.
  return { success: true, uhid: prefix + String(highest + 1).padStart(2, "0") };
}

// Finds a Registrations-sheet column by fuzzy-matching against one or more
// candidate header names — the sheet's real headers are legacy Google Form
// labels (e.g. "Mobile No.", "Complete Address") that don't match the app's
// own short field names, so every read/write here must resolve dynamically
// rather than assume a fixed column order. Returns -1 if none match.
function findRegColumn_(headers, candidates) {
  for (var c = 0; c < candidates.length; c++) {
    var want = String(candidates[c]).toLowerCase().replace(/[^a-z0-9]/g, "");
    for (var i = 0; i < headers.length; i++) {
      var have = String(headers[i]).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (have === want || have.indexOf(want) >= 0) return i;
    }
  }
  return -1;
}

// A person, not a phone number, is what makes a duplicate. This used to match
// on mobile alone — which blocked registering a second family member (very
// common with elderly patients sharing one phone) as a "duplicate" of the
// first, refusing them their own UHID. Name + date of birth is what actually
// identifies a patient here; mobile is no longer part of the check.
function normaliseRegName_(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function checkDuplicate(p) {
  var data = regAllRows_();
  if (data.length <= 1) return { success: true, duplicate: false };
  var headers = data[0];
  var uhidCol = findRegColumn_(headers, ["UHID", "Registration ID"]);
  var nameCol = findRegColumn_(headers, ["Full Name", "Name"]);
  var dobCol = findRegColumn_(headers, ["Date of Birth", "DOB"]);
  if (nameCol < 0 || dobCol < 0) return { success: true, duplicate: false };
  var name = normaliseRegName_(p.name);
  var dob = formatDOB(p.dob);
  if (!name || !dob) return { success: true, duplicate: false };
  for (var i = 1; i < data.length; i++) {
    if (normaliseRegName_(data[i][nameCol]) === name && formatDOB(data[i][dobCol]) === dob) {
      return {
        success: true, duplicate: true,
        existingUHID: uhidCol >= 0 ? data[i][uhidCol] : "",
        existingName: nameCol >= 0 ? data[i][nameCol] : ""
      };
    }
  }
  return { success: true, duplicate: false };
}

// Maps the app's own field names onto whatever column each one actually
// lives in on the real sheet (see findRegColumn_ above), then either
// overwrites the existing row for that UHID in place, or appends a new one —
// previously this always appended using a hardcoded, WRONG column order,
// which both duplicated edited patients as extra rows and scrambled every
// field into the wrong column (UHID landing under Timestamp, etc.).
function saveRegistration(p) {
  removePending(p.mobile);

  // An existing UHID is updated where it already lives, whichever book that
  // is. This is what makes the iPad form safe: it is opened from a link, knows
  // nothing about panels, and would otherwise write a second row for a panel
  // patient into the main book and split one patient across two books.
  var sh = null;
  var existingRow = -1;
  var want = String(p.uhid || "").trim().toUpperCase();
  if (want) {
    var books = regSheets_();
    for (var b = 0; b < books.length && existingRow < 0; b++) {
      var bd = books[b].getDataRange().getValues();
      if (bd.length <= 1) continue;
      var bc = findRegColumn_(bd[0], ["UHID", "Registration ID"]);
      if (bc < 0) continue;
      for (var r = 1; r < bd.length; r++) {
        if (String(bd[r][bc]).trim().toUpperCase() === want) {
          sh = books[b]; existingRow = r + 1; break;
        }
      }
    }
  }
  // Only a genuinely new patient is routed by what the front desk chose.
  var isPanel = String(p.patientType || "") === "Panel";
  if (!sh) sh = regSheetFor_(isPanel);
  if (isPanel) ensureRegColumns_(sh, ["Patient Type", "Panel", "Panel Category", "Card ID"]);

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "Timestamp","UHID","Full Name","Gender","Date of Birth","Blood Group","Occupation",
      "Marital Status","Complete Address","Mobile No.","WhatsApp No.","Email",
      "In Case Of Emergency Contact Person","In Case Of Emergency Contact Number",
      "Have you ever suffered/suffering from any of the following?",
      "Medicines you are taking currently:",
      "Are you allergic to any of the following?","How did you know about this clinic?",
      "What is your chief complaint?","Are you in Pain?",
      "What is your level of pain on a scale of 0-10?","Relation with Person",
      "Patient Type","Panel","Panel Category","Card ID"
    ]);
  }

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var habitsStr = String(p.habits || "");
  var fieldToValue = {
    "UHID": p.uhid,
    "Full Name|Name": p.name,
    "Gender": p.gender,
    "Date of Birth|DOB": p.dob,
    "Blood Group": p.bloodGroup,
    "Occupation": p.occupation,
    "Marital Status": p.maritalStatus,
    "Complete Address|Address": p.address,
    "Mobile No.|Mobile": p.mobile,
    "WhatsApp No.|WhatsApp": p.whatsapp,
    "Email": p.email,
    "In Case Of Emergency Contact Person|Emergency Name": p.emergencyName,
    "In Case Of Emergency Contact Number|Emergency Contact": p.emergencyContact,
    "Relation with Person|Emergency Relation": p.emergencyRelation,
    "Have you ever suffered/suffering from any of the following?|Conditions": safeJSON(p.conditions),
    "Medicines you are taking currently:|Medicines": p.medicines,
    "Are you allergic to any of the following?|Allergies": safeJSON(p.allergies),
    "How did you know about this clinic?|Referred By": p.referredBy,
    "What is your chief complaint?|Complaint": p.complaint,
    "Are you in Pain?": p.painLevel ? "Yes" : "",
    "What is your level of pain on a scale of 0-10?|Pain Level": p.painLevel,
    "Registration Status": p.regStatus || "",
    // Blank for a normal patient, and a blank never overwrites on an update —
    // so the iPad form completing a panel registration cannot wipe the claim
    // details it was never told about.
    "Patient Type": p.patientType || "",
    "Panel": p.panel || "",
    "Panel Category": p.panelCategory || "",
    "Card ID": p.cardId || "",
    "Habits [Do you Smoke Beedi/Cigarette?]": habitsStr.indexOf("Smoking") >= 0 ? "Yes" : "",
    "Habits [Do you Chew Pan Masala]": habitsStr.indexOf("Pan Masala") >= 0 ? "Yes" : "",
    "Habits [Do you Consume Tobacco]": habitsStr.indexOf("Tobacco") >= 0 ? "Yes" : "",
    "Habits [Do you Consume Alcohol]": habitsStr.indexOf("Alcohol") >= 0 ? "Yes" : ""
  };

  var uhidCol = findRegColumn_(headers, ["UHID", "Registration ID"]);
  // existingRow was resolved above, together with the book it is in.

  var rowValues = existingRow > 0
    ? sh.getRange(existingRow, 1, 1, headers.length).getValues()[0]
    : headers.map(function(){ return ""; });

  Object.keys(fieldToValue).forEach(function(key) {
    var col = findRegColumn_(headers, key.split("|"));
    if (col < 0) return;
    var val = fieldToValue[key];
    if (existingRow > 0 && (val === undefined || val === null || String(val).trim() === "")) return;
    rowValues[col] = val;
  });

  var tsCol = findRegColumn_(headers, ["Timestamp"]);
  if (tsCol >= 0 && existingRow < 0) rowValues[tsCol] = new Date().toISOString();

  if (existingRow > 0) sh.getRange(existingRow, 1, 1, headers.length).setValues([rowValues]);
  else sh.appendRow(rowValues);
  regCacheClear_();

  return { success: true, uhid: p.uhid };
}

// ── Patient-facing registration completion (register.html) ──────────
// Public and tokenless, so deliberately narrow: both actions require the
// patient's own mobile number to match the row, return only the fields the
// form needs, and can never create a patient or change UHID, name or DOB.

// The one reader whose callers write back, so it must not use the merged
// table: it returns the row together with the book it actually came from, and
// the patient's own completion of the iPad form updates the right one.
function regRow_(uhid) {
  var want = String(uhid || "").trim().toUpperCase();
  if (!want) return null;
  var sheets = regSheets_();
  for (var b = 0; b < sheets.length; b++) {
    var sh = sheets[b];
    var data = sh.getDataRange().getValues();
    if (data.length <= 1) continue;
    var headers = data[0];
    var uhidCol = findRegColumn_(headers, ["UHID", "Registration ID"]);
    if (uhidCol < 0) continue;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][uhidCol]).trim().toUpperCase() === want) {
        return { sheet: sh, headers: headers, values: data[i], rowNum: i + 1 };
      }
    }
  }
  return null;
}

function regGet_(row, candidates) {
  var col = findRegColumn_(row.headers, candidates);
  return col >= 0 ? String(row.values[col] || "").trim() : "";
}

// UHIDs are sequential and guessable, so the record is gated on something only
// the patient knows. WhatsApp counts too — plenty of patients give one number
// at the desk and quote the other.
function mobileMatches_(row, mobile) {
  var entered = String(mobile || "").replace(/\D/g, "").slice(-10);
  if (entered.length !== 10) return false;
  var onFile = regGet_(row, ["Mobile No.", "Mobile"]).replace(/\D/g, "").slice(-10);
  var wa     = regGet_(row, ["WhatsApp No.", "WhatsApp"]).replace(/\D/g, "").slice(-10);
  return (!!onFile && entered === onFile) || (!!wa && entered === wa);
}

function patientLookup(p) {
  var row = regRow_(p.uhid);
  // Identical answer whether the UHID is wrong or the mobile is wrong, so this
  // cannot be used to find out which UHIDs exist.
  if (!row || !mobileMatches_(row, p.mobile)) {
    return { success: false, error: "We could not match those details." };
  }
  return { success: true, patient: {
    uhid:              regGet_(row, ["UHID", "Registration ID"]),
    name:              regGet_(row, ["Full Name", "Name"]),
    dob:               formatDOB(regGet_(row, ["Date of Birth", "DOB"])),
    mobile:            regGet_(row, ["Mobile No.", "Mobile"]),
    gender:            regGet_(row, ["Gender"]),
    bloodGroup:        regGet_(row, ["Blood Group"]),
    occupation:        regGet_(row, ["Occupation"]),
    maritalStatus:     regGet_(row, ["Marital Status"]),
    address:           regGet_(row, ["Complete Address", "Address"]),
    whatsapp:          regGet_(row, ["WhatsApp No.", "WhatsApp"]),
    email:             regGet_(row, ["Email"]),
    referredBy:        regGet_(row, ["Referred By"]),
    emergencyName:     regGet_(row, ["In Case Of Emergency Contact Person", "Emergency Name"]),
    emergencyRelation: regGet_(row, ["Relation with Person", "Emergency Relation"]),
    emergencyContact:  regGet_(row, ["In Case Of Emergency Contact Number", "Emergency Contact"]),
    conditions:        regGet_(row, ["Have you ever suffered/suffering from any of the following?", "Conditions"]),
    medicines:         regGet_(row, ["Medicines you are taking currently:", "Medicines"]),
    allergies:         regGet_(row, ["Are you allergic to any of the following?", "Allergies"]),
    complaint:         regGet_(row, ["What is your chief complaint?", "Complaint"])
  }};
}

function patientCompleteRegistration(p) {
  var row = regRow_(p.uhid);
  if (!row || !mobileMatches_(row, p.mobile)) {
    return { success: false, error: "We could not match those details." };
  }

  // UHID, name and DOB are never taken from the patient's submission — they
  // stay whatever the front desk entered.
  var habitsStr = String(p.habits || "");
  var fieldToValue = {
    "Gender": p.gender,
    "Blood Group": p.bloodGroup,
    "Occupation": p.occupation,
    "Marital Status": p.maritalStatus,
    "Complete Address|Address": p.address,
    "WhatsApp No.|WhatsApp": p.whatsapp,
    "Email": p.email,
    "In Case Of Emergency Contact Person|Emergency Name": p.emergencyName,
    "In Case Of Emergency Contact Number|Emergency Contact": p.emergencyContact,
    "Relation with Person|Emergency Relation": p.emergencyRelation,
    "Have you ever suffered/suffering from any of the following?|Conditions": p.conditions,
    "Medicines you are taking currently:|Medicines": p.medicines,
    "Are you allergic to any of the following?|Allergies": p.allergies,
    "How did you know about this clinic?": p.howKnown,
    "What is your chief complaint?|Complaint": p.complaint,
    "Are you in Pain?": p.painLevel ? "Yes" : "",
    "What is your level of pain on a scale of 0-10?|Pain Level": p.painLevel,
    "Habits [Do you Smoke Beedi/Cigarette?]": habitsStr.indexOf("Smoking") >= 0 ? "Yes" : "",
    "Habits [Do you Chew Pan Masala]":        habitsStr.indexOf("Pan Masala") >= 0 ? "Yes" : "",
    "Habits [Do you Consume Tobacco]":        habitsStr.indexOf("Tobacco") >= 0 ? "Yes" : "",
    "Habits [Do you Consume Alcohol]":        habitsStr.indexOf("Alcohol") >= 0 ? "Yes" : "",
    "Registration Status": "Complete",
    "Consent": p.consent || ""
  };

  var values = row.values.slice();
  Object.keys(fieldToValue).forEach(function(key) {
    var val = fieldToValue[key];
    // Only write what the patient actually filled in, so a blank field can
    // never wipe something the front desk or a doctor already recorded.
    if (val === undefined || val === null || String(val).trim() === "") return;
    var col = findRegColumn_(row.headers, key.split("|"));
    if (col >= 0) values[col] = val;
  });

  row.sheet.getRange(row.rowNum, 1, 1, row.headers.length).setValues([values]);
  return { success: true, uhid: regGet_(row, ["UHID", "Registration ID"]) };
}

function removePending(mobile) {
  var sh = getSheet("Pending");
  var data = sh.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][2]).trim() === String(mobile).trim()) {
      sh.deleteRow(i + 1);
    }
  }
}

function getPending() {
  var sh = getSheet("Pending");
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { success: true, rows: [] };
  var headers = data[0];
  var rows = data.slice(1).map(function(r) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = r[i]; });
    return obj;
  });
  return { success: true, pending: rows, rows: rows };
}

var OLD_REG_SHEET_ID = "1g_sAiX91CxYNJKYiOrSSgUk3ff26Nlz1qjxRL_YyhUA";

function getOldPatientData(uhid) {
  try {
    var oldSS = SpreadsheetApp.openById(OLD_REG_SHEET_ID);
    var oldSh = oldSS.getSheets()[0];
    var oldData = oldSh.getDataRange().getValues();
    var oldHdrs = oldData[0];
    function oc(name) {
      return oldHdrs.findIndex(function(h) {
        return String(h).toLowerCase().includes(name.toLowerCase());
      });
    }
    var iRegId   = oc("Registration ID");
    var iName    = oc("Full Name");
    var iGender  = oc("Gender");
    var iDOB     = oc("Date of Birth");
    var iBlood   = oc("Blood Group");
    var iOccup   = oc("Occupation");
    var iMarital = oc("Marital Status");
    var iAddress = oc("Complete Address");
    var iMobile  = oc("Mobile No");
    var iWA      = oc("WhatsApp No");
    var iEmail   = oc("Email");
    var iEName   = oc("Emergency Contact Person");
    var iENo     = oc("Emergency Contact Number");
    var iERel    = oc("Relation with Person");
    var iCond    = oc("suffered");
    var iMed     = oc("Medicines");
    var iAllerg  = oc("allergic");
    var iComp    = oc("chief complaint");
    var iPain    = oc("in Pain");
    var iPainLvl = oc("level of pain");
    var iSmoke   = oc("Smoke");
    var iPan     = oc("Pan Masala");
    var iTob     = oc("Tobacco");
    var iAlc     = oc("Alcohol");
    var iPreg    = oc("Pregnant");
    var iFeed    = oc("Feeding");

    for (var i = 1; i < oldData.length; i++) {
      var rowId = iRegId >= 0 ? String(oldData[i][iRegId] || "").trim() : "";
      if (rowId.toUpperCase() === uhid.toUpperCase()) {
        var r = oldData[i];
        var habits = [];
        if (iSmoke >= 0 && r[iSmoke] && String(r[iSmoke]).toLowerCase() !== "no") habits.push("Smoking");
        if (iPan   >= 0 && r[iPan]   && String(r[iPan]  ).toLowerCase() !== "no") habits.push("Pan Masala");
        if (iTob   >= 0 && r[iTob]   && String(r[iTob]  ).toLowerCase() !== "no") habits.push("Tobacco");
        if (iAlc   >= 0 && r[iAlc]   && String(r[iAlc]  ).toLowerCase() !== "no") habits.push("Alcohol");
        var preg = iPreg >= 0 ? String(r[iPreg]||"") : "";
        var feed = iFeed >= 0 ? String(r[iFeed]||"") : "";
        if (preg && preg.toLowerCase() !== "no") habits.push("Pregnant: " + preg);
        if (feed && feed.toLowerCase() !== "no") habits.push("Feeding Mother");

        var painText = "";
        if (iPain >= 0 && r[iPain]) {
          painText = String(r[iPain]);
          if (iPainLvl >= 0 && r[iPainLvl] !== "") painText += " — Level: " + r[iPainLvl] + "/10";
        }

        return {
          name:              iName    >= 0 ? String(r[iName]    ||"").trim() : "",
          gender:            iGender  >= 0 ? String(r[iGender]  ||"").trim() : "",
          dob:               iDOB     >= 0 ? formatDOB(r[iDOB])              : "",
          mobile:            iMobile  >= 0 ? String(r[iMobile]  ||"").trim() : "",
          whatsapp:          iWA      >= 0 ? String(r[iWA]      ||"").trim() : "",
          email:             iEmail   >= 0 ? String(r[iEmail]   ||"").trim() : "",
          bloodGroup:        iBlood   >= 0 ? String(r[iBlood]   ||"").trim() : "",
          occupation:        iOccup   >= 0 ? String(r[iOccup]   ||"").trim() : "",
          maritalStatus:     iMarital >= 0 ? String(r[iMarital] ||"").trim() : "",
          address:           iAddress >= 0 ? String(r[iAddress] ||"").trim() : "",
          emergencyName:     iEName   >= 0 ? String(r[iEName]   ||"").trim() : "",
          emergencyRelation: iERel    >= 0 ? String(r[iERel]    ||"").trim() : "",
          emergencyContact:  iENo     >= 0 ? String(r[iENo]     ||"").trim() : "",
          conditions:        iCond    >= 0 ? String(r[iCond]    ||"").trim() : "",
          medicines:         iMed     >= 0 ? String(r[iMed]     ||"").trim() : "",
          allergies:         iAllerg  >= 0 ? String(r[iAllerg]  ||"").trim() : "",
          habits:            habits.join(", "),
          complaint:         iComp    >= 0 ? String(r[iComp]    ||"").trim() : "",
          painLevel:         painText
        };
      }
    }
  } catch(e) { Logger.log("Old sheet error: " + e.message); }
  return null;
}

function getPatient(p) {
  var data = regAllRows_();
  if (data.length <= 1) return { success: false, error: "No registrations found" };
  var headers = data[0];
  var uhid = String(p.uhid || "").trim().toUpperCase();

  // Find UHID column — supports both "UHID" and "Registration ID"
  var uhidColIdx = headers.findIndex(function(h) {
    var hl = String(h).toLowerCase();
    return hl === "uhid" || hl.includes("registration id");
  });
  if (uhidColIdx < 0) uhidColIdx = 0;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][uhidColIdx]).trim().toUpperCase() === uhid) {
      var obj = {};
      headers.forEach(function(h, k) { obj[h] = data[i][k]; });

      // NOTE: this used to call getOldPatientData(uhid) here, which opens and
      // fully reads a SECOND spreadsheet on every single patient lookup — and
      // then never used the result (the merge() helper below it was defined but
      // never called). That dead call was the main reason loading a patient,
      // and therefore saving a receipt, felt slow. Removed.

      // Support both old column names and new column names
      function get() {
        var tries = Array.prototype.slice.call(arguments);
        for (var t = 0; t < tries.length; t++) {
          var v = String(obj[tries[t]] || "").trim();
          if (v) return v;
        }
        return "";
      }

      return { success: true, patient: {
        uhid:              uhid,
        name:              get("Full Name", "Name", "Patient Name", "full name", "name"),
        gender:            get("Gender"),
        dob:               formatDOB(get("DOB", "Date of Birth")),
        mobile:            get("Mobile", "Mobile No.", "Mobile No"),
        whatsapp:          get("WhatsApp", "WhatsApp No.", "WhatsApp No"),
        email:             get("Email", "Email "),
        bloodGroup:        get("Blood Group"),
        occupation:        get("Occupation"),
        maritalStatus:     get("Marital Status"),
        address:           get("Address", "Complete Address"),
        emergencyName:     get("Emergency Name", "In Case Of Emergency Contact Person"),
        emergencyRelation: get("Emergency Relation", "Relation with Person"),
        emergencyContact:  get("Emergency Contact", "In Case Of Emergency Contact Number"),
        referredBy:        get("Referred By", "How did you know about this clinic?"),
        conditions:        safeParseJSON(get("Conditions") || "[]") || (get("Have you ever suffered/suffering from any of the following?") ? [get("Have you ever suffered/suffering from any of the following?")] : []),
        medicines:         get("Medicines", "Medicines you are taking currently:"),
        allergies:         safeParseJSON(get("Allergies") || "[]") || (get("Are you allergic to any of the following?") ? [get("Are you allergic to any of the following?")] : []),
        habits:            get("Habits"),
        complaint:         get("Complaint", "What is your chief complaint?"),
        painLevel:         get("Pain Level", "What is your level of pain on a scale of 0-10?"),
        registeredOn:      get("Registered On", "Timestamp")
      }};
    }
  }
  return { success: false, error: "Patient not found: " + uhid };
}

function getAllPatients() {
  var data = regAllRows_();
  if (data.length <= 1) return { success: true, patients: [] };
  var headers = data[0];
  var uhidCol = findRegColumn_(headers, ["UHID", "Registration ID"]);
  var nameCol = findRegColumn_(headers, ["Full Name", "Name"]);
  var genderCol = findRegColumn_(headers, ["Gender"]);
  var dobCol = findRegColumn_(headers, ["Date of Birth", "DOB"]);
  var mobileCol = findRegColumn_(headers, ["Mobile No.", "Mobile"]);
  var tsCol = findRegColumn_(headers, ["Timestamp", "Registered On"]);
  var patients = data.slice(1).map(function(r) {
    return {
      uhid: uhidCol >= 0 ? String(r[uhidCol]||"") : "",
      name: nameCol >= 0 ? String(r[nameCol]||"") : "",
      gender: genderCol >= 0 ? String(r[genderCol]||"") : "",
      dob: dobCol >= 0 ? String(r[dobCol]||"") : "",
      mobile: mobileCol >= 0 ? r[mobileCol] : "",
      registeredOn: tsCol >= 0 ? r[tsCol] : ""
    };
  });
  return { success: true, patients: patients };
}

// Patients whose birthday (day+month, any year) falls on today — powers the
// Dashboard's birthday reminder card.
function getTodaysBirthdays() {
  var data = regAllRows_();
  if (data.length <= 1) return { success: true, patients: [] };
  var headers = data[0];
  function fc(name) {
    return headers.findIndex(function(h) {
      return String(h).toLowerCase().replace(/[^a-z0-9]/g,"").includes(name.toLowerCase().replace(/[^a-z0-9]/g,""));
    });
  }
  var iUhid   = fc("registrationid") >= 0 ? fc("registrationid") : fc("uhid");
  var iName   = fc("fullname")       >= 0 ? fc("fullname")       : fc("name");
  var iMobile = fc("mobileno")       >= 0 ? fc("mobileno")       : fc("mobile");
  var iDob    = fc("dateofbirth")    >= 0 ? fc("dateofbirth")    : fc("dob");
  if (iDob < 0) return { success: true, patients: [] };

  var today = new Date();
  var todayDay = today.getDate(), todayMonth = today.getMonth() + 1;

  var results = [];
  for (var i = 1; i < data.length; i++) {
    var dobStr = formatDOB(data[i][iDob]);
    var m = /^(\d{2})\/(\d{2})\/\d{4}$/.exec(dobStr);
    if (!m) continue; // unparseable (e.g. "Not Known")
    if (parseInt(m[1], 10) === todayDay && parseInt(m[2], 10) === todayMonth) {
      results.push({
        uhid:   iUhid   >= 0 ? String(data[i][iUhid]  ||"").trim() : "",
        name:   iName   >= 0 ? String(data[i][iName]  ||"").trim() : "",
        mobile: iMobile >= 0 ? String(data[i][iMobile]||"").trim() : "",
        dob: dobStr
      });
    }
  }
  return { success: true, patients: results };
}

function searchPatients(p) {
  var data = regAllRows_();
  if (data.length <= 1) return { success: true, patients: [] };
  var headers = data[0];
  var q = String(p.query || "").toLowerCase().trim();

  // Find column indices dynamically
  function fc(name) {
    return headers.findIndex(function(h) {
      return String(h).toLowerCase().replace(/[^a-z0-9]/g,"").includes(name.toLowerCase().replace(/[^a-z0-9]/g,""));
    });
  }
  var iUhid   = fc("registrationid") >= 0 ? fc("registrationid") : fc("uhid");
  var iName   = fc("fullname")       >= 0 ? fc("fullname")       : fc("name");
  var iMobile = fc("mobileno")       >= 0 ? fc("mobileno")       : fc("mobile");
  var iDob    = fc("dateofbirth")    >= 0 ? fc("dateofbirth")    : fc("dob");
  var iGender = fc("gender");

  var results = [];
  for (var i = 1; i < data.length; i++) {
    var uhid   = iUhid   >= 0 ? String(data[i][iUhid]  ||"").toLowerCase() : "";
    var name   = iName   >= 0 ? String(data[i][iName]  ||"").toLowerCase() : "";
    var mobile = iMobile >= 0 ? String(data[i][iMobile]||"").toLowerCase() : "";
    if (uhid.includes(q) || name.includes(q) || mobile.includes(q)) {
      results.push({
        uhid:   iUhid   >= 0 ? String(data[i][iUhid]  ||"").trim() : "",
        name:   iName   >= 0 ? String(data[i][iName]  ||"").trim() : "",
        mobile: iMobile >= 0 ? String(data[i][iMobile]||"").trim() : "",
        dob:    iDob    >= 0 ? formatDOB(data[i][iDob]) : "",
        gender: iGender >= 0 ? String(data[i][iGender]||"").trim() : ""
      });
    }
    if (results.length >= 20) break;
  }
  return { success: true, patients: results };
}

// ════════════════════════════════════════════════════════════
// CARE PLAN
// ════════════════════════════════════════════════════════════

function getCarePlan(p) {
  var sh = getSheet("Care Plans");
  var data = sh.getDataRange().getValues();
  var uhid = String(p.uhid || "").trim().toUpperCase();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim().toUpperCase() === uhid) {
      return {
        success: true,
        page1: safeParseJSON(data[i][3]),
        page2: safeParseJSON(data[i][4]),
        page3: safeParseJSON(data[i][5]),
        page4: safeParseJSON(data[i][6]),
        savedAt: data[i][7]
      };
    }
  }
  return { success: true, page1: null, page2: null, page3: null, page4: null };
}

function saveCarePlan(p) {
  var sh = getSheet("Care Plans");
  if (sh.getLastRow() === 0) {
    sh.appendRow(["UHID","Patient Name","Date","Page1","Page2","Page3","Page4","Saved At"]);
  }

  // Update existing row if found
  var data = sh.getDataRange().getValues();
  var uhid = String(p.uhid || "").trim().toUpperCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === uhid) {
      sh.getRange(i + 1, 1, 1, 8).setValues([[
        p.uhid, p.patientName, p.date,
        safeJSON(p.page1), safeJSON(p.page2), safeJSON(p.page3), safeJSON(p.page4),
        new Date().toISOString()
      ]]);
      return { success: true };
    }
  }

  // Append new
  sh.appendRow([
    p.uhid, p.patientName, p.date,
    safeJSON(p.page1), safeJSON(p.page2), safeJSON(p.page3), safeJSON(p.page4),
    new Date().toISOString()
  ]);
  return { success: true };
}

// ════════════════════════════════════════════════════════════
// TREATMENT PLAN
// ════════════════════════════════════════════════════════════

function getTreatmentPlan(p) {
  var sh = getSheet("Treatment Plans");
  var data = sh.getDataRange().getValues();
  var uhid = String(p.uhid || "").trim().toUpperCase();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim().toUpperCase() === uhid) {
      return {
        success: true,
        rows: safeParseJSON(data[i][3]),
        estimate: safeParseJSON(data[i][4]),
        savedAt: data[i][5]
      };
    }
  }
  return { success: true, rows: null, estimate: null };
}

function saveTreatmentPlan(p) {
  var sh = getSheet("Treatment Plans");
  if (sh.getLastRow() === 0) {
    sh.appendRow(["UHID","Patient Name","Date","Rows","Estimate","Saved At"]);
  }

  var data = sh.getDataRange().getValues();
  var uhid = String(p.uhid || "").trim().toUpperCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === uhid) {
      sh.getRange(i + 1, 1, 1, 6).setValues([[
        p.uhid, p.patientName, p.date,
        safeJSON(p.rows), safeJSON(p.estimate),
        new Date().toISOString()
      ]]);
      return { success: true };
    }
  }

  sh.appendRow([
    p.uhid, p.patientName, p.date,
    safeJSON(p.rows), safeJSON(p.estimate),
    new Date().toISOString()
  ]);
  return { success: true };
}

// ════════════════════════════════════════════════════════════
// TREATMENT PROGRESS
// ════════════════════════════════════════════════════════════

function getTreatmentProgress(p) {
  // Fetches from Daily Register sheet filtered by UHID
  var sh = getSheet("Daily Register");
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { success: true, entries: [] };

  var uhid = String(p.uhid || "").trim().toUpperCase();
  var headers = data[0];
  var isNewFormat = String(headers[0]).toLowerCase() === "month";

  var entries = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowUhid = "";

    if (isNewFormat) {
      rowUhid = String(row[2] || "").trim().toUpperCase(); // col 2 = UHID
    } else {
      rowUhid = String(row[0] || "").trim().toUpperCase(); // col 0 = UHID (old format)
    }

    if (rowUhid !== uhid) continue;

    if (isNewFormat) {
      entries.push({
        sno:               String(row[17] || ""),
        date:              row[1] ? formatDateISO(row[1]) : "",
        toothNo:           String(row[12] || ""),
        treatmentRendered: String(row[11] || ""),  // Procedure Done → Tab 2 Treatment col
        clinicalNotes:     String(row[13] || ""),  // Work Done → Tab 2 Clinical Notes col
        workDone:          String(row[13] || ""),  // Work Done → Tab 1 Procedure/Work Done col
        doctor:            String(row[14] || ""),  // Operating Doctor
        paymentMode:       String(row[16] || ""),  // Mode of Payment
        amountReceived:    "",
        sigDataUrl:        ""
      });
    } else {
      entries.push({
        sno:               String(row[2] || ""),
        date:              row[3] ? formatDateISO(row[3]) : "",
        toothNo:           String(row[5] || ""),
        treatmentRendered: String(row[4] || ""),   // Procedure Done
        clinicalNotes:     String(row[6] || ""),   // Work Done
        workDone:          String(row[6] || ""),
        doctor:            String(row[7] || ""),
        paymentMode:       "",
        amountReceived:    "",
        sigDataUrl:        ""
      });
    }
  }
  return { success: true, entries: entries };
}

// ════════════════════════════════════════════════════════════
// CLINICAL SHEETS (RCT / Implant / Crown-Bridge)
// ════════════════════════════════════════════════════════════

// All four open the clinical spreadsheet through getClinicalSheet, like every
// other form — not the PMS file through getSheet. The stale-row clean-up in
// saveClinicalSheets therefore only ever deletes within that one file.
// Each of the four forms gets its own tab instead of all of them sharing one.
// NOTE the "Clinical Sheets - " prefix: flat tabs named "RCT", "Implant
// Surgery", "Implant Prosthetic" and "Crown & Bridge" already exist in this
// same spreadsheet for pasting in historical records, and reusing those names
// would have written JSON blobs straight over them.
var CLINICAL_SHEETS_SHARED_TAB = "Clinical Sheets";
var CLINICAL_SHEET_HEADERS = ["UHID", "Patient Name", "Sheet Type", "All Teeth Data", "Saved At"];
var CLINICAL_SHEET_TABS = {
  "RCT":                "Clinical Sheets - RCT",
  "Implant Surgery":    "Clinical Sheets - Implant Surgery",
  "Implant Prosthetic": "Clinical Sheets - Implant Prosthetic",
  "Crown Bridge":       "Clinical Sheets - Crown Bridge"
};

function clinicalSheetTabName_(sheetType) {
  return CLINICAL_SHEET_TABS[String(sheetType || "").trim()] || CLINICAL_SHEETS_SHARED_TAB;
}

// Locates a patient's row WITHOUT touching the "All Teeth Data" column.
// That column holds the entire record for every tooth as JSON, so reading the
// whole range just to find one row pulled and parsed every record in the tab
// on every open and every save. Only the three key columns are read here; the
// blob is fetched afterwards, for the single row that matched.
function findClinicalRow_(sh, uhid, sheetType) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var keys = sh.getRange(2, 1, last - 1, 3).getValues();
  for (var i = keys.length - 1; i >= 0; i--) {
    if (String(keys[i][0]).trim().toUpperCase() !== uhid) continue;
    if (sheetType && String(keys[i][2]).trim() !== sheetType) continue;
    return i + 2;
  }
  return -1;
}

function readClinicalRow_(sh, row) {
  var vals = sh.getRange(row, 1, 1, 5).getValues()[0];
  return {
    success: true,
    allTeeth: safeParseJSON(vals[3]),
    sheetType: vals[2],
    savedAt: vals[4]
  };
}

function getClinicalSheets(p) {
  var uhid = String(p.uhid || "").trim().toUpperCase();
  var sheetType = p.sheetType ? String(p.sheetType).trim() : null;

  // Its own tab first, then the shared one — so a record written before the
  // split is still found whether or not the migration has been run.
  var names = [];
  if (sheetType) {
    names.push(clinicalSheetTabName_(sheetType));
  } else {
    for (var k in CLINICAL_SHEET_TABS) names.push(CLINICAL_SHEET_TABS[k]);
  }
  names.push(CLINICAL_SHEETS_SHARED_TAB);

  var best = null;
  for (var n = 0; n < names.length; n++) {
    var sh = getClinicalSheet(names[n]);
    var row = findClinicalRow_(sh, uhid, sheetType);
    if (row < 0) continue;
    var hit = readClinicalRow_(sh, row);
    // With a sheetType the first hit is the answer. Without one the caller
    // wants this patient's most recent record, whichever form it came from.
    if (sheetType) return hit;
    if (!best || String(hit.savedAt || "") > String(best.savedAt || "")) best = hit;
  }
  return best || { success: true, allTeeth: null };
}

function saveClinicalSheets(p) {
  var uhid = String(p.uhid || "").trim().toUpperCase();
  var sheetType = String(p.sheetType || "").trim();
  var sh = getClinicalSheet(clinicalSheetTabName_(sheetType));
  if (sh.getLastRow() === 0) sh.appendRow(CLINICAL_SHEET_HEADERS);

  var rowValues = [p.uhid, p.patientName, sheetType, safeJSON(p.allTeeth), new Date().toISOString()];
  var row = findClinicalRow_(sh, uhid, sheetType);
  if (row > 0) sh.getRange(row, 1, 1, 5).setValues([rowValues]);
  else sh.appendRow(rowValues);

  // The same record may still sit in the shared tab from before the split.
  // Drop it only now that the newer copy is safely written, so the row is
  // moved rather than deleted — two copies would otherwise drift apart.
  if (sh.getName() !== CLINICAL_SHEETS_SHARED_TAB) {
    var shared = getClinicalSheet(CLINICAL_SHEETS_SHARED_TAB);
    var stale = findClinicalRow_(shared, uhid, sheetType);
    if (stale > 0) shared.deleteRow(stale);
  }
  return { success: true };
}

// ── One-off, safe to re-run ──────────────────────────────────────────────
// Copies existing records out of the shared tab into each form's own tab.
// Nothing is deleted: rows stay in the shared tab until the next save of that
// record moves them. Run it from the Apps Script editor and read the log.
function migrateClinicalSheetsToOwnTabs() {
  var shared = getClinicalSheet(CLINICAL_SHEETS_SHARED_TAB);
  var last = shared.getLastRow();
  if (last < 2) { Logger.log("Shared tab is empty — nothing to migrate."); return; }

  var moved = 0, skipped = 0, unknown = 0;
  var keys = shared.getRange(2, 1, last - 1, 3).getValues();
  for (var i = 0; i < keys.length; i++) {
    var uhid = String(keys[i][0]).trim().toUpperCase();
    var sheetType = String(keys[i][2]).trim();
    if (!uhid) continue;
    var tab = CLINICAL_SHEET_TABS[sheetType];
    if (!tab) { unknown++; continue; }

    var target = getClinicalSheet(tab);
    if (target.getLastRow() === 0) target.appendRow(CLINICAL_SHEET_HEADERS);

    var existing = findClinicalRow_(target, uhid, sheetType);
    var src = shared.getRange(i + 2, 1, 1, 5).getValues()[0];
    if (existing > 0) {
      // Never overwrite a newer record with an older one.
      var there = target.getRange(existing, 5, 1, 1).getValues()[0][0];
      if (String(there || "") >= String(src[4] || "")) { skipped++; continue; }
      target.getRange(existing, 1, 1, 5).setValues([src]);
    } else {
      target.appendRow(src);
    }
    moved++;
  }
  Logger.log("Copied %s record(s) into their own tabs. %s already current, %s of an unrecognised type left alone.", moved, skipped, unknown);
  Logger.log("Nothing was deleted — the shared tab still holds every row.");
}

// ════════════════════════════════════════════════════════════
// DAILY REGISTER
// ════════════════════════════════════════════════════════════

function getDailyRegister(p) {
  var sh = getSheet("Daily Register");
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { success: true, entries: [] };

  // Detect column layout: new format has "Month" in col 0, old has "UHID" in col 0
  var headers = data[0];
  var isNewFormat = String(headers[0]).toLowerCase() === "month";

  // Header-name-based index map — safe regardless of column order shifts
  var hIdx = {};
  headers.forEach(function(h, i) { hIdx[String(h).trim().toLowerCase()] = i; });
  function colVal(row, keys) {
    for (var k = 0; k < keys.length; k++) {
      var idx = hIdx[keys[k].toLowerCase()];
      if (idx !== undefined && row[idx] !== undefined && String(row[idx]).trim() !== "") {
        return String(row[idx]);
      }
    }
    return "";
  }
  function colRaw(row, keys) {
    for (var k = 0; k < keys.length; k++) {
      var idx = hIdx[keys[k].toLowerCase()];
      if (idx !== undefined && row[idx]) return row[idx];
    }
    return null;
  }

  // Compare plain ISO date STRINGS (not Date objects) — this sheet has hundreds
  // of historical rows fed by a separate Google Form with inconsistent date
  // formatting, and `new Date(badString)` silently produces an Invalid Date
  // that is still truthy, so a Date-object comparison never excludes it and
  // the range filter used to leak every unparseable row through regardless
  // of the range chosen. String comparison also sidesteps timezone drift.
  var fromISO = String(p.fromDate || "").trim();
  var toISO   = String(p.toDate   || "").trim();
  var rangeActive = !!(fromISO || toISO);

  var entries = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];

    if (isNewFormat) {
      // Confirmed via debugSheetHeaders: this sheet's actual date column is
      // named "Timestamp" (from the old Google Form), not "Date".
      var rawDate = colRaw(row, ["timestamp", "date"]);
      var rowDateISO = rawDate ? formatDateISO(rawDate) : "";
      var rowDateValid = /^\d{4}-\d{2}-\d{2}$/.test(rowDateISO);
      if (rangeActive && !rowDateValid) continue;
      if (fromISO && rowDateISO < fromISO) continue;
      if (toISO   && rowDateISO > toISO)   continue;
      entries.push({
        month:              colVal(row, ["month"]),
        date:               rowDateISO,
        uhid:               colVal(row, ["uhid / registration id","uhid","registration id"]),
        patientName:        colVal(row, ["full name","patient name","name"]),
        phoneNo:            colVal(row, ["phone no.","phone no","phone"]),
        age:                colVal(row, ["age"]),
        timeWalkIn:         fmtTime(colVal(row, ["time of walk in","walk-in time","walk in"])),
        consultationTime:   fmtTime(colVal(row, ["consultation time"])),
        tat:                fmtTAT(colVal(row, ["tat (hr/min)","tat"])),
        initialAssessment:  colVal(row, ["initial assessment done","initial assessment"]),
        carePlanDocumented: colVal(row, ["care plan documented","care plan"]),
        procedureDone:      colVal(row, ["procedure done"]),
        toothNo:            colVal(row, ["tooth no. (if any)","tooth no.","tooth no"]),
        workDone:           colVal(row, ["work done"]),
        operatingDoctor:    colVal(row, ["operating doctor"]),
        delayReason:        colVal(row, ["if delay reason for delay","delay reason"]),
        modeOfPayment:      colVal(row, ["mode of payment & payment","mode of payment","payment"])
      });
    } else {
      // Old column order: UHID|Patient Name|S.No|Date|Procedure Done|Tooth No|Work Done|Operating Doctor|Saved At
      var rowDateISO = row[3] ? formatDateISO(row[3]) : "";
      var rowDateValid = /^\d{4}-\d{2}-\d{2}$/.test(rowDateISO);
      if (rangeActive && !rowDateValid) continue;
      if (fromISO && rowDateISO < fromISO) continue;
      if (toISO   && rowDateISO > toISO)   continue;
      entries.push({
        month:              "",
        date:               rowDateISO,
        uhid:               String(row[0] || ""),
        patientName:        String(row[1] || ""),
        phoneNo:            "",
        age:                "",
        timeWalkIn:         "",
        consultationTime:   "",
        tat:                "",
        initialAssessment:  "",
        carePlanDocumented: "",
        procedureDone:      String(row[4] || ""),
        toothNo:            String(row[5] || ""),
        workDone:           String(row[6] || ""),
        operatingDoctor:    String(row[7] || ""),
        delayReason:        "",
        modeOfPayment:      ""
      });
    }
  }
  return { success: true, entries: entries };
}

// ════════════════════════════════════════════════════════════
// FOLLOW-UP PROTOCOL
// Three independent lists, each computed fresh on every call (no stored
// "dismissed" state yet — that would need its own tracking sheet later):
//   1. postTreatment — procedure-specific check-ins (e.g. RCT -> 7 days)
//   2. recall        — patients with no visit in 180+ days and nothing booked
//   3. missed        — Cancelled/No Show appointments never rebooked
// ════════════════════════════════════════════════════════════
var FOLLOWUP_RULES = [
  { keywords:["root canal","rct"],                          days:7,  label:"RCT" },
  { keywords:["extraction","wisdom"],                        days:3,  label:"Extraction" },
  { keywords:["implant surgery","implant placement","implant - "], days:10, label:"Implant Surgery" },
  { keywords:["denture","rpd"],                               days:14, label:"Denture Fitting" },
  { keywords:["crown","bridge","prosthetic","cementation"],  days:7,  label:"Crown / Bridge" },
  { keywords:["flap surgery","periodontal","gum surg"],      days:7,  label:"Gum Surgery" },
  { keywords:["apicoectomy"],                                 days:10, label:"Apicoectomy" }
];
function matchFollowupRule(procedureText) {
  var t = String(procedureText || "").toLowerCase();
  for (var i = 0; i < FOLLOWUP_RULES.length; i++) {
    var rule = FOLLOWUP_RULES[i];
    for (var k = 0; k < rule.keywords.length; k++) {
      if (t.indexOf(rule.keywords[k]) >= 0) return rule;
    }
  }
  return null;
}

function getFollowUps() {
  try {
    var todayISO = formatDateISO(new Date());
    var todayMs = new Date(todayISO + "T00:00:00").getTime();
    function daysBetween(iso) {
      if (!iso) return null;
      var t = new Date(iso + "T00:00:00").getTime();
      if (isNaN(t)) return null;
      return Math.round((todayMs - t) / 86400000);
    }

    // ── Patient directory (name/mobile fallback) ──
    var regData = regAllRows_();
    var patientDir = {};
    for (var r = 1; r < regData.length; r++) {
      var uhid = String(regData[r][0] || "").trim();
      if (uhid) patientDir[uhid] = { name: String(regData[r][1] || ""), mobile: String(regData[r][6] || "") };
    }

    // ── Daily Register — recent-treatment events + last-visit-date map ──
    var drSh = getSheet("Daily Register");
    var drData = drSh.getDataRange().getValues();
    var lastVisit = {}; // uhid -> most recent ISO date seen anywhere
    var nameFallback = {}; // uhid -> name/mobile seen in Daily Register, for patients missing/mismatched in Registrations
    var recentEvents = []; // rows from the last 45 days, for post-treatment matching
    if (drData.length > 1) {
      var drHeaders = drData[0];
      var isNewFormat = String(drHeaders[0]).toLowerCase() === "month";
      var hIdx = {};
      drHeaders.forEach(function(h, i) { hIdx[String(h).trim().toLowerCase()] = i; });
      function drCol(row, keys) {
        for (var k = 0; k < keys.length; k++) {
          var idx = hIdx[keys[k].toLowerCase()];
          if (idx !== undefined && row[idx]) return row[idx];
        }
        return null;
      }
      for (var i = 1; i < drData.length; i++) {
        var row = drData[i];
        var uhid2, dateISO, procedureDone, patientName, phoneNo;
        if (isNewFormat) {
          uhid2 = String(drCol(row, ["uhid / registration id","uhid","registration id"]) || "").trim();
          dateISO = formatDateISO(drCol(row, ["timestamp","date"]));
          procedureDone = String(drCol(row, ["procedure done"]) || "");
          patientName = String(drCol(row, ["full name","patient name","name"]) || "");
          phoneNo = String(drCol(row, ["phone no.","phone no","phone"]) || "");
        } else {
          uhid2 = String(row[0] || "").trim();
          dateISO = formatDateISO(row[3]);
          procedureDone = String(row[4] || "");
          patientName = String(row[1] || "");
          phoneNo = "";
        }
        if (!uhid2 || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) continue;
        if (!lastVisit[uhid2] || dateISO > lastVisit[uhid2]) lastVisit[uhid2] = dateISO;
        if (patientName || phoneNo) {
          var existing = nameFallback[uhid2] || {};
          nameFallback[uhid2] = { name: existing.name || patientName, mobile: existing.mobile || phoneNo };
        }
        var age = daysBetween(dateISO);
        if (age !== null && age >= 0 && age <= 45) {
          recentEvents.push({ uhid: uhid2, name: patientName, date: dateISO, procedure: procedureDone });
        }
      }
    }

    // ── Appointments — future-booking map + missed/no-show list ──
    var apptSh = getAppointmentsSheet();
    var apptData = apptSh.getDataRange().getValues();
    var futureBooked = {}; // uhid -> true if a Scheduled/Checked-In/etc appointment exists today or later
    var missedList = [];
    if (apptData.length > 1) {
      var aHeaders = apptData[0].map(String);
      var aCol = function(name) { return aHeaders.indexOf(name); };
      // First pass: find every patient's latest appointment date (any status)
      var latestApptByUhid = {};
      for (var j = 1; j < apptData.length; j++) {
        var arow = apptData[j];
        var auhid = String(arow[aCol("UHID")] || "").trim();
        if (!auhid) continue;
        var adate = formatDateISO(arow[aCol("Date")]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(adate)) continue;
        var astatus = String(arow[aCol("Status")] || "");
        if (astatus !== "Cancelled" && adate >= todayISO) futureBooked[auhid] = true;
        if (!latestApptByUhid[auhid] || adate > latestApptByUhid[auhid].date) {
          latestApptByUhid[auhid] = { date: adate, status: astatus };
        }
      }
      // Second pass: Cancelled/No Show appointments where that same visit was
      // never rebooked (i.e. it's still that patient's latest appointment)
      for (var m = 1; m < apptData.length; m++) {
        var mrow = apptData[m];
        var mstatus = String(mrow[aCol("Status")] || "");
        if (mstatus !== "Cancelled" && mstatus !== "No Show") continue;
        var muhid = String(mrow[aCol("UHID")] || "").trim();
        if (!muhid) continue;
        var mdate = formatDateISO(mrow[aCol("Date")]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(mdate)) continue;
        var age2 = daysBetween(mdate);
        if (age2 === null || age2 < 0 || age2 > 60) continue;
        var latest = latestApptByUhid[muhid];
        if (latest && latest.date === mdate && latest.status === mstatus) {
          missedList.push({
            uhid: muhid, name: String(mrow[aCol("Patient Name")] || ""),
            mobile: String(mrow[aCol("Mobile")] || "") || (patientDir[muhid] ? patientDir[muhid].mobile : ""),
            date: mdate, status: mstatus, type: String(mrow[aCol("Type")] || "")
          });
        }
      }
    }

    // ── 1. Post-treatment check-ins ──
    var postTreatment = [];
    recentEvents.forEach(function(ev) {
      var rule = matchFollowupRule(ev.procedure);
      if (!rule) return;
      var dueDate = new Date(ev.date + "T00:00:00"); dueDate.setDate(dueDate.getDate() + rule.days);
      var dueISO = formatDateISO(dueDate);
      var overdueDays = daysBetween(dueISO);
      if (overdueDays === null || overdueDays < 0 || overdueDays > 14) return; // due window: due date through 14 days after
      if (futureBooked[ev.uhid]) return; // already has an upcoming appointment
      postTreatment.push({
        uhid: ev.uhid,
        name: ev.name || (patientDir[ev.uhid] && patientDir[ev.uhid].name) || "",
        mobile: (patientDir[ev.uhid] && patientDir[ev.uhid].mobile) || (nameFallback[ev.uhid] && nameFallback[ev.uhid].mobile) || "",
        procedure: rule.label, treatmentDate: ev.date, dueDate: dueISO, overdueDays: overdueDays
      });
    });
    postTreatment.sort(function(a,b){ return b.overdueDays - a.overdueDays; });

    // ── 2. Recall / recare (180+ days since last visit, nothing booked) ──
    var recall = [];
    Object.keys(lastVisit).forEach(function(uhid3) {
      if (futureBooked[uhid3]) return;
      var since = daysBetween(lastVisit[uhid3]);
      if (since !== null && since >= 180) {
        var pd = patientDir[uhid3], nf = nameFallback[uhid3];
        recall.push({
          uhid: uhid3,
          name: (pd && pd.name) || (nf && nf.name) || "",
          mobile: (pd && pd.mobile) || (nf && nf.mobile) || "",
          lastVisit: lastVisit[uhid3], daysSince: since
        });
      }
    });
    recall.sort(function(a,b){ return b.daysSince - a.daysSince; });
    recall = recall.slice(0, 100); // cap — this list can get large on an old dataset

    return { success: true, postTreatment: postTreatment, recall: recall, missed: missedList };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function formatDateISO(val) {
  if (!val) return "";
  try {
    // Plenty of historical rows across this app were fed by old Google Forms
    // that store dates as plain DD/MM/YYYY (or DD-MM-YYYY / DD.MM.YYYY) text —
    // new Date() either misreads these as MM/DD or rejects them outright, so
    // detect and parse that shape explicitly before falling back to new Date().
    if (typeof val === "string") {
      var m = val.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
      if (m) {
        var dd0 = parseInt(m[1], 10), mm0 = parseInt(m[2], 10), yyyy0 = parseInt(m[3], 10);
        if (mm0 >= 1 && mm0 <= 12 && dd0 >= 1 && dd0 <= 31) {
          return yyyy0 + "-" + String(mm0).padStart(2, "0") + "-" + String(dd0).padStart(2, "0");
        }
      }
    }
    var d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    var yyyy = d.getFullYear();
    var mm   = String(d.getMonth() + 1).padStart(2, "0");
    var dd   = String(d.getDate()).padStart(2, "0");
    return yyyy + "-" + mm + "-" + dd;
  } catch(e) { return String(val); }
}

// One-time diagnostic — shows the real header row + a sample data row for a
// sheet, since the "Daily Register" sheet's historical columns (fed by an old
// Google Form) don't all match the header names this app guesses at (e.g.
// "Date" comes back blank for every row even though the data clearly has
// dates in it — the real header must be named something else).
function debugSheetHeaders(p) {
  var sh = getSheet(p.sheet || "Daily Register");
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var sample = sh.getLastRow() > 1 ? sh.getRange(2, 1, 1, lastCol).getValues()[0] : [];
  return { success: true, headers: headers, sample: sample };
}

function fmtTime(val) {
  // Handles Date objects, time strings "HH:MM", or full datetime strings.
  if (!val) return "";
  try {
    var d = new Date(val);
    if (!isNaN(d.getTime())) {
      // Format in the SPREADSHEET's timezone rather than via getHours(), which
      // reads in the script's. The two are normally both IST, but nothing
      // enforces that — and a time-of-day cell read back from Sheets is a Date
      // on the 1899-12-30 epoch, so any mismatch silently shifts every
      // check-in and check-out by the offset.
      var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
      return Utilities.formatDate(d, tz, "HH:mm");
    }
    // Already a plain string like "10:30"
    return String(val);
  } catch(e) { return String(val); }
}

function fmtTAT(val) {
  // TAT stored as decimal days (Google Sheets time fraction) or HH:MM:SS string
  if (!val) return "";
  var s = String(val).trim();
  // Already formatted HH:MM or HH:MM:SS
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s;
  // Numeric fractional day from Sheets
  var num = parseFloat(s);
  if (!isNaN(num)) {
    var totalSec = Math.round(num * 86400);
    var hh = Math.floor(totalSec / 3600);
    var mm = Math.floor((totalSec % 3600) / 60);
    var ss = totalSec % 60;
    return String(hh).padStart(2,"0") + ":" + String(mm).padStart(2,"0") + ":" + String(ss).padStart(2,"0");
  }
  return s;
}

// Combines a value that can legitimately happen more than once in a day
// (Procedure Done, Work Done, Tooth No., Operating Doctor, Mode of Payment)
// — a patient having an X-ray, a Digital Scan, and Local Anesthesia on the
// same visit should read as one register row listing all three, not three
// separate rows. Skips re-appending a value already present.
function combineRegisterField_(oldVal, newVal) {
  oldVal = String(oldVal || "").trim();
  newVal = String(newVal || "").trim();
  if (!newVal) return oldVal;
  if (!oldVal) return newVal;
  var parts = oldVal.split(/\s*\|\s*/);
  if (parts.indexOf(newVal) >= 0) return oldVal;
  return oldVal + " | " + newVal;
}
// A fact that should only ever hold one true value at a time (the compliance
// questions) — a later non-blank answer corrects an earlier one instead of
// piling up, but never overwrites an answer with blank.
function preferLatestNonBlank_(oldVal, newVal) {
  newVal = String(newVal || "").trim();
  return newVal || String(oldVal || "").trim();
}
// Timing set once at the first visit of the day — later saves fill a gap but
// never overwrite an already-recorded time.
function keepFirstNonBlank_(oldVal, newVal) {
  oldVal = String(oldVal || "").trim();
  return oldVal || String(newVal || "").trim();
}

function saveToDailyRegister(p) {
  var sh = getSheet("Daily Register");

  // Write header if sheet is empty
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "Month","Date","UHID","Patient Name","Phone No.","Age",
      "Time of Walk-in","Consultation Time","TAT (HR/MIN)",
      "Initial Assessment Done","Care Plan Documented",
      "Procedure Done","Tooth No. (If any)","Work Done",
      "Operating Doctor","If Delay Reason for Delay",
      "Mode of payment & payment","S.No","Saved At"
    ]);
  }

  // Write by header NAME rather than a fixed column order — this sheet already
  // holds hundreds of real historical rows (originally fed by a separate Google
  // Form), so a positional appendRow would silently scramble columns if the
  // real header order differs even slightly from the list above.
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var hIdx = {};
  headers.forEach(function(h, i) { hIdx[String(h).trim().toLowerCase()] = i; });
  function setBy(row, keys, val) {
    for (var k = 0; k < keys.length; k++) {
      var idx = hIdx[keys[k].toLowerCase()];
      if (idx !== undefined) { row[idx] = val; return; }
    }
  }
  function getBy(row, keys) {
    for (var k = 0; k < keys.length; k++) {
      var idx = hIdx[keys[k].toLowerCase()];
      if (idx !== undefined) return row[idx];
    }
    return "";
  }

  var dateObj = p.date ? new Date(p.date) : new Date();
  var targetDateISO = formatDateISO(p.date || dateObj);
  var targetUhid = String(p.uhid || "").trim().toUpperCase();

  // Same patient, same day, more than one clinical action recorded (an
  // X-ray, a scan, local anesthesia, and more can all happen in one visit) —
  // merge into that existing row instead of appending a duplicate one.
  var existingRowIndex = -1;
  if (targetUhid) {
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowUhid = String(getBy(data[i], ["uhid / registration id","uhid","registration id"])).trim().toUpperCase();
      if (rowUhid !== targetUhid) continue;
      var rowDateRaw = getBy(data[i], ["timestamp", "date"]);
      if (rowDateRaw && formatDateISO(rowDateRaw) === targetDateISO) { existingRowIndex = i; break; }
    }
  }

  var row = existingRowIndex >= 0 ? data[existingRowIndex].slice() : new Array(headers.length).fill("");

  setBy(row, ["month"], existingRowIndex >= 0
    ? (getBy(row, ["month"]) || p.month || dateObj.toLocaleString("en-US", { month: "long" }))
    : (p.month || dateObj.toLocaleString("en-US", { month: "long" })));
  // Sheet's real date column is named "Timestamp" (see debugSheetHeaders) —
  // try that first so new entries actually persist their date; "date" kept
  // as a fallback in case a future sheet uses that name instead.
  if (existingRowIndex < 0) setBy(row, ["timestamp", "date"], p.date || "");
  setBy(row, ["uhid / registration id","uhid","registration id"], p.uhid || "");
  setBy(row, ["full name","patient name","name"],
    keepFirstNonBlank_(getBy(row, ["full name","patient name","name"]), p.patientName));
  setBy(row, ["phone no.","phone no","phone"],
    keepFirstNonBlank_(getBy(row, ["phone no.","phone no","phone"]), p.phoneNo));
  setBy(row, ["age"], keepFirstNonBlank_(getBy(row, ["age"]), p.age));
  setBy(row, ["time of walk in","walk-in time","walk in","time of walk-in"],
    keepFirstNonBlank_(getBy(row, ["time of walk in","walk-in time","walk in","time of walk-in"]), p.timeWalkIn));
  setBy(row, ["consultation time"],
    keepFirstNonBlank_(getBy(row, ["consultation time"]), p.consultationTime));
  setBy(row, ["tat (hr/min)","tat"], keepFirstNonBlank_(getBy(row, ["tat (hr/min)","tat"]), p.tat));
  // An unanswered question stays blank. These are compliance answers, and
  // the register should not be giving them on the clinic's behalf.
  setBy(row, ["initial assessment done","initial assessment"],
    preferLatestNonBlank_(getBy(row, ["initial assessment done","initial assessment"]), p.initialAssessment));
  setBy(row, ["care plan documented","care plan"],
    preferLatestNonBlank_(getBy(row, ["care plan documented","care plan"]), p.carePlanDocumented));
  setBy(row, ["procedure done"], combineRegisterField_(getBy(row, ["procedure done"]), p.procedureDone));
  setBy(row, ["tooth no. (if any)","tooth no.","tooth no"],
    combineRegisterField_(getBy(row, ["tooth no. (if any)","tooth no.","tooth no"]), p.toothNo));
  setBy(row, ["work done"], combineRegisterField_(getBy(row, ["work done"]), p.workDone));
  setBy(row, ["operating doctor"], combineRegisterField_(getBy(row, ["operating doctor"]), p.operatingDoctor));
  setBy(row, ["if delay reason for delay","delay reason"],
    keepFirstNonBlank_(getBy(row, ["if delay reason for delay","delay reason"]), p.delayReason));
  setBy(row, ["mode of payment & payment","mode of payment","payment"],
    combineRegisterField_(getBy(row, ["mode of payment & payment","mode of payment","payment"]), p.modeOfPayment));
  if (existingRowIndex < 0) setBy(row, ["s.no","sno"], sh.getLastRow());
  setBy(row, ["saved at"], new Date().toISOString());

  if (existingRowIndex >= 0) {
    sh.getRange(existingRowIndex + 1, 1, 1, row.length).setValues([row]);
    return { success: true, merged: true, row: existingRowIndex + 1 };
  }
  sh.appendRow(row);
  return { success: true, merged: false };
}

// ════════════════════════════════════════════════════════════
// APPOINTMENTS
// ════════════════════════════════════════════════════════════

// Full header set — auto-extended onto any older sheet that's missing
// Chair / CheckinTime / EngagedTime / CheckoutTime (added for the chair-based
// Schedule + Daysheet workflow), so existing rows/columns are never disturbed.
// CaseId..VisitCounter (the multi-visit treatment fields) are all OPTIONAL —
// a plain one-off appointment (walk-in, phone consult) simply leaves them
// blank. Per the V2 spec, an appointment does NOT carry its own stage or
// visit-count state — that lives on the Case record (see Treatment Cases,
// below) — it only records which stage sequence numbers this appointment
// PLANNED to cover and which it actually COMPLETED.
var APPOINTMENT_HEADERS = [
  "Date","UHID","Patient Name","Time","Type","Doctor","Chair",
  "Mobile","Notes","Status","CheckinTime","EngagedTime","CheckoutTime","CancelReason","ID","Saved At",
  "CaseId","ProcedureCode","ProcedureName","FamilyCode","PlannedStages","CompletedStages","VisitCounter"
];

function getAppointmentsSheet() {
  var sh = getSheet("Appointments");
  if (sh.getLastRow() === 0) {
    sh.appendRow(APPOINTMENT_HEADERS);
    return sh;
  }
  var existingHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var missing = APPOINTMENT_HEADERS.filter(function(h) { return existingHeaders.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, existingHeaders.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function getAppointments(p) {
  var sh = getAppointmentsSheet();
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { success: true, appointments: [] };
  var headers = data[0].map(String);
  var col = function(name) { return headers.indexOf(name); };

  var date = String(p.date || "").trim();
  var fromDate = String(p.fromDate || "").trim();
  var toDate = String(p.toDate || "").trim();
  var appts = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    // Sheets auto-converts "yyyy-mm-dd"/"HH:MM"-looking text into real Date
    // cells on write — normalize back to plain strings here so the frontend
    // always gets clean values regardless of how the cell ended up stored.
    var rowDate = formatDateISO(row[col("Date")]) || String(row[col("Date")] || "");
    var matches = date ? rowDate === date
      : (fromDate || toDate) ? ((!fromDate || rowDate >= fromDate) && (!toDate || rowDate <= toDate))
      : true;
    if (matches) {
      appts.push({
        id: row[col("ID")], date: rowDate, uhid: row[col("UHID")],
        patientName: row[col("Patient Name")], time: fmtTime(row[col("Time")]) || String(row[col("Time")]||""),
        type: row[col("Type")],
        doctor: row[col("Doctor")], chair: row[col("Chair")] || "",
        mobile: row[col("Mobile")], notes: row[col("Notes")], status: row[col("Status")],
        // Sheets turns an "HH:MM" write into a time-of-day cell, which reads
        // back as a Date on the 1899-12-30 epoch. Passed through raw these
        // reached the browser as "1899-12-30T05:35:50.000Z" instead of a time.
        checkinTime: fmtTime(row[col("CheckinTime")]), engagedTime: fmtTime(row[col("EngagedTime")]),
        checkoutTime: fmtTime(row[col("CheckoutTime")]), cancelReason: row[col("CancelReason")] || "",
        // Multi-visit treatment fields — blank on any appointment that isn't
        // part of a tracked case. Current/next stage and case status are NOT
        // stored here — they live on the Case record; fetch via getCaseState.
        caseId: row[col("CaseId")] || "", procedureCode: row[col("ProcedureCode")] || "",
        procedureName: row[col("ProcedureName")] || "", familyCode: row[col("FamilyCode")] || "",
        plannedStages: safeParseJSON(row[col("PlannedStages")]) || [],
        completedStages: safeParseJSON(row[col("CompletedStages")]) || [],
        visitCounter: row[col("VisitCounter")] || ""
      });
    }
  }
  return { success: true, appointments: appts };
}

function saveAppointment(p) {
  var sh = getAppointmentsSheet();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var id = "APT-" + Date.now();
  var values = {
    "Date": p.date, "UHID": p.uhid, "Patient Name": p.patientName, "Time": p.time,
    "Type": p.type, "Doctor": p.doctor, "Chair": p.chair || "", "Mobile": p.mobile || "",
    "Notes": p.notes || "", "Status": p.status || "Scheduled",
    "CheckinTime": "", "EngagedTime": "", "CheckoutTime": "", "CancelReason": "",
    "ID": id, "Saved At": new Date().toISOString(),
    // All optional — a booking with none of these is a plain one-off visit.
    // plannedStages: which stage sequence number(s) this visit intends to
    // cover — usually just the case's current stage, sometimes more.
    "CaseId": p.caseId || "", "ProcedureCode": p.procedureCode || "", "ProcedureName": p.procedureName || "",
    "FamilyCode": p.familyCode || "",
    "PlannedStages": p.plannedStages ? JSON.stringify(p.plannedStages) : "",
    "CompletedStages": "", "VisitCounter": p.visitCounter || ""
  };
  var row = headers.map(function(h) { return values[h] !== undefined ? values[h] : ""; });
  sh.appendRow(row);
  return { success: true, id: id };
}

// Status transitions also stamp the matching time column (Checked In ->
// CheckinTime, In Chair -> EngagedTime, Completed -> CheckoutTime) so the
// Daysheet can show each step's actual time, mirroring a front-desk workflow.
function updateAppointmentStatus(p) {
  var sh = getAppointmentsSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var col = function(name) { return headers.indexOf(name); };
  var apptId = String(p.apptId || "").trim();

  var stampCol = null;
  if (p.status === "Checked In") stampCol = "CheckinTime";
  else if (p.status === "In Chair") stampCol = "EngagedTime";
  else if (p.status === "Completed") stampCol = "CheckoutTime";

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col("ID")]).trim() === apptId) {
      sh.getRange(i + 1, col("Status") + 1).setValue(p.status);
      if (stampCol) {
        sh.getRange(i + 1, col(stampCol) + 1).setValue(fmtTime(new Date()));
      }
      if (p.cancelReason) {
        sh.getRange(i + 1, col("CancelReason") + 1).setValue(p.cancelReason);
      }
      return { success: true };
    }
  }
  return { success: false, error: "Appointment not found: " + apptId };
}

// In-place edit of an existing appointment's core fields (date/time/doctor/
// chair/reason/notes) — used by the Schedule popup's "Edit" action.
function updateAppointment(p) {
  var sh = getAppointmentsSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var col = function(name) { return headers.indexOf(name); };
  var apptId = String(p.apptId || "").trim();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col("ID")]).trim() === apptId) {
      var updates = {
        "Date": p.date, "Time": p.time, "Type": p.type, "Doctor": p.doctor,
        "Chair": p.chair, "Notes": p.notes,
        // Only sent when actually attaching a UHID — a telephone booking made
        // before the patient existed in the system is saved with no UHID, and
        // gets linked here once they register, rather than staying a second,
        // unidentified copy of the same visit.
        "UHID": p.uhid, "Patient Name": p.patientName,
        // Multi-visit case fields — only touched when the edit form actually
        // sent them (a plain one-off appointment's edit never includes these).
        "CaseId": p.caseId, "ProcedureCode": p.procedureCode, "ProcedureName": p.procedureName,
        "FamilyCode": p.familyCode,
        "PlannedStages": p.plannedStages ? JSON.stringify(p.plannedStages) : undefined
      };
      Object.keys(updates).forEach(function(key) {
        if (updates[key] !== undefined && updates[key] !== null && col(key) >= 0) {
          sh.getRange(i + 1, col(key) + 1).setValue(updates[key]);
        }
      });
      return { success: true };
    }
  }
  return { success: false, error: "Appointment not found: " + apptId };
}

function deleteAppointment(p) {
  var sh = getAppointmentsSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var idCol = headers.indexOf("ID");
  var apptId = String(p.apptId || "").trim();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]).trim() === apptId) {
      sh.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, error: "Appointment not found: " + apptId };
}

// ════════════════════════════════════════════════════════════
// PROCEDURE LIBRARY & TREATMENT CASES — multi-visit treatment tracking (V2)
//
// Core principle: STAGE COMPLETION is the logic. The visit number is only a
// counter. One appointment can complete several stages at once (e.g. Prep +
// Scan + Temporary done in one sitting) — the case advances by whichever
// stages were actually finished, not by "one visit = one stage".
//
// Staff never see this table or the stages array. They see three lines:
//   CURRENT: Try-in   NEXT: Final fitting   STATUS: Pending
//
// A Case is the unit that spans appointments — a persistent record, separate
// from any single appointment, holding its own ordered stages array (copied
// from the library at case creation, then modified as reality dictates).
// ════════════════════════════════════════════════════════════

var STAGE_CODES = ["P", "R", "T", "TI", "C"];
var PROCEDURE_FAMILIES = [
  "DIAGNOSTIC", "PREVENTIVE", "RESTORATIVE", "ENDODONTIC", "PROSTHODONTIC",
  "SURGICAL", "IMPLANT", "ORTHODONTIC", "AESTHETIC", "OCCLUSION_TMD"
];

// Reviews are not procedures (V2 section 3) — reusable TI stages appendable
// to any open case via appendCaseStage, rather than modelled as treatments
// of their own.
var REVIEW_STAGE_TYPES = [
  "Post-Extraction Review", "Post-Surgical Review", "RCT Review", "Crown Review",
  "Bridge Review", "Implant Review", "Denture Review", "Orthodontic Review",
  "Whitening Review", "General Treatment Review"
];

var PROCEDURE_LIBRARY_DEFAULTS = [
  {procedureCode:"NEW_PATIENT_EXAMINATION",procedureName:"New Patient Examination",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"EXAMINATION_DIAGNOSIS",stageName:"Examination + Diagnosis",completesTreatment:true},
  {procedureCode:"EMERGENCY_EXAMINATION",procedureName:"Emergency Examination",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_EMERGENCY_CARE",stageName:"Assessment + Emergency Care",completesTreatment:true},
  {procedureCode:"COMPREHENSIVE_DENTAL_EXAMINATION",procedureName:"Comprehensive Dental Examination",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"EXAMINATION_RECORDS",stageName:"Examination + Records",completesTreatment:true},
  {procedureCode:"SECOND_OPINION",procedureName:"Second Opinion",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_OPINION",stageName:"Assessment + Opinion",completesTreatment:true},
  {procedureCode:"TREATMENT_PLANNING",procedureName:"Treatment Planning",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"DIAGNOSIS_PLAN",stageName:"Diagnosis + Plan",completesTreatment:true},
  {procedureCode:"RVG_INTRAORAL_X_RAY",procedureName:"RVG / Intraoral X-ray",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"X_RAY_INTERPRETATION",stageName:"X-ray + Interpretation",completesTreatment:true},
  {procedureCode:"OPG",procedureName:"OPG",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"IMAGING_INTERPRETATION",stageName:"Imaging + Interpretation",completesTreatment:true},
  {procedureCode:"CBCT",procedureName:"CBCT",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"IMAGING_ASSESSMENT",stageName:"Imaging + Assessment",completesTreatment:true},
  {procedureCode:"DIGITAL_SCAN",procedureName:"Digital Scan",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"SCAN_RECORDS",stageName:"Scan + Records",completesTreatment:true},
  {procedureCode:"COMPREHENSIVE_SMILE_ASSESSMENT",procedureName:"Comprehensive Smile Assessment",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_RECORDS",stageName:"Assessment + Records",completesTreatment:false},
  {procedureCode:"COMPREHENSIVE_SMILE_ASSESSMENT",procedureName:"Comprehensive Smile Assessment",familyCode:"DIAGNOSTIC",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"P",stageCode:"SMILE_PLANNING",stageName:"Smile Planning",completesTreatment:true},
  {procedureCode:"SCALING",procedureName:"Scaling",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"SCALING",stageName:"Scaling",completesTreatment:true},
  {procedureCode:"SCALING_POLISHING",procedureName:"Scaling + Polishing",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"SCALING_POLISHING",stageName:"Scaling + Polishing",completesTreatment:true},
  {procedureCode:"DEEP_CLEANING_FULL_MOUTH",procedureName:"Deep Cleaning \u2013 Full Mouth",familyCode:"PREVENTIVE",visitsMin:2,visitsMax:4,sequenceNo:1,stageType:"T",stageCode:"FIRST_AREAS",stageName:"First areas",completesTreatment:false},
  {procedureCode:"DEEP_CLEANING_FULL_MOUTH",procedureName:"Deep Cleaning \u2013 Full Mouth",familyCode:"PREVENTIVE",visitsMin:2,visitsMax:4,sequenceNo:2,stageType:"T",stageCode:"REMAINING_AREAS",stageName:"Remaining areas",completesTreatment:false},
  {procedureCode:"DEEP_CLEANING_FULL_MOUTH",procedureName:"Deep Cleaning \u2013 Full Mouth",familyCode:"PREVENTIVE",visitsMin:2,visitsMax:4,sequenceNo:3,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"DEEP_CLEANING_SINGLE_AREA",procedureName:"Deep Cleaning \u2013 Single Area",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"TREATMENT",stageName:"Treatment",completesTreatment:false},
  {procedureCode:"DEEP_CLEANING_SINGLE_AREA",procedureName:"Deep Cleaning \u2013 Single Area",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"FLUORIDE_APPLICATION",procedureName:"Fluoride Application",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"APPLICATION",stageName:"Application",completesTreatment:true},
  {procedureCode:"PIT_AND_FISSURE_SEALANT",procedureName:"Pit & Fissure Sealant",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARATION_SEALANT",stageName:"Preparation + Sealant",completesTreatment:true},
  {procedureCode:"ORAL_HYGIENE_INSTRUCTION",procedureName:"Oral Hygiene Instruction",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_INSTRUCTION",stageName:"Assessment + Instruction",completesTreatment:true},
  {procedureCode:"PREVENTIVE_REVIEW",procedureName:"Preventive Review",familyCode:"PREVENTIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"COMPOSITE_FILLING_SMALL",procedureName:"Composite Filling \u2013 Small",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARE_FILL",stageName:"Prepare + Fill",completesTreatment:true},
  {procedureCode:"COMPOSITE_FILLING_LARGE",procedureName:"Composite Filling \u2013 Large",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARE_FILL",stageName:"Prepare + Fill",completesTreatment:true},
  {procedureCode:"GIC_FILLING",procedureName:"GIC Filling",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARE_FILL",stageName:"Prepare + Fill",completesTreatment:true},
  {procedureCode:"TEMPORARY_FILLING",procedureName:"Temporary Filling",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARE_FILL",stageName:"Prepare + Fill",completesTreatment:true},
  {procedureCode:"CORE_BUILD_UP",procedureName:"Core Build-Up",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARATION_BUILD_UP",stageName:"Preparation + Build-Up",completesTreatment:true},
  {procedureCode:"INLAY",procedureName:"Inlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_SCAN_IMPRESSION",stageName:"Preparation + Scan/Impression",completesTreatment:false},
  {procedureCode:"INLAY",procedureName:"Inlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN_CEMENTATION",stageName:"Try-in + Cementation",completesTreatment:true},
  {procedureCode:"ONLAY",procedureName:"Onlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_SCAN_IMPRESSION",stageName:"Preparation + Scan/Impression",completesTreatment:false},
  {procedureCode:"ONLAY",procedureName:"Onlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN_CEMENTATION",stageName:"Try-in + Cementation",completesTreatment:true},
  {procedureCode:"COMPOSITE_INLAY",procedureName:"Composite Inlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_SCAN_IMPRESSION",stageName:"Preparation + Scan/Impression",completesTreatment:false},
  {procedureCode:"COMPOSITE_INLAY",procedureName:"Composite Inlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN_BONDING",stageName:"Try-in + Bonding",completesTreatment:true},
  {procedureCode:"COMPOSITE_ONLAY",procedureName:"Composite Onlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_SCAN_IMPRESSION",stageName:"Preparation + Scan/Impression",completesTreatment:false},
  {procedureCode:"COMPOSITE_ONLAY",procedureName:"Composite Onlay",familyCode:"RESTORATIVE",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN_BONDING",stageName:"Try-in + Bonding",completesTreatment:true},
  {procedureCode:"TOOTH_BUILD_UP",procedureName:"Tooth Build-Up",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"BUILD_UP",stageName:"Build-Up",completesTreatment:true},
  {procedureCode:"REPLACING_OLD_FILLING",procedureName:"Replacing Old Filling",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"REMOVE_REPLACE",stageName:"Remove + Replace",completesTreatment:true},
  {procedureCode:"TEMPORARY_RESTORATION",procedureName:"Temporary Restoration",familyCode:"RESTORATIVE",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARATION_TEMPORARY",stageName:"Preparation + Temporary",completesTreatment:true},
  {procedureCode:"RCT_ANTERIOR",procedureName:"RCT \u2013 Anterior",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"CLEANING",stageName:"Cleaning",completesTreatment:false},
  {procedureCode:"RCT_ANTERIOR",procedureName:"RCT \u2013 Anterior",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"T",stageCode:"OBTURATION",stageName:"Obturation",completesTreatment:false},
  {procedureCode:"RCT_ANTERIOR",procedureName:"RCT \u2013 Anterior",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"RESTORATION",stageName:"Restoration",completesTreatment:true},
  {procedureCode:"RCT_PREMOLAR",procedureName:"RCT \u2013 Premolar",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"CLEANING",stageName:"Cleaning",completesTreatment:false},
  {procedureCode:"RCT_PREMOLAR",procedureName:"RCT \u2013 Premolar",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"T",stageCode:"OBTURATION",stageName:"Obturation",completesTreatment:false},
  {procedureCode:"RCT_PREMOLAR",procedureName:"RCT \u2013 Premolar",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"RESTORATION",stageName:"Restoration",completesTreatment:true},
  {procedureCode:"RCT_MOLAR",procedureName:"RCT \u2013 Molar",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"T",stageCode:"CLEANING",stageName:"Cleaning",completesTreatment:false},
  {procedureCode:"RCT_MOLAR",procedureName:"RCT \u2013 Molar",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"T",stageCode:"CLEANING_MEDICATION",stageName:"Cleaning/Medication",completesTreatment:false},
  {procedureCode:"RCT_MOLAR",procedureName:"RCT \u2013 Molar",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"T",stageCode:"OBTURATION",stageName:"Obturation",completesTreatment:false},
  {procedureCode:"RCT_MOLAR",procedureName:"RCT \u2013 Molar",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"RESTORATION",stageName:"Restoration",completesTreatment:true},
  {procedureCode:"RE_RCT_ANTERIOR",procedureName:"Re-RCT \u2013 Anterior",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"RE_TREATMENT",stageName:"Re-treatment",completesTreatment:false},
  {procedureCode:"RE_RCT_ANTERIOR",procedureName:"Re-RCT \u2013 Anterior",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"T",stageCode:"OBTURATION",stageName:"Obturation",completesTreatment:false},
  {procedureCode:"RE_RCT_ANTERIOR",procedureName:"Re-RCT \u2013 Anterior",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"RESTORATION",stageName:"Restoration",completesTreatment:true},
  {procedureCode:"RE_RCT_POSTERIOR",procedureName:"Re-RCT \u2013 Posterior",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"T",stageCode:"RE_TREATMENT",stageName:"Re-treatment",completesTreatment:false},
  {procedureCode:"RE_RCT_POSTERIOR",procedureName:"Re-RCT \u2013 Posterior",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"T",stageCode:"CLEANING_MEDICATION",stageName:"Cleaning/Medication",completesTreatment:false},
  {procedureCode:"RE_RCT_POSTERIOR",procedureName:"Re-RCT \u2013 Posterior",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"T",stageCode:"OBTURATION",stageName:"Obturation",completesTreatment:false},
  {procedureCode:"RE_RCT_POSTERIOR",procedureName:"Re-RCT \u2013 Posterior",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"RESTORATION",stageName:"Restoration",completesTreatment:true},
  {procedureCode:"RCT_POST_AND_CORE",procedureName:"RCT + Post & Core",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"T",stageCode:"RCT",stageName:"RCT",completesTreatment:false},
  {procedureCode:"RCT_POST_AND_CORE",procedureName:"RCT + Post & Core",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"T",stageCode:"COMPLETION",stageName:"Completion",completesTreatment:false},
  {procedureCode:"RCT_POST_AND_CORE",procedureName:"RCT + Post & Core",familyCode:"ENDODONTIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"C",stageCode:"POST_CORE",stageName:"Post/Core",completesTreatment:true},
  {procedureCode:"RCT_CROWN",procedureName:"RCT + Crown",familyCode:"ENDODONTIC",visitsMin:4,visitsMax:5,sequenceNo:1,stageType:"T",stageCode:"RCT",stageName:"RCT",completesTreatment:false},
  {procedureCode:"RCT_CROWN",procedureName:"RCT + Crown",familyCode:"ENDODONTIC",visitsMin:4,visitsMax:5,sequenceNo:2,stageType:"T",stageCode:"RCT_COMPLETION",stageName:"RCT Completion",completesTreatment:false},
  {procedureCode:"RCT_CROWN",procedureName:"RCT + Crown",familyCode:"ENDODONTIC",visitsMin:4,visitsMax:5,sequenceNo:3,stageType:"R",stageCode:"CROWN_PREPARATION",stageName:"Crown Preparation",completesTreatment:false},
  {procedureCode:"RCT_CROWN",procedureName:"RCT + Crown",familyCode:"ENDODONTIC",visitsMin:4,visitsMax:5,sequenceNo:4,stageType:"TI",stageCode:"CROWN",stageName:"Crown",completesTreatment:true},
  {procedureCode:"EMERGENCY_RCT",procedureName:"Emergency RCT",familyCode:"ENDODONTIC",visitsMin:1,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"EMERGENCY_TREATMENT",stageName:"Emergency Treatment",completesTreatment:false},
  {procedureCode:"EMERGENCY_RCT",procedureName:"Emergency RCT",familyCode:"ENDODONTIC",visitsMin:1,visitsMax:3,sequenceNo:2,stageType:"T",stageCode:"COMPLETION",stageName:"Completion",completesTreatment:false},
  {procedureCode:"EMERGENCY_RCT",procedureName:"Emergency RCT",familyCode:"ENDODONTIC",visitsMin:1,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"RESTORATION",stageName:"Restoration",completesTreatment:true},
  {procedureCode:"APEXIFICATION",procedureName:"Apexification",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:4,sequenceNo:1,stageType:"T",stageCode:"TREATMENT",stageName:"Treatment",completesTreatment:false},
  {procedureCode:"APEXIFICATION",procedureName:"Apexification",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:4,sequenceNo:2,stageType:"T",stageCode:"FOLLOW_UP",stageName:"Follow-up",completesTreatment:false},
  {procedureCode:"APEXIFICATION",procedureName:"Apexification",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:4,sequenceNo:3,stageType:"T",stageCode:"COMPLETION",stageName:"Completion",completesTreatment:false},
  {procedureCode:"APEXIFICATION",procedureName:"Apexification",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"RESTORATION",stageName:"Restoration",completesTreatment:true},
  {procedureCode:"APICAL_SURGERY",procedureName:"Apical Surgery",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"SURGERY",stageName:"Surgery",completesTreatment:false},
  {procedureCode:"APICAL_SURGERY",procedureName:"Apical Surgery",familyCode:"ENDODONTIC",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"SINGLE_CROWN",procedureName:"Single Crown",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_SCAN_IMPRESSION",stageName:"Preparation + Scan/Impression",completesTreatment:false},
  {procedureCode:"SINGLE_CROWN",procedureName:"Single Crown",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"SINGLE_CROWN",procedureName:"Single Crown",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"FINAL_FITTING",stageName:"Final Fitting",completesTreatment:true},
  {procedureCode:"MULTIPLE_CROWNS",procedureName:"Multiple Crowns",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:6,sequenceNo:1,stageType:"R",stageCode:"PREPARATION",stageName:"Preparation",completesTreatment:false},
  {procedureCode:"MULTIPLE_CROWNS",procedureName:"Multiple Crowns",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:6,sequenceNo:2,stageType:"TI",stageCode:"PROVISIONAL_TRY_IN",stageName:"Provisional/Try-In",completesTreatment:false},
  {procedureCode:"MULTIPLE_CROWNS",procedureName:"Multiple Crowns",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:6,sequenceNo:3,stageType:"TI",stageCode:"FINAL_TRY_IN",stageName:"Final Try-In",completesTreatment:false},
  {procedureCode:"MULTIPLE_CROWNS",procedureName:"Multiple Crowns",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:6,sequenceNo:4,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"CROWN_REPLACEMENT",procedureName:"Crown Replacement",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"REMOVE_PREPARE",stageName:"Remove + Prepare",completesTreatment:false},
  {procedureCode:"CROWN_REPLACEMENT",procedureName:"Crown Replacement",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"CROWN_REPLACEMENT",procedureName:"Crown Replacement",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"TEMPORARY_CROWN",procedureName:"Temporary Crown",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_TEMPORARY",stageName:"Preparation + Temporary",completesTreatment:true},
  {procedureCode:"SINGLE_BRIDGE",procedureName:"Single Bridge",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_SCAN_IMPRESSION",stageName:"Preparation + Scan/Impression",completesTreatment:false},
  {procedureCode:"SINGLE_BRIDGE",procedureName:"Single Bridge",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"SINGLE_BRIDGE",procedureName:"Single Bridge",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"MULTIPLE_UNIT_BRIDGE",procedureName:"Multiple-Unit Bridge",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"R",stageCode:"PREPARATION",stageName:"Preparation",completesTreatment:false},
  {procedureCode:"MULTIPLE_UNIT_BRIDGE",procedureName:"Multiple-Unit Bridge",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"TI",stageCode:"FRAMEWORK_TRY_IN",stageName:"Framework/Try-In",completesTreatment:false},
  {procedureCode:"MULTIPLE_UNIT_BRIDGE",procedureName:"Multiple-Unit Bridge",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"TI",stageCode:"FINAL_TRY_IN",stageName:"Final Try-In",completesTreatment:false},
  {procedureCode:"MULTIPLE_UNIT_BRIDGE",procedureName:"Multiple-Unit Bridge",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"BRIDGE_REPLACEMENT",procedureName:"Bridge Replacement",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"REMOVE_PREPARE",stageName:"Remove + Prepare",completesTreatment:false},
  {procedureCode:"BRIDGE_REPLACEMENT",procedureName:"Bridge Replacement",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"BRIDGE_REPLACEMENT",procedureName:"Bridge Replacement",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"TEMPORARY_BRIDGE",procedureName:"Temporary Bridge",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_TEMPORARY",stageName:"Preparation + Temporary",completesTreatment:true},
  {procedureCode:"POST_AND_CORE",procedureName:"Post & Core",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"POST_PREPARATION",stageName:"Post Preparation",completesTreatment:false},
  {procedureCode:"POST_AND_CORE",procedureName:"Post & Core",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"POST_CORE",stageName:"Post/Core",completesTreatment:true},
  {procedureCode:"CROWN_ON_POST_AND_CORE",procedureName:"Crown on Post & Core",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"CROWN_PREPARATION",stageName:"Crown Preparation",completesTreatment:false},
  {procedureCode:"CROWN_ON_POST_AND_CORE",procedureName:"Crown on Post & Core",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"CROWN_ON_POST_AND_CORE",procedureName:"Crown on Post & Core",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"SINGLE_VENEER",procedureName:"Single Veneer",familyCode:"AESTHETIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_SCAN_IMPRESSION",stageName:"Preparation + Scan/Impression",completesTreatment:false},
  {procedureCode:"SINGLE_VENEER",procedureName:"Single Veneer",familyCode:"AESTHETIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"SINGLE_VENEER",procedureName:"Single Veneer",familyCode:"AESTHETIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"BONDING",stageName:"Bonding",completesTreatment:true},
  {procedureCode:"MULTIPLE_VENEERS",procedureName:"Multiple Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"P",stageCode:"PLANNING_PREPARATION",stageName:"Planning + Preparation",completesTreatment:false},
  {procedureCode:"MULTIPLE_VENEERS",procedureName:"Multiple Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"MULTIPLE_VENEERS",procedureName:"Multiple Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"C",stageCode:"BONDING",stageName:"Bonding",completesTreatment:false},
  {procedureCode:"MULTIPLE_VENEERS",procedureName:"Multiple Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"COMPOSITE_VENEER",procedureName:"Composite Veneer",familyCode:"AESTHETIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"PREPARATION_COMPOSITE",stageName:"Preparation + Composite",completesTreatment:true},
  {procedureCode:"SMILE_MAKEOVER",procedureName:"Smile Makeover",familyCode:"AESTHETIC",visitsMin:3,visitsMax:6,sequenceNo:1,stageType:"P",stageCode:"SMILE_DESIGN",stageName:"Smile Design",completesTreatment:false},
  {procedureCode:"SMILE_MAKEOVER",procedureName:"Smile Makeover",familyCode:"AESTHETIC",visitsMin:3,visitsMax:6,sequenceNo:2,stageType:"R",stageCode:"PREPARATION_PROVISIONALS",stageName:"Preparation + Provisionals",completesTreatment:false},
  {procedureCode:"SMILE_MAKEOVER",procedureName:"Smile Makeover",familyCode:"AESTHETIC",visitsMin:3,visitsMax:6,sequenceNo:3,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"SMILE_MAKEOVER",procedureName:"Smile Makeover",familyCode:"AESTHETIC",visitsMin:3,visitsMax:6,sequenceNo:4,stageType:"C",stageCode:"FINAL_BONDING",stageName:"Final Bonding",completesTreatment:true},
  {procedureCode:"WHITENING_VENEERS",procedureName:"Whitening + Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_WHITENING",stageName:"Assessment + Whitening",completesTreatment:false},
  {procedureCode:"WHITENING_VENEERS",procedureName:"Whitening + Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"R",stageCode:"PREPARATION",stageName:"Preparation",completesTreatment:false},
  {procedureCode:"WHITENING_VENEERS",procedureName:"Whitening + Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"WHITENING_VENEERS",procedureName:"Whitening + Veneers",familyCode:"AESTHETIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"BONDING",stageName:"Bonding",completesTreatment:true},
  {procedureCode:"DIASTEMA_CLOSURE",procedureName:"Diastema Closure",familyCode:"AESTHETIC",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"CLOSURE",stageName:"Closure",completesTreatment:false},
  {procedureCode:"DIASTEMA_CLOSURE",procedureName:"Diastema Closure",familyCode:"AESTHETIC",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"AESTHETIC_RECONTOURING",procedureName:"Aesthetic Recontouring",familyCode:"AESTHETIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"RECONTOURING",stageName:"Recontouring",completesTreatment:true},
  {procedureCode:"SIMPLE_EXTRACTION",procedureName:"Simple Extraction",familyCode:"SURGICAL",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"EXTRACTION",stageName:"Extraction",completesTreatment:true},
  {procedureCode:"SURGICAL_EXTRACTION",procedureName:"Surgical Extraction",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"SURGERY",stageName:"Surgery",completesTreatment:false},
  {procedureCode:"SURGICAL_EXTRACTION",procedureName:"Surgical Extraction",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"WISDOM_TOOTH_EXTRACTION",procedureName:"Wisdom Tooth Extraction",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"EXTRACTION",stageName:"Extraction",completesTreatment:false},
  {procedureCode:"WISDOM_TOOTH_EXTRACTION",procedureName:"Wisdom Tooth Extraction",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"SURGICAL_WISDOM_TOOTH_REMOVAL",procedureName:"Surgical Wisdom Tooth Removal",familyCode:"SURGICAL",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"SURGERY",stageName:"Surgery",completesTreatment:false},
  {procedureCode:"SURGICAL_WISDOM_TOOTH_REMOVAL",procedureName:"Surgical Wisdom Tooth Removal",familyCode:"SURGICAL",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW_SUTURE_REMOVAL",stageName:"Review/Suture Removal",completesTreatment:true},
  {procedureCode:"APICOECTOMY",procedureName:"Apicoectomy",familyCode:"SURGICAL",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"SURGERY",stageName:"Surgery",completesTreatment:false},
  {procedureCode:"APICOECTOMY",procedureName:"Apicoectomy",familyCode:"SURGICAL",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"FRENECTOMY",procedureName:"Frenectomy",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"PROCEDURE",stageName:"Procedure",completesTreatment:false},
  {procedureCode:"FRENECTOMY",procedureName:"Frenectomy",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"SOFT_TISSUE_PROCEDURE",procedureName:"Soft Tissue Procedure",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"PROCEDURE",stageName:"Procedure",completesTreatment:false},
  {procedureCode:"SOFT_TISSUE_PROCEDURE",procedureName:"Soft Tissue Procedure",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"BIOPSY",procedureName:"Biopsy",familyCode:"SURGICAL",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"BIOPSY",stageName:"Biopsy",completesTreatment:false},
  {procedureCode:"BIOPSY",procedureName:"Biopsy",familyCode:"SURGICAL",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"REVIEW_REPORT",stageName:"Review/Report",completesTreatment:true},
  {procedureCode:"ALVEOLOPLASTY",procedureName:"Alveoloplasty",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"PROCEDURE",stageName:"Procedure",completesTreatment:false},
  {procedureCode:"ALVEOLOPLASTY",procedureName:"Alveoloplasty",familyCode:"SURGICAL",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"IMPLANT_CONSULTATION",procedureName:"Implant Consultation",familyCode:"IMPLANT",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_PLANNING",stageName:"Assessment + Planning",completesTreatment:true},
  {procedureCode:"IMPLANT_PLANNING",procedureName:"Implant Planning",familyCode:"IMPLANT",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"P",stageCode:"RECORDS_IMAGING",stageName:"Records + Imaging",completesTreatment:false},
  {procedureCode:"IMPLANT_PLANNING",procedureName:"Implant Planning",familyCode:"IMPLANT",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"P",stageCode:"TREATMENT_PLAN",stageName:"Treatment Plan",completesTreatment:true},
  {procedureCode:"SINGLE_IMPLANT_PLACEMENT",procedureName:"Single Implant Placement",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"IMPLANT_PLACEMENT",stageName:"Implant Placement",completesTreatment:false},
  {procedureCode:"SINGLE_IMPLANT_PLACEMENT",procedureName:"Single Implant Placement",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"HEALING_REVIEW",stageName:"Healing Review",completesTreatment:false},
  {procedureCode:"SINGLE_IMPLANT_PLACEMENT",procedureName:"Single Implant Placement",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"TI",stageCode:"IMPLANT_REVIEW",stageName:"Implant Review",completesTreatment:true},
  {procedureCode:"MULTIPLE_IMPLANT_PLACEMENT",procedureName:"Multiple Implant Placement",familyCode:"IMPLANT",visitsMin:2,visitsMax:4,sequenceNo:1,stageType:"T",stageCode:"IMPLANT_PLACEMENT",stageName:"Implant Placement",completesTreatment:false},
  {procedureCode:"MULTIPLE_IMPLANT_PLACEMENT",procedureName:"Multiple Implant Placement",familyCode:"IMPLANT",visitsMin:2,visitsMax:4,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:false},
  {procedureCode:"MULTIPLE_IMPLANT_PLACEMENT",procedureName:"Multiple Implant Placement",familyCode:"IMPLANT",visitsMin:2,visitsMax:4,sequenceNo:3,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:true},
  {procedureCode:"BONE_GRAFTING",procedureName:"Bone Grafting",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"GRAFTING",stageName:"Grafting",completesTreatment:false},
  {procedureCode:"BONE_GRAFTING",procedureName:"Bone Grafting",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:false},
  {procedureCode:"BONE_GRAFTING",procedureName:"Bone Grafting",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:true},
  {procedureCode:"SINUS_LIFT",procedureName:"Sinus Lift",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"SINUS_LIFT",stageName:"Sinus Lift",completesTreatment:false},
  {procedureCode:"SINUS_LIFT",procedureName:"Sinus Lift",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:false},
  {procedureCode:"SINUS_LIFT",procedureName:"Sinus Lift",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:true},
  {procedureCode:"IMPLANT_CROWN",procedureName:"Implant + Crown",familyCode:"IMPLANT",visitsMin:3,visitsMax:5,sequenceNo:1,stageType:"T",stageCode:"IMPLANT_PLACEMENT",stageName:"Implant Placement",completesTreatment:false},
  {procedureCode:"IMPLANT_CROWN",procedureName:"Implant + Crown",familyCode:"IMPLANT",visitsMin:3,visitsMax:5,sequenceNo:2,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:false},
  {procedureCode:"IMPLANT_CROWN",procedureName:"Implant + Crown",familyCode:"IMPLANT",visitsMin:3,visitsMax:5,sequenceNo:3,stageType:"R",stageCode:"SCAN_IMPRESSION",stageName:"Scan/Impression",completesTreatment:false},
  {procedureCode:"IMPLANT_CROWN",procedureName:"Implant + Crown",familyCode:"IMPLANT",visitsMin:3,visitsMax:5,sequenceNo:4,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"IMPLANT_CROWN",procedureName:"Implant + Crown",familyCode:"IMPLANT",visitsMin:3,visitsMax:5,sequenceNo:5,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"IMPLANT_BRIDGE",procedureName:"Implant + Bridge",familyCode:"IMPLANT",visitsMin:4,visitsMax:6,sequenceNo:1,stageType:"T",stageCode:"IMPLANT_PLACEMENT",stageName:"Implant Placement",completesTreatment:false},
  {procedureCode:"IMPLANT_BRIDGE",procedureName:"Implant + Bridge",familyCode:"IMPLANT",visitsMin:4,visitsMax:6,sequenceNo:2,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:false},
  {procedureCode:"IMPLANT_BRIDGE",procedureName:"Implant + Bridge",familyCode:"IMPLANT",visitsMin:4,visitsMax:6,sequenceNo:3,stageType:"R",stageCode:"SCAN_IMPRESSION",stageName:"Scan/Impression",completesTreatment:false},
  {procedureCode:"IMPLANT_BRIDGE",procedureName:"Implant + Bridge",familyCode:"IMPLANT",visitsMin:4,visitsMax:6,sequenceNo:4,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"IMPLANT_BRIDGE",procedureName:"Implant + Bridge",familyCode:"IMPLANT",visitsMin:4,visitsMax:6,sequenceNo:5,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"IMPLANT_SUPPORTED_DENTURE",procedureName:"Implant-Supported Denture",familyCode:"IMPLANT",visitsMin:5,visitsMax:7,sequenceNo:1,stageType:"P",stageCode:"PLANNING",stageName:"Planning",completesTreatment:false},
  {procedureCode:"IMPLANT_SUPPORTED_DENTURE",procedureName:"Implant-Supported Denture",familyCode:"IMPLANT",visitsMin:5,visitsMax:7,sequenceNo:2,stageType:"T",stageCode:"IMPLANT_PLACEMENT",stageName:"Implant Placement",completesTreatment:false},
  {procedureCode:"IMPLANT_SUPPORTED_DENTURE",procedureName:"Implant-Supported Denture",familyCode:"IMPLANT",visitsMin:5,visitsMax:7,sequenceNo:3,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:false},
  {procedureCode:"IMPLANT_SUPPORTED_DENTURE",procedureName:"Implant-Supported Denture",familyCode:"IMPLANT",visitsMin:5,visitsMax:7,sequenceNo:4,stageType:"R",stageCode:"IMPRESSION_TRY_IN",stageName:"Impression + Try-In",completesTreatment:false},
  {procedureCode:"IMPLANT_SUPPORTED_DENTURE",procedureName:"Implant-Supported Denture",familyCode:"IMPLANT",visitsMin:5,visitsMax:7,sequenceNo:5,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"IMPLANT_CROWN_REPLACEMENT",procedureName:"Implant Crown Replacement",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"SCAN_IMPRESSION",stageName:"Scan/Impression",completesTreatment:false},
  {procedureCode:"IMPLANT_CROWN_REPLACEMENT",procedureName:"Implant Crown Replacement",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"IMPLANT_CROWN_REPLACEMENT",procedureName:"Implant Crown Replacement",familyCode:"IMPLANT",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"FITTING",stageName:"Fitting",completesTreatment:true},
  {procedureCode:"IMPLANT_REVIEW",procedureName:"Implant Review",familyCode:"IMPLANT",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"TI",stageCode:"IMPLANT_ASSESSMENT",stageName:"Implant Assessment",completesTreatment:true},
  {procedureCode:"COMPLETE_DENTURE",procedureName:"Complete Denture",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:5,sequenceNo:1,stageType:"R",stageCode:"PRIMARY_IMPRESSION",stageName:"Primary Impression",completesTreatment:false},
  {procedureCode:"COMPLETE_DENTURE",procedureName:"Complete Denture",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:5,sequenceNo:2,stageType:"R",stageCode:"FINAL_IMPRESSION",stageName:"Final Impression",completesTreatment:false},
  {procedureCode:"COMPLETE_DENTURE",procedureName:"Complete Denture",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:5,sequenceNo:3,stageType:"R",stageCode:"JAW_RELATION",stageName:"Jaw Relation",completesTreatment:false},
  {procedureCode:"COMPLETE_DENTURE",procedureName:"Complete Denture",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:5,sequenceNo:4,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"COMPLETE_DENTURE",procedureName:"Complete Denture",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:5,sequenceNo:5,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"IMMEDIATE_DENTURE",procedureName:"Immediate Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"R",stageCode:"IMPRESSION_PLANNING",stageName:"Impression + Planning",completesTreatment:false},
  {procedureCode:"IMMEDIATE_DENTURE",procedureName:"Immediate Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"T",stageCode:"EXTRACTION_DELIVERY",stageName:"Extraction + Delivery",completesTreatment:false},
  {procedureCode:"IMMEDIATE_DENTURE",procedureName:"Immediate Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"TI",stageCode:"ADJUSTMENT",stageName:"Adjustment",completesTreatment:false},
  {procedureCode:"IMMEDIATE_DENTURE",procedureName:"Immediate Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"FINAL_ADJUSTMENT",stageName:"Final Adjustment",completesTreatment:true},
  {procedureCode:"ACRYLIC_PARTIAL_DENTURE",procedureName:"Acrylic Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"R",stageCode:"IMPRESSION",stageName:"Impression",completesTreatment:false},
  {procedureCode:"ACRYLIC_PARTIAL_DENTURE",procedureName:"Acrylic Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"ACRYLIC_PARTIAL_DENTURE",procedureName:"Acrylic Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"TI",stageCode:"ADJUSTMENT",stageName:"Adjustment",completesTreatment:false},
  {procedureCode:"ACRYLIC_PARTIAL_DENTURE",procedureName:"Acrylic Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"CAST_PARTIAL_DENTURE",procedureName:"Cast Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:4,visitsMax:5,sequenceNo:1,stageType:"R",stageCode:"PREPARATION_IMPRESSION",stageName:"Preparation + Impression",completesTreatment:false},
  {procedureCode:"CAST_PARTIAL_DENTURE",procedureName:"Cast Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:4,visitsMax:5,sequenceNo:2,stageType:"TI",stageCode:"FRAMEWORK",stageName:"Framework",completesTreatment:false},
  {procedureCode:"CAST_PARTIAL_DENTURE",procedureName:"Cast Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:4,visitsMax:5,sequenceNo:3,stageType:"R",stageCode:"BITE_REGISTRATION",stageName:"Bite Registration",completesTreatment:false},
  {procedureCode:"CAST_PARTIAL_DENTURE",procedureName:"Cast Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:4,visitsMax:5,sequenceNo:4,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"CAST_PARTIAL_DENTURE",procedureName:"Cast Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:4,visitsMax:5,sequenceNo:5,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"FLEXIBLE_PARTIAL_DENTURE",procedureName:"Flexible Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:1,stageType:"R",stageCode:"IMPRESSION",stageName:"Impression",completesTreatment:false},
  {procedureCode:"FLEXIBLE_PARTIAL_DENTURE",procedureName:"Flexible Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:2,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"FLEXIBLE_PARTIAL_DENTURE",procedureName:"Flexible Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:3,stageType:"TI",stageCode:"ADJUSTMENT",stageName:"Adjustment",completesTreatment:false},
  {procedureCode:"FLEXIBLE_PARTIAL_DENTURE",procedureName:"Flexible Partial Denture",familyCode:"PROSTHODONTIC",visitsMin:3,visitsMax:4,sequenceNo:4,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"DENTURE_RELINING",procedureName:"Denture Relining",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"IMPRESSION",stageName:"Impression",completesTreatment:false},
  {procedureCode:"DENTURE_RELINING",procedureName:"Denture Relining",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"DENTURE_REBASING",procedureName:"Denture Rebasing",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"IMPRESSION",stageName:"Impression",completesTreatment:false},
  {procedureCode:"DENTURE_REBASING",procedureName:"Denture Rebasing",familyCode:"PROSTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"DENTURE_REPAIR",procedureName:"Denture Repair",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"ASSESSMENT_REPAIR",stageName:"Assessment + Repair",completesTreatment:false},
  {procedureCode:"DENTURE_REPAIR",procedureName:"Denture Repair",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"DENTURE_ADJUSTMENT",procedureName:"Denture Adjustment",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"TI",stageCode:"ASSESSMENT_ADJUSTMENT",stageName:"Assessment + Adjustment",completesTreatment:false},
  {procedureCode:"DENTURE_ADJUSTMENT",procedureName:"Denture Adjustment",familyCode:"PROSTHODONTIC",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"IN_OFFICE_BLEACHING",procedureName:"In-Office Bleaching",familyCode:"AESTHETIC",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"BLEACHING",stageName:"Bleaching",completesTreatment:false},
  {procedureCode:"IN_OFFICE_BLEACHING",procedureName:"In-Office Bleaching",familyCode:"AESTHETIC",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"TAKE_HOME_BLEACHING",procedureName:"Take-Home Bleaching",familyCode:"AESTHETIC",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"SCAN_IMPRESSION",stageName:"Scan/Impression",completesTreatment:false},
  {procedureCode:"TAKE_HOME_BLEACHING",procedureName:"Take-Home Bleaching",familyCode:"AESTHETIC",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"TRAY_DELIVERY",stageName:"Tray Delivery",completesTreatment:true},
  {procedureCode:"COMBINATION_BLEACHING",procedureName:"Combination Bleaching",familyCode:"AESTHETIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"T",stageCode:"IN_OFFICE",stageName:"In-Office",completesTreatment:false},
  {procedureCode:"COMBINATION_BLEACHING",procedureName:"Combination Bleaching",familyCode:"AESTHETIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"C",stageCode:"HOME_KIT",stageName:"Home Kit",completesTreatment:false},
  {procedureCode:"COMBINATION_BLEACHING",procedureName:"Combination Bleaching",familyCode:"AESTHETIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"WHITENING_REVIEW",procedureName:"Whitening Review",familyCode:"AESTHETIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"COSMETIC_CONSULTATION",procedureName:"Cosmetic Consultation",familyCode:"AESTHETIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_PLANNING",stageName:"Assessment + Planning",completesTreatment:true},
  {procedureCode:"ORTHODONTIC_CONSULTATION",procedureName:"Orthodontic Consultation",familyCode:"ORTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"EXAMINATION_PLANNING",stageName:"Examination + Planning",completesTreatment:true},
  {procedureCode:"ORTHODONTIC_RECORDS",procedureName:"Orthodontic Records",familyCode:"ORTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"RECORDS",stageName:"Records",completesTreatment:true},
  {procedureCode:"FIXED_BRACES_INITIAL",procedureName:"Fixed Braces \u2013 Initial",familyCode:"ORTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"P",stageCode:"PLANNING",stageName:"Planning",completesTreatment:false},
  {procedureCode:"FIXED_BRACES_INITIAL",procedureName:"Fixed Braces \u2013 Initial",familyCode:"ORTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"T",stageCode:"BONDING",stageName:"Bonding",completesTreatment:true},
  {procedureCode:"FIXED_BRACES_ADJUSTMENT",procedureName:"Fixed Braces \u2013 Adjustment",familyCode:"ORTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"T",stageCode:"ADJUSTMENT",stageName:"Adjustment",completesTreatment:true},
  {procedureCode:"CLEAR_ALIGNERS_PLANNING",procedureName:"Clear Aligners \u2013 Planning",familyCode:"ORTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"P",stageCode:"RECORDS_SCAN",stageName:"Records + Scan",completesTreatment:false},
  {procedureCode:"CLEAR_ALIGNERS_PLANNING",procedureName:"Clear Aligners \u2013 Planning",familyCode:"ORTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"P",stageCode:"TREATMENT_PLAN",stageName:"Treatment Plan",completesTreatment:false},
  {procedureCode:"CLEAR_ALIGNERS_PLANNING",procedureName:"Clear Aligners \u2013 Planning",familyCode:"ORTHODONTIC",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"C",stageCode:"PLAN_APPROVAL",stageName:"Plan Approval",completesTreatment:true},
  {procedureCode:"CLEAR_ALIGNER_DELIVERY",procedureName:"Clear Aligner Delivery",familyCode:"ORTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"C",stageCode:"ALIGNER_DELIVERY_INSTRUCTIONS",stageName:"Aligner Delivery + Instructions",completesTreatment:true},
  {procedureCode:"CLEAR_ALIGNER_REVIEW",procedureName:"Clear Aligner Review",familyCode:"ORTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"TI",stageCode:"REVIEW_CHANGE",stageName:"Review + Change",completesTreatment:true},
  {procedureCode:"RETAINER",procedureName:"Retainer",familyCode:"ORTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"SCAN_IMPRESSION",stageName:"Scan/Impression",completesTreatment:false},
  {procedureCode:"RETAINER",procedureName:"Retainer",familyCode:"ORTHODONTIC",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"RETAINER_REVIEW",procedureName:"Retainer Review",familyCode:"ORTHODONTIC",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"OCCLUSAL_ASSESSMENT",procedureName:"Occlusal Assessment",familyCode:"OCCLUSION_TMD",visitsMin:1,visitsMax:1,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT",stageName:"Assessment",completesTreatment:true},
  {procedureCode:"OCCLUSAL_ADJUSTMENT",procedureName:"Occlusal Adjustment",familyCode:"OCCLUSION_TMD",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"T",stageCode:"ADJUSTMENT",stageName:"Adjustment",completesTreatment:false},
  {procedureCode:"OCCLUSAL_ADJUSTMENT",procedureName:"Occlusal Adjustment",familyCode:"OCCLUSION_TMD",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"NIGHT_GUARD",procedureName:"Night Guard",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"SCAN_IMPRESSION",stageName:"Scan/Impression",completesTreatment:false},
  {procedureCode:"NIGHT_GUARD",procedureName:"Night Guard",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"DELIVERY_ADJUSTMENT",stageName:"Delivery + Adjustment",completesTreatment:true},
  {procedureCode:"OCCLUSAL_SPLINT",procedureName:"Occlusal Splint",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_RECORDS",stageName:"Assessment + Records",completesTreatment:false},
  {procedureCode:"OCCLUSAL_SPLINT",procedureName:"Occlusal Splint",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:false},
  {procedureCode:"OCCLUSAL_SPLINT",procedureName:"Occlusal Splint",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"TI",stageCode:"ADJUSTMENT",stageName:"Adjustment",completesTreatment:true},
  {procedureCode:"TMD_ASSESSMENT",procedureName:"TMD Assessment",familyCode:"OCCLUSION_TMD",visitsMin:1,visitsMax:2,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT",stageName:"Assessment",completesTreatment:false},
  {procedureCode:"TMD_ASSESSMENT",procedureName:"TMD Assessment",familyCode:"OCCLUSION_TMD",visitsMin:1,visitsMax:2,sequenceNo:2,stageType:"P",stageCode:"TREATMENT_PLAN",stageName:"Treatment Plan",completesTreatment:true},
  {procedureCode:"TMD_APPLIANCE",procedureName:"TMD Appliance",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"R",stageCode:"RECORDS",stageName:"Records",completesTreatment:false},
  {procedureCode:"TMD_APPLIANCE",procedureName:"TMD Appliance",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:false},
  {procedureCode:"TMD_APPLIANCE",procedureName:"TMD Appliance",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"TI",stageCode:"ADJUSTMENT",stageName:"Adjustment",completesTreatment:true},
  {procedureCode:"SPORTS_MOUTHGUARD",procedureName:"Sports Mouthguard",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:2,sequenceNo:1,stageType:"R",stageCode:"SCAN_IMPRESSION",stageName:"Scan/Impression",completesTreatment:false},
  {procedureCode:"SPORTS_MOUTHGUARD",procedureName:"Sports Mouthguard",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:2,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:true},
  {procedureCode:"HABIT_APPLIANCE",procedureName:"Habit Appliance",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:1,stageType:"P",stageCode:"ASSESSMENT_RECORDS",stageName:"Assessment + Records",completesTreatment:false},
  {procedureCode:"HABIT_APPLIANCE",procedureName:"Habit Appliance",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:2,stageType:"C",stageCode:"DELIVERY",stageName:"Delivery",completesTreatment:false},
  {procedureCode:"HABIT_APPLIANCE",procedureName:"Habit Appliance",familyCode:"OCCLUSION_TMD",visitsMin:2,visitsMax:3,sequenceNo:3,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"FULL_MOUTH_REHABILITATION",procedureName:"Full Mouth Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:1,stageType:"P",stageCode:"DIAGNOSIS_PLANNING",stageName:"Diagnosis + Planning",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_REHABILITATION",procedureName:"Full Mouth Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:2,stageType:"R",stageCode:"PREPARATORY_TREATMENT",stageName:"Preparatory Treatment",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_REHABILITATION",procedureName:"Full Mouth Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:3,stageType:"R",stageCode:"PREPARATIONS",stageName:"Preparations",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_REHABILITATION",procedureName:"Full Mouth Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:4,stageType:"TI",stageCode:"PROVISIONALS_TRY_IN",stageName:"Provisionals/Try-In",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_REHABILITATION",procedureName:"Full Mouth Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:5,stageType:"C",stageCode:"FINAL",stageName:"Final",completesTreatment:true},
  {procedureCode:"FULL_MOUTH_CROWNS",procedureName:"Full Mouth Crowns",familyCode:"PROSTHODONTIC",visitsMin:6,visitsMax:12,sequenceNo:1,stageType:"P",stageCode:"PLANNING",stageName:"Planning",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_CROWNS",procedureName:"Full Mouth Crowns",familyCode:"PROSTHODONTIC",visitsMin:6,visitsMax:12,sequenceNo:2,stageType:"R",stageCode:"PREPARATION",stageName:"Preparation",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_CROWNS",procedureName:"Full Mouth Crowns",familyCode:"PROSTHODONTIC",visitsMin:6,visitsMax:12,sequenceNo:3,stageType:"R",stageCode:"PROVISIONALS",stageName:"Provisionals",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_CROWNS",procedureName:"Full Mouth Crowns",familyCode:"PROSTHODONTIC",visitsMin:6,visitsMax:12,sequenceNo:4,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_CROWNS",procedureName:"Full Mouth Crowns",familyCode:"PROSTHODONTIC",visitsMin:6,visitsMax:12,sequenceNo:5,stageType:"C",stageCode:"FINAL",stageName:"Final",completesTreatment:true},
  {procedureCode:"FULL_MOUTH_VENEERS",procedureName:"Full Mouth Veneers",familyCode:"AESTHETIC",visitsMin:4,visitsMax:8,sequenceNo:1,stageType:"P",stageCode:"SMILE_DESIGN",stageName:"Smile Design",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_VENEERS",procedureName:"Full Mouth Veneers",familyCode:"AESTHETIC",visitsMin:4,visitsMax:8,sequenceNo:2,stageType:"R",stageCode:"PREPARATION",stageName:"Preparation",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_VENEERS",procedureName:"Full Mouth Veneers",familyCode:"AESTHETIC",visitsMin:4,visitsMax:8,sequenceNo:3,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_VENEERS",procedureName:"Full Mouth Veneers",familyCode:"AESTHETIC",visitsMin:4,visitsMax:8,sequenceNo:4,stageType:"C",stageCode:"BONDING",stageName:"Bonding",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_VENEERS",procedureName:"Full Mouth Veneers",familyCode:"AESTHETIC",visitsMin:4,visitsMax:8,sequenceNo:5,stageType:"TI",stageCode:"REVIEW",stageName:"Review",completesTreatment:true},
  {procedureCode:"FULL_MOUTH_RECONSTRUCTION",procedureName:"Full Mouth Reconstruction",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:1,stageType:"P",stageCode:"DIAGNOSIS",stageName:"Diagnosis",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_RECONSTRUCTION",procedureName:"Full Mouth Reconstruction",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:2,stageType:"T",stageCode:"DISEASE_CONTROL",stageName:"Disease Control",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_RECONSTRUCTION",procedureName:"Full Mouth Reconstruction",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:3,stageType:"R",stageCode:"PREPARATIONS",stageName:"Preparations",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_RECONSTRUCTION",procedureName:"Full Mouth Reconstruction",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:4,stageType:"TI",stageCode:"PROVISIONAL",stageName:"Provisional",completesTreatment:false},
  {procedureCode:"FULL_MOUTH_RECONSTRUCTION",procedureName:"Full Mouth Reconstruction",familyCode:"PROSTHODONTIC",visitsMin:8,visitsMax:15,sequenceNo:5,stageType:"C",stageCode:"FINAL",stageName:"Final",completesTreatment:true},
  {procedureCode:"MULTIPLE_IMPLANT_REHABILITATION",procedureName:"Multiple Implant Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:1,stageType:"P",stageCode:"PLANNING",stageName:"Planning",completesTreatment:false},
  {procedureCode:"MULTIPLE_IMPLANT_REHABILITATION",procedureName:"Multiple Implant Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:2,stageType:"T",stageCode:"SURGERY",stageName:"Surgery",completesTreatment:false},
  {procedureCode:"MULTIPLE_IMPLANT_REHABILITATION",procedureName:"Multiple Implant Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:3,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:false},
  {procedureCode:"MULTIPLE_IMPLANT_REHABILITATION",procedureName:"Multiple Implant Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:4,stageType:"R",stageCode:"RECORDS",stageName:"Records",completesTreatment:false},
  {procedureCode:"MULTIPLE_IMPLANT_REHABILITATION",procedureName:"Multiple Implant Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:5,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"MULTIPLE_IMPLANT_REHABILITATION",procedureName:"Multiple Implant Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:6,stageType:"C",stageCode:"FINAL",stageName:"Final",completesTreatment:true},
  {procedureCode:"IMPLANT_FULL_ARCH_REHABILITATION",procedureName:"Implant + Full Arch Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:1,stageType:"P",stageCode:"PLANNING",stageName:"Planning",completesTreatment:false},
  {procedureCode:"IMPLANT_FULL_ARCH_REHABILITATION",procedureName:"Implant + Full Arch Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:2,stageType:"T",stageCode:"IMPLANT_SURGERY",stageName:"Implant Surgery",completesTreatment:false},
  {procedureCode:"IMPLANT_FULL_ARCH_REHABILITATION",procedureName:"Implant + Full Arch Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:3,stageType:"TI",stageCode:"HEALING",stageName:"Healing",completesTreatment:false},
  {procedureCode:"IMPLANT_FULL_ARCH_REHABILITATION",procedureName:"Implant + Full Arch Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:4,stageType:"TI",stageCode:"PROVISIONAL",stageName:"Provisional",completesTreatment:false},
  {procedureCode:"IMPLANT_FULL_ARCH_REHABILITATION",procedureName:"Implant + Full Arch Rehabilitation",familyCode:"IMPLANT",visitsMin:8,visitsMax:15,sequenceNo:5,stageType:"C",stageCode:"FINAL",stageName:"Final",completesTreatment:true},
  {procedureCode:"COMPLEX_SMILE_REHABILITATION",procedureName:"Complex Smile Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:10,sequenceNo:1,stageType:"P",stageCode:"PLANNING",stageName:"Planning",completesTreatment:false},
  {procedureCode:"COMPLEX_SMILE_REHABILITATION",procedureName:"Complex Smile Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:10,sequenceNo:2,stageType:"R",stageCode:"PREPARATION",stageName:"Preparation",completesTreatment:false},
  {procedureCode:"COMPLEX_SMILE_REHABILITATION",procedureName:"Complex Smile Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:10,sequenceNo:3,stageType:"TI",stageCode:"PROVISIONAL",stageName:"Provisional",completesTreatment:false},
  {procedureCode:"COMPLEX_SMILE_REHABILITATION",procedureName:"Complex Smile Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:10,sequenceNo:4,stageType:"TI",stageCode:"TRY_IN",stageName:"Try-In",completesTreatment:false},
  {procedureCode:"COMPLEX_SMILE_REHABILITATION",procedureName:"Complex Smile Rehabilitation",familyCode:"PROSTHODONTIC",visitsMin:5,visitsMax:10,sequenceNo:5,stageType:"C",stageCode:"FINAL",stageName:"Final",completesTreatment:true},
];

var PROCEDURE_LIBRARY_HEADERS = [
  "Procedure Code", "Procedure Name", "Family Code", "Visits Min", "Visits Max",
  "Sequence No.", "Stage Type", "Stage Code", "Stage Name", "Completes Treatment"
];

// Seeded from PROCEDURE_LIBRARY_DEFAULTS the first time this is read, and
// re-seeded once automatically if the sheet's headers don't match this
// (V2) shape — e.g. a V1 sheet from before this rebuild. After that first
// seed the sheet is the source of truth; adding a procedure or renaming a
// stage is a row edit, never a code change.
function getProcedureLibrary() {
  var sh = getSheet("Procedure Library");
  var needsSeed = sh.getLastRow() === 0;
  if (!needsSeed) {
    var existingHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    if (JSON.stringify(existingHeaders) !== JSON.stringify(PROCEDURE_LIBRARY_HEADERS)) needsSeed = true;
  }
  if (needsSeed) {
    sh.clearContents();
    sh.appendRow(PROCEDURE_LIBRARY_HEADERS);
    PROCEDURE_LIBRARY_DEFAULTS.forEach(function(r) {
      sh.appendRow([r.procedureCode, r.procedureName, r.familyCode, r.visitsMin, r.visitsMax, r.sequenceNo,
        r.stageType || "", r.stageCode, r.stageName, r.completesTreatment]);
    });
  }
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    items.push({
      procedureCode: data[i][0], procedureName: data[i][1], familyCode: data[i][2] || "",
      visitsMin: Number(data[i][3]) || 0, visitsMax: Number(data[i][4]) || 0, sequenceNo: Number(data[i][5]) || 0,
      stageType: data[i][6] || "", stageCode: data[i][7], stageName: data[i][8],
      completesTreatment: data[i][9] === true || String(data[i][9]).toUpperCase() === "TRUE"
    });
  }
  return { success: true, library: items, families: PROCEDURE_FAMILIES, reviewStageTypes: REVIEW_STAGE_TYPES };
}

// Admin-only rewrite (adding/renaming a procedure) — same clear+rewrite
// pattern as every other master list in this file.
function saveProcedureLibrary(p) {
  var arr = parseList_(p.library, "procedure library");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Procedure Library");
  sh.clearContents();
  sh.appendRow(PROCEDURE_LIBRARY_HEADERS);
  arr.forEach(function(r) {
    sh.appendRow([r.procedureCode, r.procedureName, r.familyCode || "", r.visitsMin || 0, r.visitsMax || 0,
      r.sequenceNo, r.stageType || "", r.stageCode, r.stageName, !!r.completesTreatment]);
  });
  return { success: true };
}

// The ordered stage list for one procedure, sorted by sequence number.
function procedureLibraryStages_(procedureCode) {
  var library = getProcedureLibrary().library;
  return library
    .filter(function(r) { return r.procedureCode === procedureCode; })
    .sort(function(a, b) { return a.sequenceNo - b.sequenceNo; });
}

// ════════════════════════════════════════════════════════════
// TREATMENT CASES
// ════════════════════════════════════════════════════════════

var CASE_HEADERS = [
  "CaseId", "UHID", "PatientName", "ProcedureCode", "ProcedureName", "FamilyCode",
  "ToothRef", "CaseStatus", "OpenedDate", "ClosedDate", "VisitCounter", "StagesJson", "UpdatedAt"
];

function getCasesSheet() {
  var sh = getSheet("Treatment Cases");
  if (sh.getLastRow() === 0) sh.appendRow(CASE_HEADERS);
  return sh;
}

// The stages array for a brand-new case, copied from the library — each
// entry independent from here on ("copied at case creation and then
// modified as reality dictates").
// startAtSequenceNo lets a case be opened partway through — e.g. a patient
// who already had earlier stages done before the clinic tracked this, or
// elsewhere. Stages before it are marked completed with no date/appointment
// (done, just not through this system); nothing else about the derived
// current/next logic changes.
function buildInitialStages_(libraryStages, startAtSequenceNo) {
  return libraryStages.map(function(s) {
    var startingLate = startAtSequenceNo && s.sequenceNo < startAtSequenceNo;
    return {
      sequenceNo: s.sequenceNo, stageCode: s.stageCode, stageName: s.stageName,
      status: startingLate ? "completed" : "pending", completedDate: "", completedInAppointment: "",
      completesTreatment: !!s.completesTreatment
    };
  });
}

// Derived values (V2 section 4) — never stored, always computed from the
// stages array:
//   current stage = first stage with status "pending"
//   next stage    = the one after that
//   case complete = no pending stages remain, OR a completesTreatment stage
//                   was completed
// Pure function — no Sheets access — so this is what's unit-tested directly.
function deriveCaseView_(stages) {
  var sorted = stages.slice().sort(function(a, b) { return a.sequenceNo - b.sequenceNo; });
  var currentIdx = -1;
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].status === "pending") { currentIdx = i; break; }
  }
  var current = currentIdx >= 0 ? sorted[currentIdx] : null;
  var next = (currentIdx >= 0 && currentIdx + 1 < sorted.length) ? sorted[currentIdx + 1] : null;
  var noPendingLeft = sorted.every(function(s) { return s.status !== "pending"; });
  var completedFinal = sorted.some(function(s) { return s.status === "completed" && s.completesTreatment; });
  return {
    currentStageCode: current ? current.stageCode : "", currentStageName: current ? current.stageName : "",
    nextStageCode: next ? next.stageCode : "", nextStageName: next ? next.stageName : "",
    isComplete: noPendingLeft || completedFinal
  };
}

function caseIdFor_(uhid, procedureCode, existingCount) {
  var seq = String(existingCount + 1);
  if (seq.length < 2) seq = "0" + seq;
  return uhid + "-" + procedureCode + "-" + seq;
}

function loadCaseRow_(data, headers, caseId) {
  var col = function(name) { return headers.indexOf(name); };
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col("CaseId")]).trim() === caseId) return { rowIndex: i + 1, row: data[i] };
  }
  return null;
}

function caseFromRow_(row, headers) {
  var col = function(name) { return headers.indexOf(name); };
  var stages = [];
  try { stages = JSON.parse(row[col("StagesJson")] || "[]"); } catch (e) { stages = []; }
  return {
    caseId: row[col("CaseId")], uhid: row[col("UHID")], patientName: row[col("PatientName")],
    procedureCode: row[col("ProcedureCode")], procedureName: row[col("ProcedureName")],
    familyCode: row[col("FamilyCode")], toothRef: row[col("ToothRef")] || "",
    caseStatus: row[col("CaseStatus")], openedDate: row[col("OpenedDate")], closedDate: row[col("ClosedDate")] || "",
    visitCounter: Number(row[col("VisitCounter")]) || 0, stages: stages
  };
}

function maxVisits_(stagesMeta) {
  return stagesMeta.reduce(function(m, s) { return Math.max(m, s.visitsMax); }, 0);
}

// Starts (persists) a new treatment case for a patient + procedure — called
// once, the first time staff book a NEW case; an existing open case is
// reused via getOpenCase instead, never duplicated.
function startTreatmentCase(p) {
  var uhid = String(p.uhid || "").trim().toUpperCase();
  var procedureCode = String(p.procedureCode || "").trim();
  if (!uhid || !procedureCode) return { success: false, error: "uhid and procedureCode required" };

  var stagesMeta = procedureLibraryStages_(procedureCode);
  if (!stagesMeta.length) return { success: false, error: "Unknown procedureCode: " + procedureCode };

  var sh = getCasesSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var col = function(name) { return headers.indexOf(name); };
  var existingCount = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col("UHID")]).trim().toUpperCase() === uhid &&
        String(data[i][col("ProcedureCode")]) === procedureCode) existingCount++;
  }

  var caseId = caseIdFor_(uhid, procedureCode, existingCount);
  var startAt = Number(p.startAtSequenceNo) || 0;
  var initialStages = buildInitialStages_(stagesMeta, startAt);
  var now = new Date().toISOString();
  var first = stagesMeta[0];
  var values = {
    "CaseId": caseId, "UHID": uhid, "PatientName": p.patientName || "",
    "ProcedureCode": procedureCode, "ProcedureName": first.procedureName, "FamilyCode": first.familyCode,
    "ToothRef": p.toothRef || "", "CaseStatus": "in_progress", "OpenedDate": now, "ClosedDate": "",
    "VisitCounter": 0, "StagesJson": JSON.stringify(initialStages), "UpdatedAt": now
  };
  sh.appendRow(headers.map(function(h) { return values[h] !== undefined ? values[h] : ""; }));

  var view = deriveCaseView_(initialStages);
  return {
    success: true, caseId: caseId, procedureCode: procedureCode, procedureName: first.procedureName,
    familyCode: first.familyCode, visitsMax: maxVisits_(stagesMeta), visitCounter: 0, caseStatus: "in_progress",
    stages: initialStages, currentStageCode: view.currentStageCode, currentStageName: view.currentStageName,
    nextStageCode: view.nextStageCode, nextStageName: view.nextStageName
  };
}

// The most recent OPEN case for a patient + procedure, or found:false — used
// by the booking form so a returning patient continues their existing case
// instead of silently starting a duplicate one.
function getOpenCase(p) {
  var uhid = String(p.uhid || "").trim().toUpperCase();
  var procedureCode = String(p.procedureCode || "").trim();
  if (!uhid || !procedureCode) return { success: false, error: "uhid and procedureCode required" };

  var sh = getCasesSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var col = function(name) { return headers.indexOf(name); };

  var latest = null, latestOpened = "";
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[col("UHID")]).trim().toUpperCase() !== uhid) continue;
    if (String(row[col("ProcedureCode")]) !== procedureCode) continue;
    if (String(row[col("CaseStatus")]) !== "in_progress") continue;
    var opened = String(row[col("OpenedDate")]);
    if (opened > latestOpened) { latestOpened = opened; latest = caseFromRow_(row, headers); }
  }
  if (!latest) return { success: true, found: false };

  var view = deriveCaseView_(latest.stages);
  var stagesMeta = procedureLibraryStages_(procedureCode);
  return {
    success: true, found: true, caseId: latest.caseId, procedureCode: latest.procedureCode,
    procedureName: latest.procedureName, familyCode: latest.familyCode, visitCounter: latest.visitCounter,
    caseStatus: latest.caseStatus, stages: latest.stages, visitsMax: maxVisits_(stagesMeta),
    currentStageCode: view.currentStageCode, currentStageName: view.currentStageName,
    nextStageCode: view.nextStageCode, nextStageName: view.nextStageName
  };
}

// Full current state of a known case — used to refresh the CURRENT/NEXT line
// and to list the pending stages staff can tick off at visit completion.
function getCaseState(p) {
  var caseId = String(p.caseId || "").trim();
  if (!caseId) return { success: false, error: "caseId required" };
  var sh = getCasesSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var found = loadCaseRow_(data, headers, caseId);
  if (!found) return { success: false, error: "Case not found: " + caseId };

  var caseObj = caseFromRow_(found.row, headers);
  var view = deriveCaseView_(caseObj.stages);
  return {
    success: true, caseId: caseObj.caseId, procedureCode: caseObj.procedureCode,
    procedureName: caseObj.procedureName, familyCode: caseObj.familyCode, caseStatus: caseObj.caseStatus,
    visitCounter: caseObj.visitCounter, stages: caseObj.stages,
    currentStageCode: view.currentStageCode, currentStageName: view.currentStageName,
    nextStageCode: view.nextStageCode, nextStageName: view.nextStageName
  };
}

// The three stage outcomes (V2 section 6), applied to whatever stage(s) an
// appointment covered. This is the only clinical decision the system asks
// for; current/next and case completion are all derived from its result.
// Pure function — no Sheets access — unit-tested directly.
function applyStageOutcome_(stages, completedSeqs, outcome, appointmentId) {
  var now = new Date().toISOString();
  // A deep-ish copy (each stage object cloned, not just the array) — without
  // it this "pure" function would mutate the caller's stage objects in
  // place, which live usage only avoids because caseFromRow_ hands it a
  // fresh JSON.parse every call. That's a coincidence worth not depending on.
  var sorted = stages.map(function(s) { return Object.assign({}, s); })
    .sort(function(a, b) { return a.sequenceNo - b.sequenceNo; });
  var lastCompletedSeq = null;

  completedSeqs.forEach(function(seq) {
    var match = sorted.filter(function(x) { return x.sequenceNo === seq; })[0];
    if (match && match.status === "pending") {
      match.status = "completed"; match.completedDate = now; match.completedInAppointment = appointmentId || "";
      lastCompletedSeq = seq;
    }
  });

  if (outcome === "adjustment_required" && lastCompletedSeq !== null) {
    var completedStage = sorted.filter(function(x) { return x.sequenceNo === lastCompletedSeq; })[0];
    // A fractional sequence number keeps every later stage's own number
    // untouched — "everything after shifts down" is a DISPLAY effect of
    // sort order here, not a renumbering of already-stored stages.
    var newSeq = lastCompletedSeq + 0.1;
    while (sorted.some(function(x) { return x.sequenceNo === newSeq; })) newSeq += 0.01;
    sorted.push({
      sequenceNo: newSeq, stageCode: completedStage.stageCode,
      stageName: completedStage.stageName + " / adjustment",
      status: "pending", completedDate: "", completedInAppointment: "", completesTreatment: false
    });
    sorted.sort(function(a, b) { return a.sequenceNo - b.sequenceNo; });
  }

  if (outcome === "proceed_to_completion") {
    sorted.forEach(function(s) { if (s.status === "pending") s.status = "skipped"; });
  }

  return sorted;
}

function sh0_set(sh, row, col0, value) {
  if (col0 >= 0) sh.getRange(row, col0 + 1).setValue(value);
}

// Applies one visit's outcome to its case: marks the covered stages,
// possibly inserts an adjustment stage or closes the case, mirrors the
// outcome onto the appointment's own CompletedStages/VisitCounter, and
// returns the new current/next for the UI.
function resolveStageOutcome(p) {
  var caseId = String(p.caseId || "").trim();
  var apptId = String(p.appointmentId || "").trim();
  var outcome = String(p.stageOutcome || "").trim();
  if (["approved", "adjustment_required", "proceed_to_completion"].indexOf(outcome) < 0) {
    return { success: false, error: "stageOutcome must be approved, adjustment_required, or proceed_to_completion" };
  }
  var completedSeqs = [];
  try { completedSeqs = JSON.parse(p.completedStages); } catch (e) { if (Array.isArray(p.completedStages)) completedSeqs = p.completedStages; }
  completedSeqs = completedSeqs.map(Number);
  if (!caseId || !completedSeqs.length) return { success: false, error: "caseId and completedStages required" };

  var sh = getCasesSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var found = loadCaseRow_(data, headers, caseId);
  if (!found) return { success: false, error: "Case not found: " + caseId };

  var caseObj = caseFromRow_(found.row, headers);
  var newStages = applyStageOutcome_(caseObj.stages, completedSeqs, outcome, apptId);
  var view = deriveCaseView_(newStages);
  var newVisitCounter = caseObj.visitCounter + 1;
  var newStatus = view.isComplete ? "completed" : "in_progress";
  var now = new Date().toISOString();

  var col = function(name) { return headers.indexOf(name); };
  sh.getRange(found.rowIndex, col("StagesJson") + 1).setValue(JSON.stringify(newStages));
  sh.getRange(found.rowIndex, col("VisitCounter") + 1).setValue(newVisitCounter);
  sh.getRange(found.rowIndex, col("CaseStatus") + 1).setValue(newStatus);
  sh.getRange(found.rowIndex, col("UpdatedAt") + 1).setValue(now);
  if (newStatus === "completed") sh.getRange(found.rowIndex, col("ClosedDate") + 1).setValue(now);

  // Reflect the outcome on the appointment itself, if one was given —
  // CompletedStages and VisitCounter are what other apps read per appointment.
  if (apptId) {
    var apSh = getAppointmentsSheet();
    var apData = apSh.getDataRange().getValues();
    var apHeaders = apData[0].map(String);
    var apCol = function(name) { return apHeaders.indexOf(name); };
    for (var i = 1; i < apData.length; i++) {
      if (String(apData[i][apCol("ID")]).trim() === apptId) {
        sh0_set(apSh, i + 1, apCol("CompletedStages"), JSON.stringify(completedSeqs));
        sh0_set(apSh, i + 1, apCol("VisitCounter"), newVisitCounter);
        break;
      }
    }
  }

  return {
    success: true, caseId: caseId, caseStatus: newStatus, visitCounter: newVisitCounter,
    currentStageCode: view.currentStageCode, currentStageName: view.currentStageName,
    nextStageCode: view.nextStageCode, nextStageName: view.nextStageName
  };
}

// Appends a reusable review/follow-up stage (V2 section 3) to an open case —
// e.g. an "RCT Review" some weeks after the case otherwise completed.
// Inserted as a new pending stage at the end of the sequence; reopens a
// completed case back to in_progress if needed.
function appendCaseStage(p) {
  var caseId = String(p.caseId || "").trim();
  var stageName = String(p.stageName || "").trim();
  var stageCode = String(p.stageCode || "TI").trim();
  if (!caseId || !stageName) return { success: false, error: "caseId and stageName required" };

  var sh = getCasesSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var found = loadCaseRow_(data, headers, caseId);
  if (!found) return { success: false, error: "Case not found: " + caseId };

  var caseObj = caseFromRow_(found.row, headers);
  var maxSeq = caseObj.stages.reduce(function(m, s) { return Math.max(m, s.sequenceNo); }, 0);
  caseObj.stages.push({
    sequenceNo: Math.floor(maxSeq) + 1, stageCode: stageCode, stageName: stageName,
    status: "pending", completedDate: "", completedInAppointment: "", completesTreatment: false
  });

  var col = function(name) { return headers.indexOf(name); };
  sh.getRange(found.rowIndex, col("StagesJson") + 1).setValue(JSON.stringify(caseObj.stages));
  sh.getRange(found.rowIndex, col("CaseStatus") + 1).setValue("in_progress");
  sh.getRange(found.rowIndex, col("UpdatedAt") + 1).setValue(new Date().toISOString());

  var view = deriveCaseView_(caseObj.stages);
  return {
    success: true, currentStageCode: view.currentStageCode, currentStageName: view.currentStageName,
    nextStageCode: view.nextStageCode, nextStageName: view.nextStageName
  };
}

// ════════════════════════════════════════════════════════════
// APPOINTMENT REASONS (manageable list, like Doctors)
// ════════════════════════════════════════════════════════════

var DEFAULT_APPT_REASONS = [
  "Consultation","Follow Up","RCT","Crown Cementation","Scaling / Cleaning",
  "Extraction","Implant Surgery","Implant Prosthesis","Orthodontics",
  "Restoration","Denture","Whitening","Review","Other"
];

function getReasonsList() {
  var sh = getSheet("Appointment Reasons");
  var data = sh.getDataRange().getValues();
  var reasons = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) reasons.push(data[i][0]);
  }
  if (reasons.length === 0) reasons = DEFAULT_APPT_REASONS.slice();
  return { success: true, reasons: reasons };
}

function saveReasonsList(p) {
  var arr = parseList_(p.reasons, "appointment reasons");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Appointment Reasons");
  sh.clearContents();
  sh.appendRow(["Reason", "Updated At"]);
  arr.forEach(function(r) { sh.appendRow([r, new Date().toISOString()]); });
  return { success: true };
}

// ════════════════════════════════════════════════════════════
// BLOCKED TIME SLOTS (mark a chair/time range unavailable)
// ════════════════════════════════════════════════════════════

function getBlockedSlots(p) {
  var sh = getSheet("Blocked Slots");
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { success: true, blocks: [] };
  var headers = data[0].map(String);
  var typeCol = headers.indexOf("Type");
  var doctorCol = headers.indexOf("Doctor");
  var date = String(p.date || "").trim();
  var blocks = [];
  for (var i = 1; i < data.length; i++) {
    var rowDate = formatDateISO(data[i][0]) || String(data[i][0] || "");
    if (!date || rowDate === date) {
      // Sheets auto-converts "HH:MM"-looking text into a Time-of-day cell on
      // write, which Apps Script then reads back as a Date object (1899-12-30
      // epoch) — normalize back to plain "HH:MM" text, same pattern used for
      // appointment times elsewhere.
      blocks.push({
        date: rowDate,
        chair: data[i][1],
        fromTime: fmtTime(data[i][2]) || String(data[i][2] || ""),
        toTime: fmtTime(data[i][3]) || String(data[i][3] || ""),
        reason: data[i][4], id: data[i][5],
        blockType: typeCol >= 0 ? (data[i][typeCol] || "chair") : "chair",
        doctor: doctorCol >= 0 ? (data[i][doctorCol] || "") : ""
      });
    }
  }
  return { success: true, blocks: blocks };
}

function saveBlockedSlot(p) {
  var sh = getSheet("Blocked Slots");
  if (sh.getLastRow() === 0) {
    sh.appendRow(["Date","Chair","From Time","To Time","Reason","ID","Type","Doctor"]);
  } else {
    // Migrate older sheets (created before doctor-blocking existed) that are
    // missing the Type/Doctor columns.
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var missing = ["Type", "Doctor"].filter(function(h) { return headers.indexOf(h) < 0; });
    if (missing.length) sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  var id = "BLK-" + Date.now();
  var blockType = String(p.blockType || "chair");
  sh.appendRow([p.date, p.chair || "", p.fromTime || "", p.toTime || "", p.reason || "", id, blockType, p.doctor || ""]);
  return { success: true, id: id };
}

function deleteBlockedSlot(p) {
  var sh = getSheet("Blocked Slots");
  var data = sh.getDataRange().getValues();
  var id = String(p.id || "").trim();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][5]).trim() === id) {
      sh.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, error: "Block not found: " + id };
}

// ════════════════════════════════════════════════════════════
// PROCEDURE & FEE SHEET (KBDC/FORMS/REG-07)
// No longer a manual-entry sheet — the frontend now builds this view by
// combining getTreatmentProgress (procedures, from Daily Register) with
// getReceipts (fees, from Finance) for the same patient.
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// CONSENTS
// ════════════════════════════════════════════════════════════

function saveConsent(p) {
  var sh = getSheet("Consents");
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "UHID","Patient Name","Date","Procedure","Language",
      "SOAP","Med History","Fee","Pay Terms","Extra Proc","Saved At"
    ]);
  }
  sh.appendRow([
    p.uhid, p.patientName, p.date, p.procedure, p.language,
    p.soap || "", p.medHistory || "", p.fee || "",
    p.payTerms || "", p.extraProc || "",
    new Date().toISOString()
  ]);
  return { success: true };
}

// ════════════════════════════════════════════════════════════
// SIGNATURES
// ════════════════════════════════════════════════════════════

function getSignatures() {
  var sh = getSheet("Signatures");
  var data = sh.getDataRange().getValues();
  var sigs = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) sigs[data[i][0]] = data[i][1];
  }
  return { success: true, signatures: sigs };
}

function saveSignature(p) {
  var sh = getSheet("Signatures");
  if (sh.getLastRow() === 0) {
    sh.appendRow(["Doctor","Signature Data URL","Updated At"]);
  }
  var data = sh.getDataRange().getValues();
  var doctor = String(p.doctor || "").trim();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === doctor) {
      sh.getRange(i + 1, 1, 1, 3).setValues([[
        doctor, p.signatureDataUrl || "", new Date().toISOString()
      ]]);
      return { success: true };
    }
  }
  sh.appendRow([doctor, p.signatureDataUrl || "", new Date().toISOString()]);
  return { success: true };
}

// ════════════════════════════════════════════════════════════
// DOCTORS LIST
// ════════════════════════════════════════════════════════════

// The "Doctors" tab and its two functions are gone. It was a SECOND doctors
// list beside the "Doctor Details" tab that Master edits, and getDoctorsList
// carried its own hardcoded pair of names on top of that — so a clinic with an
// empty tab got those two whatever Master said, and nobody could tell which
// list a screen was showing. Doctor Details is the only list now.
//
// The functions are removed rather than left unused because getSheet() creates
// a tab that is missing: leaving them in would have recreated "Doctors" the
// first time anything called one, and the tab would quietly come back after
// being deleted.

function generateSOAPNotes(p) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) return { success: false, error: "ANTHROPIC_API_KEY not set in Script Properties" };

  var prompt = [
    "You are an experienced dentist writing the 'PATIENT FINDINGS' section of an informed-consent form for the case below.",
    "",
    "Patient: " + p.name + " | Age/Gender: " + p.age,
    "Chief Complaint: " + (p.complaint || ""),
    "Clinical / Radiographic Findings: " + (p.clinical || ""),
    "Tooth / Site: " + (p.tooth || ""),
    "Medical History: " + (p.medHx || ""),
    "Planned Treatment: " + (p.treatment || ""),
    "",
    "WRITE IT AS A FLOWING CLINICAL NARRATIVE — a full 'scene of events' in natural, professional prose,",
    "the way a dentist would write it in the case sheet. Exactly TWO paragraphs, no headings, no labels,",
    "NO 'S:/O:/A:/P:' letters, no bullet points, no separate one-line sentences.",
    "",
    "Paragraph 1 (the presentation): the patient's name, age/sex, that they reported to K.B. Dental Clinic,",
    "the chief complaint and its character — duration, what aggravates/relieves it, radiation, associated",
    "sensitivity — woven into one continuous story.",
    "",
    "Paragraph 2 (the examination & plan): what was found on clinical and X-ray (IOPA/RVG) examination,",
    "the affected tooth described in words and by number, percussion/tenderness, radiographic signs, the",
    "resulting diagnosis, and the treatment advised (including any later steps such as post & core / crown),",
    "ending with a line that the patient was made aware of the procedure through audio-visual aids and models.",
    "",
    "Write in third person, past tense, specific and detailed. Do NOT invent facts that contradict the inputs;",
    "if a detail is missing, phrase it naturally without placeholders. Example of the required STYLE (do not copy the wording):",
    "\"Mr. Ramesh Kumar, 45/Male, reported to K.B. Dental Clinic with a complaint of severe throbbing pain in the lower right back tooth region since 8 days. The pain aggravated on biting and hot foods with slight relief on cold water, radiating to the right ear and lower jaw, and was associated with sensitivity to sweet and hot foodstuffs.\\n\\nOn clinical and X-ray (IOPA) examination, a deep carious lesion was found in the lower right first molar — the sixth tooth from the centre (Tooth No. 46) — extending to the tooth's nerve (pulp). The tooth was tender to percussion, and the X-ray confirmed deep decay with periapical radiolucency (widening of the PDL) at the root end, indicating infection. Root canal treatment was advised, which will subsequently need post & core restoration and a PFM crown. The patient was made aware of the procedure through audio-visual aids and physical models.\"",
    "",
    "Return ONLY the two-paragraph narrative, nothing else."
  ].join("\n");

  try {
    var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }]
      }),
      muteHttpExceptions: true
    });

    var data = JSON.parse(response.getContentText());
    if (data.content && data.content[0] && data.content[0].text) {
      return { success: true, soap: data.content[0].text };
    }
    return { success: false, error: "No content in API response" };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════
// PATIENT CHATBOT
// ════════════════════════════════════════════════════════════

// Proxies the chatbot's AI replies through the same Claude key used by
// generateSOAPNotes, so the key never has to sit in the public HTML.
function chatbotReply(p) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) return { success: false, error: "ANTHROPIC_API_KEY not set in Script Properties" };

  var messages;
  try { messages = JSON.parse(p.messages || "[]"); } catch(e) { messages = []; }
  if (!messages.length) return { success: false, error: "No messages provided" };

  try {
    var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 700,
        system: p.system || "",
        messages: messages
      }),
      muteHttpExceptions: true
    });

    var data = JSON.parse(response.getContentText());
    if (data.content && data.content[0] && data.content[0].text) {
      return { success: true, reply: data.content[0].text };
    }
    return { success: false, error: (data.error && data.error.message) || "No content in API response" };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// Looks up a patient's own upcoming appointments by mobile number, so the
// chatbot can offer reschedule/cancel without needing a UHID lookup.
function findAppointmentsByPhone(p) {
  var sh = getAppointmentsSheet();
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { success: true, appointments: [] };
  var headers = data[0].map(String);
  var col = function(name) { return headers.indexOf(name); };
  var phone = String(p.phone || "").replace(/\D/g, "").slice(-10);
  if (!phone) return { success: true, appointments: [] };

  var appts = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowPhone = String(row[col("Mobile")] || "").replace(/\D/g, "").slice(-10);
    if (rowPhone !== phone) continue;
    var status = row[col("Status")];
    if (status === "Cancelled" || status === "Completed") continue;
    var rowDate = formatDateISO(row[col("Date")]) || String(row[col("Date")] || "");
    appts.push({
      id: row[col("ID")], date: rowDate,
      time: fmtTime(row[col("Time")]) || String(row[col("Time")] || ""),
      type: row[col("Type")], doctor: row[col("Doctor")], status: status
    });
  }
  appts.sort(function(a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
  return { success: true, appointments: appts };
}

// Saves a chatbot-completed booking straight into the same Appointments
// sheet the front desk uses, so it shows up on today's schedule / Daysheet
// immediately. Doctor/Chair are left for the front desk to assign since the
// chatbot doesn't ask for them.
function saveChatbotAppointment(p) {
  var sh = getAppointmentsSheet();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var id = "APT-" + Date.now();
  var values = {
    "Date": p.date || "", "UHID": "", "Patient Name": p.name || "", "Time": p.time || "",
    "Type": p.treatment || "Consultation", "Doctor": "Not Assigned", "Chair": "", "Mobile": p.phone || "",
    "Notes": "Booked via Patient Chatbot" + (p.lang ? " (" + p.lang + ")" : ""), "Status": "Scheduled",
    "CheckinTime": "", "EngagedTime": "", "CheckoutTime": "", "CancelReason": "",
    "ID": id, "Saved At": new Date().toISOString()
  };
  var row = headers.map(function(h) { return values[h] !== undefined ? values[h] : ""; });
  sh.appendRow(row);
  return { success: true, id: id };
}

// ════════════════════════════════════════════════════════════
// FINANCE — Receipts / Daily Collection / Outstanding Balance
// Reads from a separate Google Sheet ("Receipt No." tab) that the
// clinic's Patient Payment Form writes to — same source the old
// Excel Master File's "Receipt No" sheet pulled from.
// ════════════════════════════════════════════════════════════

// A COPY OF THIS BOOK MUST NEVER FALL BACK TO THE MAIN CLINIC'S FILES.
// This project is copied to make a new instance — the empanelled book, a new
// branch — and a copy carries these hardcoded IDs with it. Left as plain
// defaults they would send that instance's clinical records and its money into
// K. B. Dental's own files, silently and with nothing on screen to show it.
// So the hardcoded IDs below are the MAIN CLINIC'S, and apply only when this is
// the main clinic's book. Any other book defaults to keeping its records in
// itself, until a Script Property says otherwise.
var MAIN_PMS_SHEET_ID = "1DtoZ3MNFq2Enr-ClAjENWFzk8SF2dYN9e1nGf7tAJC4";
function defaultSheetId_(mainClinicFileId) {
  return SS_ID === MAIN_PMS_SHEET_ID ? mainClinicFileId : SS_ID;
}

var FINANCE_SHEET_ID_DEFAULT = "1Zdxq3Xf-e41Xak4VDcufrURLkKDAp8MvRCZadC0htUI"; // K. B. Dental - Finance Sheet
// The clinic keeps entering in this one, so it is the live record: today's
// receipts, 885 expense rows, the FY tabs and the Balance Sheet all live here.
// "K. B. Dental - Finance Sheet PMS" is a 21-Aug copy that fell behind the
// same day it was made, and is deliberately NOT the target.

// Finance sheet ID is controllable from the app's Settings tab — stored in
// Script Properties, falling back to the hardcoded default if never changed.
function getFinanceSheetId() {
  var stored = PropertiesService.getScriptProperties().getProperty("FINANCE_SHEET_ID");
  return stored || defaultSheetId_(FINANCE_SHEET_ID_DEFAULT);
}

// READ-ONLY. Prints which files this book actually uses, by name and ID.
// Run it from the editor after copying this project to make a new instance:
// getClinicalSheetId and getFinanceSheetId only RETURN their answer, so running
// those from the editor shows an empty log and tells you nothing. This says, in
// words, whether this book is about to write into the main clinic's files.
function reportInstanceFiles() {
  var here = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('This book : "%s"', here.getName());
  Logger.log("Its id    : %s", here.getId());
  Logger.log("Is it the main clinic's book? %s", SS_ID === MAIN_PMS_SHEET_ID ? "YES" : "no");
  Logger.log("");

  [["Clinical records", getClinicalSheetId()], ["Finance", getFinanceSheetId()]]
    .forEach(function (pair) {
      var name;
      try { name = SpreadsheetApp.openById(pair[1]).getName(); }
      catch (e) { name = "COULD NOT OPEN — " + e.message; }
      Logger.log("%s -> %s", pair[0], name);
      Logger.log("   id %s%s", pair[1],
        pair[1] === MAIN_PMS_SHEET_ID || pair[1] === FINANCE_SHEET_ID_DEFAULT
          ? "   *** THIS IS THE MAIN CLINIC'S FILE ***" : "");
    });

  Logger.log("");
  if (SS_ID === MAIN_PMS_SHEET_ID) {
    Logger.log("This IS the main clinic, so its own files are the right answer.");
  } else {
    Logger.log("This is NOT the main clinic's book, so neither line above may say");
    Logger.log("MAIN CLINIC'S FILE. If either does, do not enter any patient or");
    Logger.log("any receipt here until it is fixed.");
  }
}

// DANGER, historically: this used to insertSheet() whenever a tab was missing,
// which meant a pure READ could silently mutate the finance workbook — a typo'd
// or renamed tab would quietly materialise as a new empty tab rather than
// failing loudly. Creation is now opt-in, so reads can never alter the file.
function getFinanceSheet(tabName, createIfMissing) {
  var ss = SpreadsheetApp.openById(getFinanceSheetId());
  var sh = ss.getSheetByName(tabName);
  if (!sh && createIfMissing) sh = ss.insertSheet(tabName);
  return sh || null;
}

// ════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════

function getSettings() {
  var props = PropertiesService.getScriptProperties();
  return {
    success: true, financeSheetId: getFinanceSheetId(),
    financePasswordSet: !!props.getProperty("FINANCE_PASSWORD"),
    masterPasswordSet: !!props.getProperty("MASTER_PASSWORD"),
    reportsPassword1Set: !!props.getProperty("REPORTS_PASSWORD_1"),
    reportsPassword2Set: !!props.getProperty("REPORTS_PASSWORD_2")
  };
}

// Gates the Receipt and P&L tabs — a casual deterrent only (this is a
// front-end app with no login system, so the check happens server-side to
// avoid the actual password sitting in the public page source, but a
// determined user could still find ways around it).
function saveFinancePassword(p) {
  var pw = String(p.password || "").trim();
  if (!pw) return { success: false, error: "Password required" };
  PropertiesService.getScriptProperties().setProperty("FINANCE_PASSWORD", pw);
  return { success: true };
}
function verifyFinancePassword(p) {
  var stored = PropertiesService.getScriptProperties().getProperty("FINANCE_PASSWORD");
  if (!stored) return { success: true, correct: true }; // no password configured yet — don't lock
  return { success: true, correct: String(p.password || "") === stored };
}

// Gates the Master page — same casual-deterrent model as Finance.
function saveMasterPassword(p) {
  var pw = String(p.password || "").trim();
  if (!pw) return { success: false, error: "Password required" };
  PropertiesService.getScriptProperties().setProperty("MASTER_PASSWORD", pw);
  return { success: true };
}
function verifyMasterPassword(p) {
  var stored = PropertiesService.getScriptProperties().getProperty("MASTER_PASSWORD");
  if (!stored) return { success: true, correct: true };
  return { success: true, correct: String(p.password || "") === stored };
}

// Gates Reports with TWO independent passwords, one per person — EITHER one
// unlocks it on its own (not both together), so each person can open Reports
// with just their own password without needing the other person present.
// Each is set/changed independently of the other.
function saveReportsPassword(p) {
  var slot = String(p.slot || "").trim();
  if (slot !== "1" && slot !== "2") return { success: false, error: "Invalid password slot" };
  var pw = String(p.password || "").trim();
  if (!pw) return { success: false, error: "Password required" };
  PropertiesService.getScriptProperties().setProperty("REPORTS_PASSWORD_" + slot, pw);
  return { success: true };
}
function verifyReportsPassword(p) {
  var props = PropertiesService.getScriptProperties();
  var stored1 = props.getProperty("REPORTS_PASSWORD_1");
  var stored2 = props.getProperty("REPORTS_PASSWORD_2");
  if (!stored1 && !stored2) return { success: true, correct: true }; // neither set yet — don't lock
  var entered = String(p.password || "");
  var correct = (!!stored1 && entered === stored1) || (!!stored2 && entered === stored2);
  return { success: true, correct: correct };
}

function saveSettings(p) {
  try {
    var id = String(p.financeSheetId || "").trim();
    // Accept a full URL and pull the ID out of it, or a bare ID.
    var m = id.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (m) id = m[1];
    if (!id) return { success: false, error: "Sheet ID/URL required" };
    // Verify it's a real, accessible spreadsheet before saving
    SpreadsheetApp.openById(id);
    PropertiesService.getScriptProperties().setProperty("FINANCE_SHEET_ID", id);
    return { success: true, financeSheetId: id };
  } catch (e) {
    return { success: false, error: "Could not open that spreadsheet — check the ID/URL and sharing access. (" + e.message + ")" };
  }
}

// Header-aware row reader — resilient to column order/renames
function readFinanceRows(tabName) {
  var sh = getFinanceSheet(tabName); // read-only: never creates the tab
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0].map(String);
  return data.slice(1).map(function(r) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h.trim()] = r[i]; });
    return obj;
  });
}

// Fuzzy-match a value out of a row object by trying several possible header names
// A broken formula in the source Finance sheet surfaces as the literal error
// text ("#VALUE!", "#REF!", ...). Passing that straight through made every
// affected receipt row render "#VALUE!" in the app; treating it as empty makes
// the row degrade to "—" instead, so one bad formula can't make the whole
// Receipts list look corrupted.
var SHEET_ERROR_VALUES = ["#VALUE!", "#REF!", "#N/A", "#NAME?", "#DIV/0!", "#NULL!", "#NUM!", "#ERROR!"];
function isSheetError_(v) {
  return typeof v === "string" && SHEET_ERROR_VALUES.indexOf(v.trim().toUpperCase()) >= 0;
}

function fcVal(obj, keys) {
  var objKeys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var match = objKeys.find(function(kk) { return kk.toLowerCase().indexOf(keys[i].toLowerCase()) >= 0; });
    if (match && obj[match] !== "" && obj[match] !== undefined && obj[match] !== null && !isSheetError_(obj[match])) return obj[match];
  }
  return "";
}

// The clinic's "Patient Fee Receipt Form" supports a SPLIT payment (two payment
// modes + two amounts, e.g. part cash + part UPI) — these helpers separate the
// primary "Payment Mode"/"Amount" columns from the secondary "...more than one"
// duplicates Google Forms creates, and combine them into one fee/mode per receipt.
function fcSplitField(obj, baseKeyword) {
  var objKeys = Object.keys(obj);
  var candidates = objKeys.filter(function(k) { return k.toLowerCase().indexOf(baseKeyword) >= 0; });
  var primary = candidates.find(function(k) { return k.toLowerCase().indexOf("more than one") < 0; });
  var secondary = candidates.find(function(k) { return k.toLowerCase().indexOf("more than one") >= 0; });
  return {
    primary: primary ? obj[primary] : "",
    secondary: secondary ? obj[secondary] : ""
  };
}
function receiptFeeAndMode(r) {
  var modeF = fcSplitField(r, "payment mode");
  var amtF = fcSplitField(r, "amount");
  var amt1 = parseFloat(modeF.primary !== "" ? amtF.primary : (fcVal(r, ["fee"]) || amtF.primary)) || 0;
  var amt2 = parseFloat(amtF.secondary) || 0;
  // If there's no explicit split-payment column, fall back to plain "Mode"/"Fee"/"Amount"
  var mode1 = modeF.primary || fcVal(r, ["mode"]);
  var mode2 = modeF.secondary;
  if (!amt1 && !amt2) amt1 = parseFloat(fcVal(r, ["fee", "amount"])) || 0;
  return {
    fee: amt1 + amt2,
    mode: mode2 ? (mode1 + " + " + mode2) : mode1
  };
}

// Records a payment on the "Patient Fee Receipt" tab — and ONLY there.
//
// "Working" is derived from this tab by the spreadsheet's own formulas, and
// "Receipt No." / the FY tabs / the E. Receipt No. sequence follow from
// Working. So one write is all it takes; the rest of the chain updates
// itself.
//
// History worth keeping, because this was got wrong three separate ways:
//
//   1. An early version also wrote a copy into Working, targeting
//      mirror.getLastRow() + 1. Working carries an ARRAYFORMULA spilling
//      down its Date/Time columns, and getLastRow() counts that spilled
//      output as real data — so the write landed ~190 rows past the actual
//      last row, tearing a gap in a formula-driven tab and breaking the
//      E. Receipt No. sequence (it restarted at 1 when the clinic had
//      already issued 233).
//   2. The next attempt dropped the copy entirely. That stopped the
//      corruption, and was in fact correct, but it was reverted after being
//      misread as the cause of a separate problem.
//   3. The copy came back, now targeting a row found by scanning rather
//      than by getLastRow(). Safer, but still wrong in kind: it put a second
//      row into a tab the spreadsheet was already filling in on its own, so
//      every receipt appeared twice, in two tabs, at two different rows.
//
// The correct answer is simply not to write there. Never add a second write
// to Working — if a receipt is not reaching Receipt No. or the FY tabs, the
// break is in the sheet's formulas, not here.
var FIN_ENTRY_TAB = "Patient Fee Receipt";

// Finds a column by header name, tolerating the sheet's own spelling (trailing
// spaces, "'s", casing). Returns -1 when absent.
function finCol_(headers, candidates) {
  var norm = function(x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, ""); };
  for (var c = 0; c < candidates.length; c++) {
    var want = norm(candidates[c]);
    for (var i = 0; i < headers.length; i++) {
      if (norm(headers[i]) === want) return i;
    }
  }
  return -1;
}

// Builds the row against whatever header order the tab actually has, so it
// does not depend on a fixed column position.
function finReceiptRow_(headers, p, stamp) {
  var row = headers.map(function() { return ""; });
  var put = function(names, value) {
    var i = finCol_(headers, names);
    if (i >= 0) row[i] = value;
  };
  // A real Date, not an ISO string: the derived tabs split this into Date and
  // Time by formula, and text where a date is expected propagates as #VALUE!.
  put(["Timestamp"], stamp);
  put(["UHID"], p.uhid || "");
  put(["Patient's Name", "Patient Name"], p.patientName || "");
  put(["Nature of Professional Services"], p.service || "");
  put(["Payment Mode"], p.mode1 || "");
  put(["Amount"], p.amount1 === "" || p.amount1 === undefined ? "" : Number(p.amount1));
  put(["Payment Mode (Payment mode is more than one)"], p.mode2 || "");
  put(["Amount (Payment mode is more than one)"],
      p.amount2 === "" || p.amount2 === undefined ? "" : Number(p.amount2));
  put(["Remarks (If any)", "Remarks"], p.remarks || "");
  // "Checked" is the clinic's own reconciliation tick — left alone.
  return row;
}

// The first free row judged by scanning an actual data column from the
// bottom up, rather than by getLastRow(). getLastRow() counts anything on
// the sheet, formula output included, so on a tab carrying a spilled
// ARRAYFORMULA it points well past the last real entry — exactly what broke
// the receipt numbering once already. colIndex defaults to 1 (column A).
function finFirstFreeRow_(sheet, colIndex) {
  var col = colIndex || 1;
  var last = sheet.getLastRow();
  if (last < 1) return 2;
  var vals = sheet.getRange(1, col, last, 1).getValues();
  for (var i = vals.length - 1; i >= 1; i--) {
    var v = vals[i][0];
    if (v !== "" && v !== null && v !== undefined) return i + 2;
  }
  return 2;
}

// A receipt's date arrives as "YYYY-MM-DD". Two things have gone wrong here
// before, and the stamp has to satisfy both:
//
//   new Date("YYYY-MM-DD") parses as UTC midnight, which this sheet's IST
//   timezone then displays as 05:30 — so the parts are read out of the string
//   and fed to the constructor directly, never parsed as a UTC string.
//
//   Building from the date alone then left every app-saved row reading
//   00:00:00, while the clinic's Google Form rows carry the real moment of
//   entry (11:17:15, 14:08:26 …). App rows stood out as midnight in a column
//   of genuine times. So the chosen date keeps the staff member's intent,
//   and the clock time records when it was actually entered.
function localStampFromISO_(iso) {
  var m = String(iso || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  var now = new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                  now.getHours(), now.getMinutes(), now.getSeconds());
}

function saveReceipt(p) {
  try {
    var ss = SpreadsheetApp.openById(getFinanceSheetId());
    var entry = ss.getSheetByName(FIN_ENTRY_TAB);
    if (!entry) {
      return { success: false, error: "The '" + FIN_ENTRY_TAB + "' tab was not found in the finance sheet." };
    }

    // The receipt is dated by the entry the staff member made, not by the
    // moment the request happened to reach the server.
    var stamp = (p.date && localStampFromISO_(p.date)) || new Date();
    if (isNaN(stamp.getTime())) stamp = new Date();

    var entryHeaders = entry.getRange(1, 1, 1, entry.getLastColumn()).getValues()[0].map(String);
    var entryRow = finReceiptRow_(entryHeaders, p, stamp);
    var entryTarget = finFirstFreeRow_(entry, finCol_(entryHeaders, ["UHID"]) + 1 || 1);
    entry.getRange(entryTarget, 1, 1, entryRow.length).setValues([entryRow]);

    // Deliberately nothing else. "Working" and everything downstream of it
    // update themselves from the row just written — see the note above
    // FIN_ENTRY_TAB before adding any second write here.

    return { success: true, row: entryTarget };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getReceipts(p) {
  try {
    var uhid = String(p.uhid || "").trim().toUpperCase();
    var fromDate = p.fromDate ? new Date(p.fromDate) : null;
    var toDate = p.toDate ? new Date(p.toDate) : null;
    if (toDate) toDate.setHours(23, 59, 59);

    var rows = readFinanceRows("Receipt No.");
    var receipts = rows.filter(function(r) {
      var rUhid = String(fcVal(r, ["uhid"]) || "").trim().toUpperCase();
      if (uhid && rUhid !== uhid) return false;
      var rawDate = fcVal(r, ["date"]);
      var d = rawDate ? new Date(rawDate) : null;
      if (fromDate && d && d < fromDate) return false;
      if (toDate && d && d > toDate) return false;
      return true;
    }).map(function(r) {
      var rawDate = fcVal(r, ["date"]);
      var fm = receiptFeeAndMode(r);
      return {
        date: rawDate ? formatDateISO(rawDate) : "",
        uhid: fcVal(r, ["uhid"]),
        patientName: fcVal(r, ["patient's name", "patient name", "name"]),
        service: fcVal(r, ["nature of professional services", "service"]),
        mode: fm.mode,
        fee: fm.fee,
        receiptNo: fcVal(r, ["e. receipt no", "receipt no", "receipt"]),
        remarks: fcVal(r, ["remarks"])
      };
    });
    receipts.sort(function(a, b) { return (b.date || "").localeCompare(a.date || ""); });
    return { success: true, receipts: receipts };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getDailyCollection(p) {
  try {
    // Supports a single day (legacy `date`) or a range (`fromDate`/`toDate`,
    // used by the Collection tab's Daily/Weekly/Monthly/FY/Custom picker).
    var fromISO = String(p.fromDate || p.date || "").trim();
    var toISO   = String(p.toDate   || p.date || "").trim();
    var rows = readFinanceRows("Receipt No.");
    var dayRows = rows.filter(function(r) {
      var rawDate = fcVal(r, ["date"]);
      var iso = rawDate ? formatDateISO(rawDate) : "";
      if (!fromISO && !toISO) return true;
      if (!iso) return false;
      if (fromISO && iso < fromISO) return false;
      if (toISO && iso > toISO) return false;
      return true;
    });
    var total = 0;
    var byMode = {};
    var receipts = dayRows.map(function(r) {
      var fm = receiptFeeAndMode(r);
      var fee = fm.fee;
      var mode = fm.mode || "Unknown";
      total += fee;
      byMode[mode] = (byMode[mode] || 0) + fee;
      return {
        uhid: fcVal(r, ["uhid"]),
        patientName: fcVal(r, ["patient's name", "patient name", "name"]),
        service: fcVal(r, ["nature of professional services", "service"]),
        mode: mode,
        fee: fee
      };
    });
    return { success: true, fromDate: fromISO, toDate: toISO, total: total, byMode: byMode, count: receipts.length, receipts: receipts };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getFinanceSummary(p) {
  try {
    var todayISO = formatDateISO(new Date());
    var monthPrefix = todayISO.slice(0, 7); // YYYY-MM
    var todayDateObj = new Date();
    var fyStartYear = todayDateObj.getMonth() >= 3 ? todayDateObj.getFullYear() : todayDateObj.getFullYear() - 1;
    var fyFromISO = formatDateISO(new Date(fyStartYear, 3, 1));
    var fyToISO = formatDateISO(new Date(fyStartYear + 1, 2, 31));
    var rows = readFinanceRows("Receipt No.");
    var todayTotal = 0, monthTotal = 0, allTimeTotal = 0, fyTotal = 0;
    var todayByMode = {};
    var recent = [];
    rows.forEach(function(r) {
      var rawDate = fcVal(r, ["date"]);
      var iso = rawDate ? formatDateISO(rawDate) : "";
      var fm = receiptFeeAndMode(r);
      allTimeTotal += fm.fee;
      if (iso === todayISO) {
        todayTotal += fm.fee;
        var mode = fm.mode || "Unknown";
        todayByMode[mode] = (todayByMode[mode] || 0) + fm.fee;
      }
      if (iso.slice(0, 7) === monthPrefix) monthTotal += fm.fee;
      if (iso && iso >= fyFromISO && iso <= fyToISO) fyTotal += fm.fee;
      recent.push({
        date: iso,
        uhid: fcVal(r, ["uhid"]),
        patientName: fcVal(r, ["patient's name", "patient name", "name"]),
        service: fcVal(r, ["nature of professional services", "service"]),
        mode: fm.mode,
        fee: fm.fee
      });
    });
    recent.sort(function(a, b) { return (b.date || "").localeCompare(a.date || ""); });
    return {
      success: true,
      todayTotal: todayTotal, monthTotal: monthTotal, allTimeTotal: allTimeTotal, fyTotal: fyTotal,
      fyLabel: "FY " + fyStartYear + "-" + String(fyStartYear + 1).slice(2),
      totalReceipts: rows.length, todayByMode: todayByMode,
      recent: recent.slice(0, 8)
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Monday-start week key, e.g. "2026-06-29"
function weekBucketKey(d) {
  var dow = d.getDay();
  var diff = dow === 0 ? -6 : 1 - dow;
  var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return formatDateISO(monday);
}
function monthBucketKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
function weekLabel(key) {
  var d = new Date(key + "T00:00:00");
  var end = new Date(d); end.setDate(end.getDate() + 6);
  var fmt = function(x) { return x.toLocaleDateString("en-IN", { day:"2-digit", month:"short" }); };
  return fmt(d) + " – " + fmt(end);
}
function monthLabel(key) {
  var parts = key.split("-");
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
  return d.toLocaleDateString("en-IN", { month:"long", year:"numeric" });
}

// Profit & Loss broken down into weekly or monthly buckets (clinic wants a
// period view, not a single custom date-range total).
function getProfitLoss(p) {
  try {
    var mode = p.mode === "monthly" ? "monthly" : "weekly";
    var periods = parseInt(p.periods) || (mode === "monthly" ? 6 : 8);
    var bucketKeyFn = mode === "monthly" ? monthBucketKey : weekBucketKey;
    var labelFn = mode === "monthly" ? monthLabel : weekLabel;

    var buckets = {}; // key -> {income, expense}
    function addTo(key, field, amt) {
      if (!buckets[key]) buckets[key] = { income: 0, expense: 0 };
      buckets[key][field] += amt;
    }

    readFinanceRows("Receipt No.").forEach(function(r) {
      var rawDate = fcVal(r, ["date"]);
      if (!rawDate) return;
      var d = new Date(rawDate);
      if (isNaN(d.getTime())) return;
      addTo(bucketKeyFn(d), "income", receiptFeeAndMode(r).fee);
    });

    // Expenses sheet doesn't exist yet (pending clinic's reference form) — reads
    // as empty until that tab is populated, so P&L degrades to income-only.
    var expenseRows = readFinanceRows("Expenses");
    expenseRows.forEach(function(r) {
      var rawDate = fcVal(r, ["date"]);
      if (!rawDate) return;
      var d = new Date(rawDate);
      if (isNaN(d.getTime())) return;
      addTo(bucketKeyFn(d), "expense", parseFloat(fcVal(r, ["amount"])) || 0);
    });

    // Build the last `periods` buckets ending at the current one, oldest first
    var now = new Date();
    var currentKey = bucketKeyFn(now);
    var series = [];
    for (var i = periods - 1; i >= 0; i--) {
      var ref = new Date(now);
      if (mode === "monthly") ref.setMonth(ref.getMonth() - i);
      else ref.setDate(ref.getDate() - i * 7);
      var key = bucketKeyFn(ref);
      var b = buckets[key] || { income: 0, expense: 0 };
      series.push({ key: key, label: labelFn(key), income: b.income, expense: b.expense, net: b.income - b.expense, isCurrent: key === currentKey });
    }

    var totalIncome = series.reduce(function(s, x) { return s + x.income; }, 0);
    var totalExpense = series.reduce(function(s, x) { return s + x.expense; }, 0);

    return {
      success: true, mode: mode, series: series,
      totalIncome: totalIncome, totalExpense: totalExpense, totalNet: totalIncome - totalExpense,
      expenseTracked: expenseRows.length > 0
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════
// EXPENSES (matches the clinic's "Expense Form" Google Form fields)
// Lives in the same Finance Google Sheet as Receipts, in an "Expenses"
// tab — getProfitLoss() already reads from here via fuzzy Date/Amount
// column matching, so entries saved here immediately count toward P&L.
// ════════════════════════════════════════════════════════════

function getExpenses(p) {
  try {
    var fromDate = p.fromDate ? new Date(p.fromDate) : null;
    var toDate = p.toDate ? new Date(p.toDate) : null;
    if (toDate) toDate.setHours(23, 59, 59);

    var rows = readFinanceRows("Expenses");
    var expenses = rows.filter(function(r) {
      var rawDate = fcVal(r, ["date"]);
      var d = rawDate ? new Date(rawDate) : null;
      if (fromDate && d && d < fromDate) return false;
      if (toDate && d && d > toDate) return false;
      return true;
    }).map(function(r) {
      var rawDate = fcVal(r, ["date"]);
      return {
        date: rawDate ? formatDateISO(rawDate) : "",
        paidBy: fcVal(r, ["payment done by", "paid by"]),
        expenseName: fcVal(r, ["name of expense", "expense"]),
        amount: parseFloat(fcVal(r, ["amount"])) || 0,
        mode: fcVal(r, ["mode of expense", "mode"]),
        remarks: fcVal(r, ["remarks"]),
        id: fcVal(r, ["id"])
      };
    });
    expenses.sort(function(a, b) { return (b.date || "").localeCompare(a.date || ""); });
    return { success: true, expenses: expenses };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function saveExpense(p) {
  try {
    var sh = getFinanceSheet("Expenses", true);
    if (!sh) return { success: false, error: "Finance 'Expenses' tab not found" };
    if (sh.getLastRow() === 0) {
      sh.appendRow(["Date","Payment Done By","Name of Expense","Amount","Mode of Expense","Remarks","ID"]);
    }
    var id = "EXP-" + Date.now();
    sh.appendRow([p.date, p.paidBy || "", p.expenseName || "", p.amount || "", p.mode || "", p.remarks || "", id]);
    return { success: true, id: id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function deleteExpense(p) {
  try {
    var sh = getFinanceSheet("Expenses");
    if (!sh) return { success: false, error: "Finance 'Expenses' tab not found" };
    var data = sh.getDataRange().getValues();
    var headers = data[0].map(String);
    var idCol = headers.indexOf("ID");
    var id = String(p.id || "").trim();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === id) {
        sh.deleteRow(i + 1);
        return { success: true };
      }
    }
    return { success: false, error: "Expense not found: " + id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Manageable dropdown lists for the Expense form — same pattern as Doctors
// and Appointment Reasons (start empty, clinic adds via "+" in the UI).
function getExpenseCategoriesList() {
  var sh = getSheet("Expense Categories");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  return { success: true, categories: items };
}
function saveExpenseCategoriesList(p) {
  var arr = parseList_(p.categories, "expense categories");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Expense Categories");
  sh.clearContents();
  sh.appendRow(["Category", "Updated At"]);
  arr.forEach(function(c) { sh.appendRow([c, new Date().toISOString()]); });
  return { success: true };
}

// ════════════════════════════════════════════════════════════
// MASTER — Treatments/Fees, Doctor Details, Employees, Payment Modes
// Each is a simple bulk-rewrite list (same pattern as Doctors/Reasons):
// the whole list is replaced on every save from the Master UI.
// ════════════════════════════════════════════════════════════

function getTreatmentsMaster() {
  var sh = getSheet("Treatments Master");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) items.push({ name: data[i][0], fee: data[i][1], department: data[i][2] || "" });
  }
  return { success: true, treatments: items };
}
function saveTreatmentsMaster(p) {
  var arr = parseList_(p.treatments, "treatments master");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Treatments Master");
  sh.clearContents();
  sh.appendRow(["Treatment Name", "Fee", "Department", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(t) { sh.appendRow([t.name, t.fee, t.department || "", now]); });
  return { success: true };
}

function getMedicinesMaster() {
  var sh = getSheet("Medicines Master");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) items.push({ name: data[i][0], dosage: data[i][1] || "", frequency: data[i][2] || "" });
  }
  return { success: true, medicines: items };
}
function saveMedicinesMaster(p) {
  var arr = parseList_(p.medicines, "medicines master");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Medicines Master");
  sh.clearContents();
  sh.appendRow(["Medicine Name", "Default Dosage", "Default Frequency", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(m) { sh.appendRow([m.name, m.dosage || "", m.frequency || "", now]); });
  return { success: true };
}

// Simple reusable value lists for the Prescription form's medicine row
// fields (Dosage/Frequency/Duration/Instructions/Notes) — each is a plain
// string list, same shape as Payment Modes / Chairs, so staff can pick a
// common value instead of retyping it every time.
// Implant brands and the sizes each is stocked in — maintained by the clinic
// in Master (Clinic > Implant Brands & Sizes) rather than fixed in the app,
// so a new system or a discontinued size is a sheet edit, not a code change.
// Sizes are one comma-separated string per brand; the form splits them and
// still accepts anything typed, so an unlisted size never blocks a case.
function getImplantBrandsList() {
  var sh = getSheet("Implant Brands");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    items.push({ name: String(data[i][0]).trim(), sizes: String(data[i][1] === undefined || data[i][1] === null ? "" : data[i][1]).trim() });
  }
  return { success: true, brands: items };
}
function saveImplantBrandsList(p) {
  var arr = parseList_(p.brands, "implant brands");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Implant Brands");
  sh.clearContents();
  sh.appendRow(["Brand", "Sizes", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(b) { sh.appendRow([b.name, b.sizes || "", now]); });
  return { success: true };
}

function getMedicineDosagesList() {
  var sh = getSheet("Medicine Dosages");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  return { success: true, dosages: items };
}
function saveMedicineDosagesList(p) {
  var arr = parseList_(p.dosages, "medicine dosages");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Medicine Dosages");
  sh.clearContents();
  sh.appendRow(["Dosage", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(v) { sh.appendRow([v, now]); });
  return { success: true };
}

function getMedicineFrequenciesList() {
  var sh = getSheet("Medicine Frequencies");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  return { success: true, frequencies: items };
}
function saveMedicineFrequenciesList(p) {
  var arr = parseList_(p.frequencies, "medicine frequencies");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Medicine Frequencies");
  sh.clearContents();
  sh.appendRow(["Frequency", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(v) { sh.appendRow([v, now]); });
  return { success: true };
}

function getMedicineDurationsList() {
  var sh = getSheet("Medicine Durations");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  return { success: true, durations: items };
}
function saveMedicineDurationsList(p) {
  var arr = parseList_(p.durations, "medicine durations");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Medicine Durations");
  sh.clearContents();
  sh.appendRow(["Duration", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(v) { sh.appendRow([v, now]); });
  return { success: true };
}

// Instructions library — Situation + Instruction text, grouped by category
// (e.g. Oral Hygiene / Diet / Medications), matching the same structure as
// Clinical Note Templates. Older rows may have only a flat instruction string
// in column A with no situation — read them back with situation defaulted to
// that text so nothing already saved is lost.
function getMedicineInstructionsList() {
  var sh = getSheet("Medicine Instructions");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) items.push({ situation: data[i][0], text: data[i][1] || data[i][0], category: data[i][2] || "" });
  }
  return { success: true, instructions: items };
}
function saveMedicineInstructionsList(p) {
  var arr = parseList_(p.instructions, "medicine instructions");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Medicine Instructions");
  sh.clearContents();
  sh.appendRow(["Situation", "Instruction", "Category", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(v) {
    if (typeof v === "string") sh.appendRow([v, v, "", now]);
    else sh.appendRow([v.situation, v.text, v.category || "", now]);
  });
  return { success: true };
}

function getMedicineNotesList() {
  var sh = getSheet("Medicine Notes");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  return { success: true, medNotes: items };
}
function saveMedicineNotesList(p) {
  var arr = parseList_(p.medNotes, "medicine notes");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Medicine Notes");
  sh.clearContents();
  sh.appendRow(["Note", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(v) { sh.appendRow([v, now]); });
  return { success: true };
}

function getClinicProfile() {
  var sh = getSheet("Clinic Profile");
  var data = sh.getDataRange().getValues();
  var profile = {};
  for (var i = 1; i < data.length; i++) { if (data[i][0]) profile[data[i][0]] = data[i][1] || ""; }
  return { success: true, profile: profile };
}
function saveClinicProfile(p) {
  var profile = null;
  if (p.profile && typeof p.profile === "object") profile = p.profile;
  else if (p.profile) { try { profile = JSON.parse(p.profile); } catch (e) { profile = null; } }
  // Same rule as the lists: a payload that never arrived, or arrived cut
  // short, must not be read as "the clinic has no letterhead".
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { success: false, error: "the clinic profile never reached the sheet" };
  }
  var sh = getSheet("Clinic Profile");
  sh.clearContents();
  sh.appendRow(["Field", "Value"]);
  Object.keys(profile).forEach(function(k) { sh.appendRow([k, profile[k]]); });
  return { success: true };
}

// A phone column of digits leaves a sheet as a NUMBER, not text. The app then
// calls .trim() on it and throws, far from here and for no visible reason —
// which is what made Master's Save button do nothing at all. Everything that
// leaves this sheet as a person's detail leaves as text.
function person_(row) {
  return {
    name:  String(row[0] === undefined || row[0] === null ? "" : row[0]).trim(),
    phone: String(row[1] === undefined || row[1] === null ? "" : row[1]).trim(),
    email: String(row[2] === undefined || row[2] === null ? "" : row[2]).trim(),
    role:  String(row[3] === undefined || row[3] === null ? "" : row[3]).trim()
  };
}

function getDoctorDetailsList() {
  var sh = getSheet("Doctor Details");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) items.push(person_(data[i]));
  }
  return { success: true, doctors: items };
}
function saveDoctorDetailsList(p) {
  var arr = parseList_(p.doctors, "doctor details");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Doctor Details");
  sh.clearContents();
  sh.appendRow(["Name", "Phone", "Email", "Role", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(d) { sh.appendRow([d.name, d.phone || "", d.email || "", d.role || "", now]); });
  return { success: true };
}

function getEmployeesList() {
  var sh = getSheet("Employees");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) items.push(person_(data[i]));
  }
  return { success: true, employees: items };
}
function saveEmployeesList(p) {
  var arr = parseList_(p.employees, "employees");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Employees");
  sh.clearContents();
  sh.appendRow(["Name", "Phone", "Email", "Role", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(emp) { sh.appendRow([emp.name, emp.phone || "", emp.email || "", emp.role || "", now]); });
  return { success: true };
}

function getPaymentModesList() {
  var sh = getSheet("Payment Modes");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  return { success: true, modes: items };
}
function savePaymentModesList(p) {
  var arr = parseList_(p.modes, "payment modes");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Payment Modes");
  sh.clearContents();
  sh.appendRow(["Mode", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(m) { sh.appendRow([m, now]); });
  return { success: true };
}

// Chairs list — synced via Google Sheet (not localStorage) so a chair added
// on one front-desk computer is immediately visible on every other computer,
// matching the same multi-computer requirement as the rest of the app.
// The panels the clinic is empanelled with — CGHS, DGEHS, BSES, DJB, MCD,
// Delhi Police and whatever comes next. Kept as a list the clinic edits in
// Master rather than in code, because a new panel is a commercial
// arrangement, not a software change: adding one should not need a developer,
// a deployment, or a wait.
// ── Panel rate cards ────────────────────────────────────────────
// A panel bills by ITS OWN code, not by the clinic's treatment names. CGHS
// lists "RCT-Single Rooted tooth" as DP030; the clinic calls it something
// else. Mapping the two would mean a translation table that goes wrong the day
// either side renames anything, and a wrong code is a rejected claim — so the
// panel's list is kept whole and separate, and panel billing picks from it by
// code.
//
// CGHS publishes three columns — Non-NABH, NABH and Super Speciality. K.B.
// Dental bills at the NABH rate, so that is the one stored and there is no
// setting to get wrong. If the clinic's accreditation ever changes, the rate
// card is re-imported from the column that then applies.
var PANEL_RATES_TAB = "Panel Rates";
var PANEL_RATE_HEADERS = ["Panel", "Code", "Procedure", "Rate", "Classification", "Updated At"];

function getPanelRates(p) {
  var sh = getSheet(PANEL_RATES_TAB);
  var data = sh.getDataRange().getValues();
  var want = String((p && p.panel) || "").trim().toUpperCase();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][1]) continue;                       // no code, no row
    if (want && String(data[i][0]).trim().toUpperCase() !== want) continue;
    items.push({
      panel: data[i][0], code: String(data[i][1]).trim(), procedure: data[i][2],
      rate: data[i][3], classification: data[i][4] || ""
    });
  }
  return { success: true, rates: items };
}

// Replaces ONE panel's rates and leaves every other panel's alone. The other
// masters rewrite themselves wholesale, which is fine for six payment modes;
// doing that here would let one mistaken import wipe every panel's rate card.
function savePanelRates(p) {
  var sh = getSheet(PANEL_RATES_TAB);
  var panel = String((p && p.panel) || "").trim();
  if (!panel) return { success: false, error: "No panel given" };

  var arr = parseList_(p.rates, "rate card");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };

  var data = sh.getDataRange().getValues();
  var kept = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] && String(data[i][0]).trim().toUpperCase() !== panel.toUpperCase()) kept.push(data[i]);
  }
  var others = kept.length;

  var now = new Date().toISOString();
  arr.forEach(function (r) {
    var code = String((r && r.code) || "").trim();
    if (!code) return;                               // a rate with no code cannot be claimed
    kept.push([panel, code, r.procedure || "", r.rate || "", r.classification || "", now]);
  });

  // Written in one block. A thousand appendRow calls is a thousand round trips
  // and the import would time out long before it finished.
  sh.clearContents();
  var out = [PANEL_RATE_HEADERS].concat(kept);
  sh.getRange(1, 1, out.length, PANEL_RATE_HEADERS.length).setValues(
    out.map(function (row) {
      var r = row.slice(0, PANEL_RATE_HEADERS.length);
      while (r.length < PANEL_RATE_HEADERS.length) r.push("");
      return r;
    }));
  return { success: true, saved: kept.length - others, kept: others };
}

function getPanelsList() {
  var sh = getSheet("Panels");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(String(data[i][0]).trim()); }
  return { success: true, panels: items };
}
function savePanelsList(p) {
  var arr = parseList_(p.panels, "panels");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Panels");
  sh.clearContents();
  sh.appendRow(["Panel", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function (m) { if (String(m || "").trim()) sh.appendRow([String(m).trim(), now]); });
  return { success: true };
}

function getChairsList() {
  var sh = getSheet("Chairs");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) { if (data[i][0]) items.push(data[i][0]); }
  // No built-in fallback. It used to return Chair 1-4 whenever the tab was
  // empty, which is why the clinic never had to fill the tab in — and why a
  // chair deleted in Master reappeared. The tab is the only source now, and an
  // empty one honestly reports no chairs rather than inventing four.
  return { success: true, chairs: items };
}
function saveChairsList(p) {
  var arr = parseList_(p.chairs, "chairs");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Chairs");
  sh.clearContents();
  sh.appendRow(["Chair", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(c) { sh.appendRow([c, now]); });
  return { success: true };
}

function getClinicalNoteTemplates() {
  var sh = getSheet("Clinical Note Templates");
  var data = sh.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) items.push({ situation: data[i][0], text: data[i][1], category: data[i][2] || "" });
  }
  return { success: true, templates: items };
}
function saveClinicalNoteTemplates(p) {
  var arr = parseList_(p.templates, "clinical note templates");
  if (arr && arr.__bad) return { success: false, error: arr.__bad };
  var sh = getSheet("Clinical Note Templates");
  sh.clearContents();
  sh.appendRow(["Situation", "Template Text", "Category", "Updated At"]);
  var now = new Date().toISOString();
  arr.forEach(function(t) { sh.appendRow([t.situation, t.text, t.category || "", now]); });
  return { success: true };
}

function getPatientOutstanding(p) {
  try {
    var uhid = String(p.uhid || "").trim().toUpperCase();
    if (!uhid) return { success: false, error: "uhid required" };

    // Latest Treatment Plan estimate total for this patient
    var tpSheet = getSheet("Treatment Plans");
    var tpData = tpSheet.getDataRange().getValues();
    var estimateTotal = 0;
    for (var i = 1; i < tpData.length; i++) {
      if (String(tpData[i][0]).trim().toUpperCase() === uhid) {
        var est = safeParseJSON(tpData[i][4]);
        if (est && est.total) estimateTotal = Number(est.total) || 0;
      }
    }

    // Sum of all receipts for this patient
    var rows = readFinanceRows("Receipt No.");
    var paid = 0;
    rows.forEach(function(r) {
      var rUhid = String(fcVal(r, ["uhid"]) || "").trim().toUpperCase();
      if (rUhid === uhid) paid += receiptFeeAndMode(r).fee;
    });

    return { success: true, uhid: uhid, estimateTotal: estimateTotal, paid: paid, outstanding: estimateTotal - paid };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Every patient with a saved Treatment Plan estimate, compared against what
// they've actually paid — returns only those still owing money, highest first.
function getOutstandingList(p) {
  try {
    var tpSheet = getSheet("Treatment Plans");
    var tpData = tpSheet.getDataRange().getValues();

    // Sum of all receipts, grouped by UHID
    var paidByUhid = {};
    readFinanceRows("Receipt No.").forEach(function(r) {
      var rUhid = String(fcVal(r, ["uhid"]) || "").trim().toUpperCase();
      if (!rUhid) return;
      paidByUhid[rUhid] = (paidByUhid[rUhid] || 0) + receiptFeeAndMode(r).fee;
    });

    var list = [];
    for (var i = 1; i < tpData.length; i++) {
      var uhid = String(tpData[i][0] || "").trim().toUpperCase();
      if (!uhid) continue;
      var est = safeParseJSON(tpData[i][4]);
      var estimateTotal = (est && est.total) ? Number(est.total) || 0 : 0;
      if (estimateTotal <= 0) continue;
      var paid = paidByUhid[uhid] || 0;
      var outstanding = estimateTotal - paid;
      if (outstanding <= 0) continue;
      list.push({
        uhid: uhid,
        patientName: tpData[i][1] || "",
        estimateTotal: estimateTotal,
        paid: paid,
        outstanding: outstanding
      });
    }
    list.sort(function(a, b) { return b.outstanding - a.outstanding; });

    var totalOutstanding = list.reduce(function(s, x) { return s + x.outstanding; }, 0);
    return { success: true, list: list, count: list.length, totalOutstanding: totalOutstanding };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════


function formatDOB(raw) {
  if (!raw) return "";
  try {
    // Already DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(String(raw))) return raw;
    // ISO format, or an actual Date object from a Sheets date-formatted cell —
    // format in the spreadsheet's own timezone, NOT UTC. A UTC read shifts a
    // midnight-local date back by the UTC offset (e.g. 22 Jul IST becomes
    // 21 Jul 18:30 UTC), so any DOB edited via a real date cell silently
    // lands on the wrong day everywhere DOB is used (birthdays, receipts, etc).
    var d = new Date(raw);
    if (!isNaN(d.getTime())) {
      var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
      return Utilities.formatDate(d, tz, "dd/MM/yyyy");
    }
    return String(raw);
  } catch(e) { return String(raw); }
}

function safeJSON(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  try { return JSON.stringify(val); } catch(e) { return String(val); }
}

function safeParseJSON(val) {
  if (!val || val === "") return null;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch(e) { return null; }
}

// ════════════════════════════════════════════════════════════
// CLINICAL RECORDS — their own spreadsheet
// ════════════════════════════════════════════════════════════
// Every clinical form's records live in a spreadsheet of their own, kept apart
// from Registrations, Appointments and Finance. Which spreadsheet is set by the
// Script Property CLINICAL_SHEET_ID — never by editing code — the same way
// Finance's is.
//
// Until that property is set, everything stays in this (the PMS) spreadsheet
// exactly as before, so this can be deployed before the new file exists.
// Setting it is done by copyClinicalRecordsToNewFile below, not by hand, so the
// app is never pointed at a file its records have not been copied into yet.
// See defaultSheetId_ above: the main clinic keeps its records in its own PMS
// book by default; any copy keeps them in itself, never in the main clinic's.
var CLINICAL_SHEET_ID_DEFAULT = "1DtoZ3MNFq2Enr-ClAjENWFzk8SF2dYN9e1nGf7tAJC4";

function getClinicalSheetId() {
  var stored = PropertiesService.getScriptProperties().getProperty("CLINICAL_SHEET_ID");
  return stored || defaultSheetId_(CLINICAL_SHEET_ID_DEFAULT);
}

// Kept for setupClinicalRecordTabs, which opens the clinical file by this name.
var CLINICAL_SHEET_ID = getClinicalSheetId();

function getClinicalSheet(tabName) {
  var ss = SpreadsheetApp.openById(getClinicalSheetId());
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
  }
  return sh;
}

// ── One-off: move the clinic's form records into their own spreadsheet ───
// Copies every clinical tab from this spreadsheet into the new one, checks
// that each copy holds exactly as many rows and columns as its original, and
// only then points the app at the new file. Nothing in this spreadsheet is
// deleted or edited — the originals stay exactly as they are.
//
// Before running it:
//   1. Make a new, empty Google Sheet. Copy the long ID out of its address
//      bar — the part between /d/ and /edit.
//   2. Project Settings → Script Properties → Add script property
//        CLINICAL_SHEET_ID_NEW   =   that ID
//   3. Pick copyClinicalRecordsToNewFile in the function list, Run, and read
//      the Execution log.
// Run it outside clinic hours: a record saved while it runs lands in this
// file after its tab has already been copied, and would not be in the new one.
//
// Safe to re-run until it has switched over — a tab left by an earlier,
// interrupted run is replaced rather than duplicated. Once it has switched it
// refuses to run, so the live file can never be overwritten from here.
var CLINICAL_FLAT_TABS = [
  "Pathology", "Radiology", "Radiograph", "Local Anesthesia", "Intra Oral Scan",
  "Scaling", "Minor Surgery", "TMJoint", "Restoration", "Orthodontics",
  "Orthodontics Progress", "Denture", "Pedo", "Lab Log", "Prescriptions",
  // Historical flat tabs for the four JSON-blob forms.
  "RCT", "Implant Surgery", "Implant Prosthetic", "Crown & Bridge"
];

function clinicalTabsToCopy_() {
  var names = CLINICAL_FLAT_TABS.slice();
  names.push(CLINICAL_SHEETS_SHARED_TAB);
  for (var k in CLINICAL_SHEET_TABS) names.push(CLINICAL_SHEET_TABS[k]);
  return names;
}

function copyClinicalRecordsToNewFile() {
  var props = PropertiesService.getScriptProperties();
  var newId = String(props.getProperty("CLINICAL_SHEET_ID_NEW") || "").trim();
  if (!newId) {
    Logger.log("Set the Script Property CLINICAL_SHEET_ID_NEW to the new spreadsheet's ID first. Nothing was done.");
    return;
  }
  // The switched-over case first: it is the same refusal, but it can say
  // exactly why, and it is the one someone re-running this will hit.
  if (props.getProperty("CLINICAL_SHEET_ID") === newId) {
    Logger.log("The app already uses that spreadsheet. Refusing to copy over live records. Nothing was done.");
    return;
  }
  if (newId === getClinicalSheetId()) {
    Logger.log("CLINICAL_SHEET_ID_NEW is the file the records are already in — it has to be a different, new file. Nothing was done.");
    return;
  }

  // This book's own records — never another instance's.
  var from = SpreadsheetApp.openById(getClinicalSheetId());
  var to = SpreadsheetApp.openById(newId);
  var copied = [], absent = [], problems = [];

  clinicalTabsToCopy_().forEach(function(name) {
    var src = from.getSheetByName(name);
    if (!src) { absent.push(name); return; }
    var copy = src.copyTo(to);
    // A tab by this name in the new file can only be left over from an
    // earlier, interrupted run — the new file is not live yet — so replace it.
    var old = to.getSheetByName(name);
    if (old) to.deleteSheet(old);
    copy.setName(name);
    var rs = src.getLastRow(), cs = src.getLastColumn();
    var rc = copy.getLastRow(), cc = copy.getLastColumn();
    if (rs !== rc || cs !== cc) {
      problems.push(name + ": original " + rs + " rows x " + cs + " cols, copy " + rc + " x " + cc);
    } else {
      copied.push(name + " (" + Math.max(rs - 1, 0) + " records)");
    }
  });

  // A new spreadsheet starts with an empty "Sheet1"; drop it so the file holds
  // only the clinic's own tabs.
  var blank = to.getSheetByName("Sheet1");
  if (blank && blank.getLastRow() === 0 && to.getSheets().length > 1) to.deleteSheet(blank);

  Logger.log("Copied " + copied.length + " tab(s):\n  " + copied.join("\n  "));
  if (absent.length) Logger.log("Not in this spreadsheet, so nothing to copy: " + absent.join(", "));

  if (problems.length) {
    Logger.log("NOT SWITCHED — these copies do not match their originals:\n  " + problems.join("\n  "));
    Logger.log("The app still uses this spreadsheet and nothing here was changed. Run this again.");
    return;
  }
  props.setProperty("CLINICAL_SHEET_ID", newId);
  Logger.log("Every copy matches its original. The app now reads and saves form records in the new spreadsheet.");
  Logger.log("Nothing in this spreadsheet was deleted or changed.");
}

// Generic fetch by UHID from any clinical tab
function getClinicalRecords(p) {
  var tabName = String(p.tabName || "");
  var uhid    = String(p.uhid   || "").trim().toUpperCase();
  if (!tabName || !uhid) return { success: false, error: "tabName and uhid required" };

  var sh   = getClinicalSheet(tabName);
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { success: true, records: [] };

  var headers = data[0];
  // Find UHID column
  var uhidIdx = -1;
  for (var h = 0; h < headers.length; h++) {
    var hl = String(headers[h]).toLowerCase();
    if (hl === "uhid" || hl === "uhid no." || hl === "uhid no" || hl.includes("uhid")) {
      uhidIdx = h; break;
    }
  }
  if (uhidIdx < 0) uhidIdx = 1; // fallback: col B (after Timestamp)

  var records = [];
  for (var i = 1; i < data.length; i++) {
    var rowUhid = String(data[i][uhidIdx] || "").trim().toUpperCase();
    if (rowUhid !== uhid) continue;
    var obj = { _rowIndex: i + 1 };
    headers.forEach(function(h, k) {
      var key = String(h).trim();
      var val = data[i][k];
      if (val instanceof Date) {
        obj[key] = val.toISOString();
      } else {
        obj[key] = String(val || "");
      }
    });
    records.push(obj);
  }
  return { success: true, records: records, headers: headers.map(String) };
}

// Generic save to any clinical tab
function saveClinicalRecord(p) {
  var tabName = String(p.tabName || "");
  if (!tabName) return { success: false, error: "tabName required" };

  var sh = getClinicalSheet(tabName);
  var fields = p.fields || {}; // { "Field Name": "value", ... }

  // Write header if empty
  if (sh.getLastRow() === 0) {
    var hdrs = ["Timestamp"].concat(Object.keys(fields));
    sh.appendRow(hdrs);
  }

  // Read existing headers to maintain column order
  var existingHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);

  // Auto-extend header row with any new field keys not already present
  // (keeps older rows intact — they just show blank under the new columns)
  var newKeys = Object.keys(fields).filter(function(k) { return existingHeaders.indexOf(k) < 0; });
  if (newKeys.length) {
    sh.getRange(1, existingHeaders.length + 1, 1, newKeys.length).setValues([newKeys]);
    existingHeaders = existingHeaders.concat(newKeys);
  }

  var row = existingHeaders.map(function(h) {
    if (h === "Timestamp") return new Date().toISOString();
    return fields[h] !== undefined ? fields[h] : "";
  });

  sh.appendRow(row);
  return { success: true };
}

// ── One-time setup: pre-create every clinical record tab with the exact
// headers saveClinicalRecord() would generate on first real save — run this
// ONCE manually from the Apps Script editor (select it in the function
// dropdown, click Run) BEFORE copying old records over, so pasted data lines
// up with the right columns. Never touches a tab that already has rows.
function setupClinicalRecordTabs() {
  var tabs = [
    { tabName: "Pathology", fields: ["UHID","Name of Patient","Age","Gender","Name of Test Advised","Type of Sample","Sample Collection Site / Teeth No.","Sample Collection Date","Sending Date","Sending Time","Name of Sending Person","Name of Lab","Report Recieved Date","Report Recieved Time","Critical Alert","Any Critical Report","Any Reporting Error","Name of Receiving Person","Clinical Diagnosis","Specimen Adequacy","Chain of Custody","Pathologist Name","Report Findings","Follow-up Action"] },
    { tabName: "Radiology", fields: ["UHID","Name of Patient","Age","Gender","Name of Test Advised","Site/Teeth No.","Advised Date","Advised Time","Test Centre Name","Report Receive Date","Report Receive Time","No. with Centre","Any Reporting Error","Critical Results in Report","Name of Receiving Person","Clinical Indication","Comparison with Previous Imaging","Radiation Dose","Radiologist Name","Findings Summary","Follow-up Recommendation"] },
    { tabName: "Radiograph", fields: ["UHID","Patient Name","Age","Gender","Tooth No. / Site","Procedure Performed","Number of Radiographs Taken","Number of Radiographs Discarded","Reason of Discarding","Type of Radiograph","Technique","Exposure Settings","Quality Rating","Radiation Protection Used","Name of Operator","Remarks"] },
    { tabName: "Local Anesthesia", fields: ["UHID","Name of Patient","Age","Gender","Name of Dental Procedure","L.A Administered","Batch No. of L. A. Administered","Date of Bottle Opening","Quantity of L. A. Administered","Time of L. A. Administered","Hyper Sensitivity test done yes/ Done Earlier","Reaction","Operating Dentist","Medical History Check","Technique","Injection Site","Vasoconstrictor Used","Aspiration Done","Onset Time","Duration Achieved","Post-injection Monitoring","Complications","Remarks"] },
    { tabName: "Intra Oral Scan", fields: ["UHID No.","Name of Patient","Age","Gender","Tooth No. / Site","For Procedure","Name of Operator","Remarks","Scanner Used","Scan Type","Number of Images","Scan Quality","File Format Exported","Sent to Lab"] },
    { tabName: "Scaling", fields: ["UHID No.","Name of Patient","Age","Gender","Polishing Done","Name of Operator","Remarks","Grade of Calculus","Bleeding on Probing","Oral Hygiene Before","Type of Scaling","Instrument Used","Oral Hygiene After","Patient Education Given","Next Recall Interval"] },
    { tabName: "Minor Surgery", fields: ["UHID","Name","Age","Gender","Tooth No. / Site","Local Anesthesia","Quantity","Procedure Done","Suture Placed","Operating Doctor","Bone Graft/Membrane Used (if Any)","Any Alert","Remarks","Type of Surgery","Incision Type","Hemostasis Achieved","Suture Material","Post-op Medication Prescribed","Post-op Instructions Given","Follow-up Date"] },
    { tabName: "TMJoint", fields: ["UHID No.","Name the Patient","Age","Gender","Occupation","Investigation Available","Procedures Done","Relief Treatment Given (if any)","Name of the Operator","Remarks","Chief Complaint","Pain Side","Pain Scale","Joint Sounds","Mouth Opening (mm)","Deviation on Opening","Muscle Tenderness","Parafunctional Habits","Occlusal Analysis","Diagnosis","Treatment Given","Splint Type","Follow-up Plan"] },
    { tabName: "Restoration", fields: ["UHID No.","Name of patient","Age","Gender","Tooth No. / Site","Type of Restoration","Investigation Used","Material Used","Name of Operator","Remarks","Cavity Class","Cavity Surface","Bonding System","Composite Brand","Shade","Composite Layer","Composite Type","Occlusion Check","Finishing & Polishing","Clinical Notes"] },
    { tabName: "Orthodontics", fields: ["UHID No.","Name of Patient","Age","Gender","Treatment Required","Investigations","Name of Operator","Tratment Starting Date","Treatment Ending Date","Remarks","Malocclusion Type","Skeletal Pattern","Extraction Required","Extraction Teeth","Appliance Type","Arch","Anchorage (TADs)","Retainer Type"] },
    { tabName: "Orthodontics Progress", fields: ["UHID","Name of Patient","Age","Gender","Visit Date","Current Archwire","Archwire Changed This Visit","Elastics Used","Aligner Number / Stage","Treatment Phase","Oral Hygiene Status","Bracket / Bond Issues","Pain / Discomfort","Patient Compliance","Next Appointment Date","Name of Operator","Notes"] },
    { tabName: "Denture", fields: ["UHID","Name","Age","Gender","Tooth No. / Site","Local Anesthesia","Quantity","Prosthesis required","Type of Impression","Procedure Done","Operating Doctor","Final Prosthesis Required","Shade","Remarks","Denture Type","Arch","Edentulous Status","Primary Impression","Jaw Relation Record","Try-in Done","Occlusal Scheme","Final Impression","Lab Name","Sending Date","Receiving Date","Insertion Date","Denture Material","Mould","Care Instructions Given","Follow-up / Review Date"] },
    { tabName: "Pedo", fields: ["UHID","Name","Age","Gender","Tooth No. / Site","Local Anesthesia","Quantity","Procedure Done","Operating Doctor","Additional Procedure","Additional Information","Post-op Follow up","Any Alert","Remarks","Behavior Management Technique","Frankl Behavior Rating","Parent Present","Caries Risk","Pulp Therapy Type","Medicament Used","Space Maintainer Type","Fluoride Application","Sealants Placed (Teeth)","Habit Counselling Given","Next Visit / Recall Date"] },
    { tabName: "Lab Log", fields: ["UHID No.","Patient Name","Age","Gender","Clinical Work Done","Type of Work Required","Items Included","Shade","Tooth No. / Site","Work Sending Date","Work Receiving Date","Work Received","Items (Inclusions) Received","Name of Lab","Case Sent By (name of employee)","Remarks","Material Specification","Workflow","Work Order Number","Courier / Delivery Method","Quality Check on Receipt","Rework Required","Rework Reason","Billing Reference"] },

    // These 4 currently also save live via the "Clinical Sheets" JSON-blob tab
    // (RCT/Implant Surgery/Implant Prosthetic/Crown & Bridge forms) — these flat
    // versions are purely for pasting in historical records with real columns,
    // matching the same sections shown on each one's print sheet.
    { tabName: "RCT", fields: ["UHID","Patient Name","Age","Gender","Tooth No.","Visit Date","Doctor","Anaesthesia & Isolation — Date","Anaesthesia","Rubber Dam","Access Opening — Date","Access Cavity Prep'n and Pulp Extirpation","No. of Canals","Bio-Mechanical Prep — Date","Length Determination","Instrument Used","Irrigant Used","Intracanal Medication","Temporary Dressing","Complications","Obturation — Date","Complete / Sectional","Master Cone Size","Sealer Used","Condensation Tech: Lateral / Vertical / Thermal","Apical Seal","Lateral Condensation","Post-Endo Restoration — Date","Post Endo. Restoration: Composite / Post Core","Post: Fibre / Customized","Post-Operative Follow up","Crown Placement","Redo (if any) Date"] },
    { tabName: "Implant Surgery", fields: ["UHID","Patient Name","Age","Gender","Implant Site","Visit Date","Doctor","Investigations & Planning — Date","Investigations","Implant Placement — Date","Brand / Company","Size (Dia x Length)","Osteotomy","Grafting","Torque / RFA","Cover Screw / H.A. / Temp Abutment","Provisional Prosthesis","Implant Reference No.","Implant LOT No.","Register Serial No.","Explantation Date (if any)","Redo Date (if any)"] },
    { tabName: "Implant Prosthetic", fields: ["UHID","Patient Name","Age","Gender","Implant Site","Visit Date","Doctor","Clinical Assessment — Date","Investigation","Impression — Date","Impression","Tray Used","Bite","Shade","Prosthesis Type","Type of Crown","Material","Customized Abutment","Abutment Material","Laboratory Name","Sending Date","Receiving Date","Insertion — Date","Final Torque (Ncm)"] },
    { tabName: "Crown & Bridge", fields: ["UHID","Patient Name","Age","Gender","Tooth No.","Visit Date","Doctor","Preparation — Date","Investigations","Local Anaesthesia","Instruments (Burs, Flexistrip)","Provisional Prosthesis","Provisional Insertion Date","Modification Date (if any)","Final Impression — Date","Final Impression","Tray","Impression Material","Bite","Shade","Type","Material","Lab & Insertion — Date","Laboratory Name","Insertion Date","Redo Date (if any)"] }
  ];

  var ss = SpreadsheetApp.openById(CLINICAL_SHEET_ID);
  var report = [];
  tabs.forEach(function(t) {
    var expectedHeaders = ["Timestamp"].concat(t.fields);
    var existing = ss.getSheetByName(t.tabName);

    if (existing) {
      // Never touched — you decide whether to rename/delete it yourself first,
      // so a brand-new tab with the exact expected column sequence can be made.
      report.push(t.tabName + ": ALREADY EXISTS — not touched. Rename or delete '" + t.tabName + "' in the sheet yourself, then run this again to get a fresh tab with all " + expectedHeaders.length + " columns in order.");
      return;
    }

    var sh = ss.insertSheet(t.tabName);
    sh.appendRow(expectedHeaders);
    report.push(t.tabName + ": created fresh with " + expectedHeaders.length + " columns, in order");
  });

  Logger.log(report.join("\n"));
  return report;
}

// ── Specific save functions per form ─────────────────────────

function savePathology(p) {
  return saveClinicalRecord({
    tabName: "Pathology",
    fields: {
      "UHID": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Name of Test Advised": p.testAdvised || "",
      "Type of Sample": p.sampleType || "",
      "Sample Collection Site / Teeth No.": p.sampleSite || "",
      "Sample Collection Date": p.sampleDate || "",
      "Sending Date": p.sendingDate || "",
      "Sending Time": p.sendingTime || "",
      "Name of Sending Person": p.sendingPerson || "",
      "Name of Lab": p.labName || "",
      "Report Recieved Date": p.reportDate || "",
      "Report Recieved Time": p.reportTime || "",
      "Critical Alert": p.criticalAlert || "",
      "Any Critical Report": p.criticalReport || "",
      "Any Reporting Error": p.reportingError || "",
      "Name of Receiving Person": p.receivingPerson || "",
      "Clinical Diagnosis": p.clinicalDiagnosis || "",
      "Specimen Adequacy": p.specimenAdequacy || "",
      "Chain of Custody": p.chainOfCustody || "",
      "Pathologist Name": p.pathologistName || "",
      "Report Findings": p.reportFindings || "",
      "Follow-up Action": p.followupAction || "",
      "Remarks": p.remarks || ""
    }
  });
}

function saveRadiology(p) {
  return saveClinicalRecord({
    tabName: "Radiology",
    fields: {
      "UHID": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Name of Test Advised": p.testAdvised || "",
      "Site/Teeth No.": p.siteTeeth || "",
      "Advised Date": p.advisedDate || "",
      "Advised Time": p.advisedTime || "",
      "Test Centre Name": p.testCentre || "",
      "Report Receive Date": p.reportDate || "",
      "Report Receive Time": p.reportTime || "",
      "No. with Centre": p.centreNo || "",
      "Any Reporting Error": p.reportingError || "",
      "Critical Results in Report": p.criticalResults || "",
      "Name of Receiving Person": p.receivingPerson || "",
      "Clinical Indication": p.clinicalIndication || "",
      "Comparison with Previous Imaging": p.comparisonPrevious || "",
      "Radiation Dose": p.radiationDose || "",
      "Radiologist Name": p.radiologistName || "",
      "Findings Summary": p.findingsSummary || "",
      "Follow-up Recommendation": p.followupRecommendation || "",
      "Remarks": p.remarks || ""
    }
  });
}

function saveRadiograph(p) {
  return saveClinicalRecord({
    tabName: "Radiograph",
    fields: {
      "UHID": p.uhid || "",
      "Patient Name": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Tooth No. / Site": p.toothSite || "",
      "Procedure Performed": p.procedure || "",
      "Number of Radiographs Taken": p.taken || "",
      "Number of Radiographs Discarded": p.discarded || "",
      "Reason of Discarding": p.discardReason || "",
      "Type of Radiograph": p.radiographType || "",
      "Technique": p.technique || "",
      "Exposure Settings": p.exposureSettings || "",
      "Quality Rating": p.qualityRating || "",
      "Radiation Protection Used": p.radiationProtection || "",
      "Name of Operator": p.operator || "",
      "Remarks": p.remarks || ""
    }
  });
}

function saveLocalAnesthesia(p) {
  return saveClinicalRecord({
    tabName: "Local Anesthesia",
    fields: {
      "UHID": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Name of Dental Procedure": p.procedure || "",
      "L.A Administered": p.laType || "",
      "Batch No. of L. A. Administered": p.batchNo || "",
      "Date of Bottle Opening": p.bottleDate || "",
      "Quantity of L. A. Administered": p.quantity || "",
      "Time of L. A. Administered": p.laTime || "",
      "Hyper Sensitivity test done yes/ Done Earlier": p.sensitivityTest || "",
      "Reaction": p.reaction || "",
      "Operating Dentist": p.doctor || "",
      "Medical History Check": p.medHistoryCheck || "",
      "Technique": p.technique || "",
      "Injection Site": p.injectionSite || "",
      "Vasoconstrictor Used": p.vasoconstrictor || "",
      "Aspiration Done": p.aspirationDone || "",
      "Onset Time": p.onsetTime || "",
      "Duration Achieved": p.durationAchieved || "",
      "Post-injection Monitoring": p.postInjectionMonitoring || "",
      "Complications": p.complications || "",
      "Remarks": p.remarks || ""
    }
  });
}

function saveIntraOralScanning(p) {
  return saveClinicalRecord({
    tabName: "Intra Oral Scan",
    fields: {
      "UHID No.": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Tooth No. / Site": p.toothSite || "",
      "For Procedure": p.forProcedure || "",
      "Name of Operator": p.operator || "",
      "Remarks": p.remarks || "",
      "Scanner Used": p.scannerUsed || "",
      "Scan Type": p.scanType || "",
      "Number of Images": p.numberImages || "",
      "Scan Quality": p.scanQuality || "",
      "File Format Exported": p.fileFormat || "",
      "Sent to Lab": p.sentToLab || ""
    }
  });
}

function savePrescription(p) {
  return saveClinicalRecord({
    tabName: "Prescriptions",
    fields: {
      "UHID": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Procedure Done": p.procedure || "",
      "Teeth": p.teeth || "",
      "Notes": p.notes || "",
      "Medicines": p.medicines || "",
      "Prescribing Doctor": p.doctor || ""
    }
  });
}

function saveScaling(p) {
  return saveClinicalRecord({
    tabName: "Scaling",
    fields: {
      "UHID No.": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Polishing Done": p.polishingDone || "",
      "Name of Operator": p.operator || "",
      "Remarks": p.remarks || "",
      "Grade of Calculus": p.calculusGrade || "",
      "Bleeding on Probing": p.bleedingOnProbing || "",
      "Oral Hygiene Before": p.hygieneBefore || "",
      "Type of Scaling": p.scalingType || "",
      "Instrument Used": p.instrumentUsed || "",
      "Oral Hygiene After": p.hygieneAfter || "",
      "Patient Education Given": p.patientEducation || "",
      "Next Recall Interval": p.recallInterval || ""
    }
  });
}

function saveMinorSurgery(p) {
  return saveClinicalRecord({
    tabName: "Minor Surgery",
    fields: {
      "UHID": p.uhid || "",
      "Name": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Tooth No. / Site": p.toothSite || "",
      "Local Anesthesia": p.laType || "",
      "Quantity": p.quantity || "",
      "Procedure Done": p.procedure || "",
      "Suture Placed": p.suture || "",
      "Operating Doctor": p.doctor || "",
      "Bone Graft/Membrane Used (if Any)": p.boneGraft || "",
      "Any Alert": p.alert || "",
      "Remarks": p.remarks || "",
      "Type of Surgery": p.surgeryType || "",
      "Incision Type": p.incisionType || "",
      "Hemostasis Achieved": p.hemostasisAchieved || "",
      "Suture Material": p.sutureMaterial || "",
      "Post-op Medication Prescribed": p.postopMedication || "",
      "Post-op Instructions Given": p.postopInstructions || "",
      "Follow-up Date": p.followupDate || ""
    }
  });
}

function saveTMJoint(p) {
  return saveClinicalRecord({
    tabName: "TMJoint",
    fields: {
      "UHID No.": p.uhid || "",
      "Name the Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Occupation": p.occupation || "",
      "Investigation Available": p.investigations || "",
      "Procedures Done": p.procedures || "",
      "Relief Treatment Given (if any)": p.reliefTreatment || "",
      "Name of the Operator": p.operator || "",
      "Remarks": p.remarks || "",
      "Chief Complaint": p.chiefComplaint || "",
      "Pain Side": p.painSide || "",
      "Pain Scale": p.painScale || "",
      "Joint Sounds": p.jointSounds || "",
      "Mouth Opening (mm)": p.mouthOpening || "",
      "Deviation on Opening": p.deviation || "",
      "Muscle Tenderness": p.muscleTenderness || "",
      "Parafunctional Habits": p.parafunctionalHabits || "",
      "Occlusal Analysis": p.occlusalAnalysis || "",
      "Diagnosis": p.diagnosis || "",
      "Treatment Given": p.treatmentGiven || "",
      "Splint Type": p.splintType || "",
      "Follow-up Plan": p.followupPlan || ""
    }
  });
}

function saveRestoration(p) {
  return saveClinicalRecord({
    tabName: "Restoration",
    fields: {
      "UHID No.": p.uhid || "",
      "Name of patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Tooth No. / Site": p.toothSite || "",
      "Type of Restoration": p.restoType || "",
      "Investigation Used": p.investigation || "",
      "Material Used": p.material || "",
      "Name of Operator": p.operator || "",
      "Remarks": p.remarks || "",
      "Cavity Class": p.cavityClass || "",
      "Cavity Surface": p.cavitySurface || "",
      "Bonding System": p.bondingSystem || "",
      "Composite Brand": p.compositeBrand || "",
      "Shade": p.shade || "",
      "Composite Layer": p.compositeLayer || "",
      "Composite Type": p.compositeType || "",
      "Occlusion Check": p.occlusionCheck || "",
      "Finishing & Polishing": p.finishingPolishing || "",
      "Clinical Notes": p.clinicalNotes || ""
    }
  });
}

function saveOrthodontics(p) {
  return saveClinicalRecord({
    tabName: "Orthodontics",
    fields: {
      "UHID No.": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Treatment Required": p.treatment || "",
      "Investigations": p.investigations || "",
      "Name of Operator": p.operator || "",
      "Tratment Starting Date": p.startDate || "",
      "Treatment Ending Date": p.endDate || "",
      "Remarks": p.remarks || "",
      "Malocclusion Type": p.malocclusionType || "",
      "Skeletal Pattern": p.skeletalPattern || "",
      "Extraction Required": p.extractionRequired || "",
      "Extraction Teeth": p.extractionTeeth || "",
      "Appliance Type": p.applianceType || "",
      "Arch": p.arch || "",
      "Anchorage (TADs)": p.anchorage || "",
      "Retainer Type": p.retainerType || ""
    }
  });
}

// Recurring monthly adjustment visit — separate tab so Ortho/Aligner cases (which run 1-2 years)
// don't require re-entering the full case-setup form at every visit.
function saveOrthodonticsProgress(p) {
  return saveClinicalRecord({
    tabName: "Orthodontics Progress",
    fields: {
      "UHID": p.uhid || "",
      "Name of Patient": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Visit Date": p.visitDate || "",
      "Current Archwire": p.archwire || "",
      "Archwire Changed This Visit": p.archwireChanged || "",
      "Elastics Used": p.elastics || "",
      "Aligner Number / Stage": p.alignerStage || "",
      "Treatment Phase": p.treatmentPhase || "",
      "Oral Hygiene Status": p.oralHygiene || "",
      "Bracket / Bond Issues": p.bracketIssues || "",
      "Pain / Discomfort": p.painDiscomfort || "",
      "Patient Compliance": p.patientCompliance || "",
      "Next Appointment Date": p.nextAppt || "",
      "Name of Operator": p.operator || "",
      "Notes": p.notes || ""
    }
  });
}

function saveDenture(p) {
  return saveClinicalRecord({
    tabName: "Denture",
    fields: {
      "UHID": p.uhid || "",
      "Name": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Tooth No. / Site": p.toothSite || "",
      "Local Anesthesia": p.laType || "",
      "Quantity": p.quantity || "",
      "Prosthesis required": p.prosthesis || "",
      "Type of Impression": p.impressionType || "",
      "Procedure Done": p.procedure || "",
      "Operating Doctor": p.doctor || "",
      "Final Prosthesis Required": p.finalProsthesis || "",
      "Shade": p.shade || "",
      "Remarks": p.remarks || "",
      "Denture Type": p.dentureType || "",
      "Arch": p.arch || "",
      "Edentulous Status": p.edentulousStatus || "",
      "Primary Impression": p.primaryImpression || "",
      "Jaw Relation Record": p.jawRelation || "",
      "Try-in Done": p.tryIn || "",
      "Occlusal Scheme": p.occlusalScheme || "",
      "Final Impression": p.finalImpression || "",
      "Lab Name": p.labName || "",
      "Sending Date": p.sendDate || "",
      "Receiving Date": p.receiveDate || "",
      "Insertion Date": p.insertDate || "",
      "Denture Material": p.dentureMaterial || "",
      "Mould": p.mould || "",
      "Care Instructions Given": p.careInstructions || "",
      "Follow-up / Review Date": p.followupDate || ""
    }
  });
}

function savePedo(p) {
  return saveClinicalRecord({
    tabName: "Pedo",
    fields: {
      "UHID": p.uhid || "",
      "Name": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Tooth No. / Site": p.toothSite || "",
      "Local Anesthesia": p.laType || "",
      "Quantity": p.quantity || "",
      "Procedure Done": p.procedure || "",
      "Operating Doctor": p.doctor || "",
      "Additional Procedure": p.additionalProcedure || "",
      "Additional Information": p.additionalInfo || "",
      "Post-op Follow up": p.postopFollowup || "",
      "Any Alert": p.alert || "",
      "Remarks": p.remarks || "",
      "Behavior Management Technique": p.behaviorTechnique || "",
      "Frankl Behavior Rating": p.franklRating || "",
      "Parent Present": p.parentPresent || "",
      "Caries Risk": p.cariesRisk || "",
      "Pulp Therapy Type": p.pulpTherapyType || "",
      "Medicament Used": p.medicament || "",
      "Space Maintainer Type": p.spaceMaintainer || "",
      "Fluoride Application": p.fluorideApplication || "",
      "Sealants Placed (Teeth)": p.sealants || "",
      "Habit Counselling Given": p.habitCounselling || "",
      "Next Visit / Recall Date": p.recallDate || ""
    }
  });
}

function saveLabLog(p) {
  return saveClinicalRecord({
    tabName: "Lab Log",
    fields: {
      "UHID No.": p.uhid || "",
      "Patient Name": p.patientName || "",
      "Age": p.age || "",
      "Gender": p.gender || "",
      "Clinical Work Done": p.clinicalWorkDone || "",
      "Type of Work Required": p.workType || "",
      "Items Included": p.items || "",
      "Shade": p.shade || "",
      "Tooth No. / Site": p.toothSite || "",
      "Work Sending Date": p.sendingDate || "",
      "Work Receiving Date": p.receivingDate || "",
      "Work Received": p.workReceived || "",
      "Items (Inclusions) Received": p.itemsReceived || "",
      "Name of Lab": p.labName || "",
      "Case Sent By (name of employee)": p.sentBy || "",
      "Remarks": p.remarks || "",
      "Material Specification": p.materialSpec || "",
      "Workflow": p.workflow || "",
      "Work Order Number": p.workOrderNumber || "",
      "Courier / Delivery Method": p.courierMethod || "",
      "Quality Check on Receipt": p.qualityCheck || "",
      "Rework Required": p.reworkRequired || "",
      "Rework Reason": p.reworkReason || "",
      "Billing Reference": p.billingReference || ""
    }
  });
}
function showNextUHID() {
  Logger.log(getNextUHID().uhid);
}
function checkClocks() {
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var now = new Date();
  Logger.log("Spreadsheet timezone : " + ssTz);
  Logger.log("Script timezone      : " + Session.getScriptTimeZone());
  Logger.log("Time the app stamps  : " + fmtTime(now));
  Logger.log("Time in sheet's zone : " + Utilities.formatDate(now, ssTz, "HH:mm"));
  Logger.log("Correct IST time     : " + Utilities.formatDate(now, "Asia/Kolkata", "HH:mm"));
}
