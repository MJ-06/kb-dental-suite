// Marks the patients who were registered before the app asked whether they
// are private or on a panel, so the distinction is true for everybody and not
// only for whoever registers from today.
//
// Nothing is guessed. The two books already hold the answer: a panel
// registration is written to the EMPANELLED book and a private one to the
// MAIN book, so the book a row sits in IS its patient type. Run this in the
// main book and its rows are marked Normal; run it in the empanelled book and
// its rows are marked Panel. Nothing is copied between the two.
//
// Rows it will not touch:
//   - a row that already carries a Patient Type (whatever it says)
//   - a row in the main book that carries a Panel, Panel Category or Card ID
//     anyway — that is a panel patient filed in the main book, and marking it
//     Normal would be a lie. It is reported so it can be looked at.
// Only blank cells are ever written. Nothing else in the row is read back or
// rewritten, so a run cannot disturb a name, a mobile number or a date.
//
// WHERE: BOTH books' Apps Script projects, as a new script file.
// HOW:   Run reportPatientType first — it only reads, and prints exactly what
//        would be written. Then set CONFIRM to "YES" and run
//        backfillPatientType. Set CONFIRM back to "" afterwards.

var CONFIRM = "";
var PANEL_BOOK_ID = "1yg9Umwwkxao-RUwxXuycjG7CVXjRAQUmMvMHa_l6sjo";

// Header matching the same way the app does it, so "Patient Type",
// "PatientType" and "Patient  type" are all the one column.
function ptCol_(headers, names) {
  for (var n = 0; n < names.length; n++) {
    var want = String(names[n]).toLowerCase().replace(/[^a-z]/g, "");
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]).toLowerCase().replace(/[^a-z]/g, "") === want) return i;
    }
  }
  return -1;
}

// Everything both functions need to agree on, worked out once.
function ptPlan_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Registrations");
  if (!sh) return { error: "No Registrations tab in this book." };

  var isPanelBook = ss.getId() === PANEL_BOOK_ID;
  var mark = isPanelBook ? "Panel" : "Normal";
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) return { error: "The register is empty — nothing to mark." };

  var h = data[0];
  var iType = ptCol_(h, ["Patient Type"]);
  var iPanel = ptCol_(h, ["Panel"]);
  var iCat = ptCol_(h, ["Panel Category"]);
  var iCard = ptCol_(h, ["Card ID"]);
  var iId = ptCol_(h, ["Registration ID", "UHID"]);
  var iName = ptCol_(h, ["Full Name", "Name"]);

  var plan = {
    sheet: sh, book: isPanelBook ? "EMPANELLED" : "MAIN", mark: mark,
    rows: data.length - 1, typeCol: iType, needsColumn: iType < 0,
    toWrite: [], already: 0, skipped: []
  };

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var had = iType >= 0 ? String(row[iType] || "").trim() : "";
    if (had) { plan.already++; continue; }

    // Panel evidence in the main book — leave it and say so.
    if (!isPanelBook) {
      var ev = [];
      if (iPanel >= 0 && String(row[iPanel] || "").trim()) ev.push("Panel " + String(row[iPanel]).trim());
      if (iCat >= 0 && String(row[iCat] || "").trim()) ev.push("Category " + String(row[iCat]).trim());
      if (iCard >= 0 && String(row[iCard] || "").trim()) ev.push("Card " + String(row[iCard]).trim());
      if (ev.length) {
        plan.skipped.push({
          row: r + 1,
          id: iId >= 0 ? String(row[iId] || "").trim() : "",
          name: iName >= 0 ? String(row[iName] || "").trim() : "",
          why: ev.join(", ")
        });
        continue;
      }
    }
    plan.toWrite.push(r + 1);
  }
  return plan;
}

function reportPatientType() {
  var p = ptPlan_();
  if (p.error) { Logger.log(p.error); return; }

  Logger.log("This is the %s book — its rows are %s patients.", p.book, p.mark);
  Logger.log("");
  Logger.log("Registration rows:          %s", p.rows);
  Logger.log("Already marked:             %s", p.already);
  Logger.log("Would be marked \"%s\": %s", p.mark, p.toWrite.length);
  Logger.log("Left alone (panel fields):  %s", p.skipped.length);
  if (p.needsColumn) {
    Logger.log("");
    Logger.log("There is no Patient Type column yet — it would be added at the end.");
  }
  if (p.skipped.length) {
    Logger.log("");
    Logger.log("These main-book rows carry panel details, so they are NOT marked");
    Logger.log("Normal. Each is a panel patient filed in the private book — worth a");
    Logger.log("look, and the app will put the right word on them when they are next");
    Logger.log("registered:");
    p.skipped.forEach(function (s) {
      Logger.log("  row %s  %s  %s  (%s)", s.row, s.id || "—", s.name || "—", s.why);
    });
  }
  Logger.log("");
  if (!p.toWrite.length) {
    Logger.log("Nothing to do — every row already says what it is.");
    return;
  }
  Logger.log("Nothing has been changed. To write those %s cells: set", p.toWrite.length);
  Logger.log('CONFIRM = "YES" at the top of this file and run backfillPatientType.');
}

function backfillPatientType() {
  var p = ptPlan_();
  if (p.error) { Logger.log(p.error); return; }

  if (String(CONFIRM).trim().toUpperCase() !== "YES") {
    Logger.log("Nothing was changed — CONFIRM is not set.");
    Logger.log("");
    Logger.log('Run reportPatientType first, then set CONFIRM = "YES" and run again.');
    return;
  }
  if (!p.toWrite.length) {
    Logger.log("Nothing to do — every row already says what it is.");
    return;
  }

  var sh = p.sheet;
  var col = p.typeCol;
  if (col < 0) {
    col = sh.getLastColumn();          // 0-based index of the next free column
    sh.getRange(1, col + 1).setValue("Patient Type");
    Logger.log("Added a Patient Type column at the end of the register.");
  }

  // Two and a half thousand single-cell writes would take minutes and could
  // run out of the six Apps Script allows. The rows to mark are nearly all
  // consecutive, so they are written in runs: one call per stretch, and no
  // cell outside a run is touched. Writing the whole column in one go would
  // be faster still, but it would rewrite rows this is meant to leave alone
  // — and flatten any formula sitting in one of them.
  var wrote = 0, runs = 0, i = 0;
  while (i < p.toWrite.length) {
    var j = i;
    while (j + 1 < p.toWrite.length && p.toWrite[j + 1] === p.toWrite[j] + 1) j++;
    var n = j - i + 1, block = [];
    for (var k = 0; k < n; k++) block.push([p.mark]);
    sh.getRange(p.toWrite[i], col + 1, n, 1).setValues(block);
    wrote += n; runs++;
    i = j + 1;
  }
  SpreadsheetApp.flush();

  Logger.log("Marked %s row(s) \"%s\" in the %s book, in %s write(s).", wrote, p.mark, p.book, runs);
  if (p.already) Logger.log("%s row(s) already said what they were and were left as they were.", p.already);
  if (p.skipped.length) Logger.log("%s row(s) carried panel details and were left blank — see reportPatientType.", p.skipped.length);
  Logger.log("");
  Logger.log("Then:");
  Logger.log('  - Set CONFIRM back to "" so this cannot run again by accident');
  Logger.log("  - Run the same two functions in the other book");
  Logger.log("  - In the CRM, re-run Import Patients so the contacts pick the type up");
}
