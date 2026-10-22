// Where the clinic's patients actually live, counted.
//
// The CRM imported 2,496 contacts and the register returned 2,496 patients,
// so the import is complete — but the clinic believes there are more than
// 2,500 people on its books. This says, in one run, how many rows each source
// holds and how many distinct patients they come to between them, so the
// shortfall stops being a matter of opinion.
//
// It only reads. Nothing is written, moved or changed.
//
// WHERE: the MAIN PMS book's Apps Script project, as a new script file.
// HOW:   pick reportPatientSources in the function dropdown and press Run.

function reportPatientSources() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ids = {};          // every distinct registration id seen anywhere
  var noId = 0;

  function count(label, sheet) {
    if (!sheet) { Logger.log("%s — not found", label); return; }
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) { Logger.log("%s — empty", label); return; }
    var h = data[0];
    var i = h.findIndex(function (x) {
      var n = String(x).toLowerCase().replace(/[^a-z]/g, "");
      return n.indexOf("registrationid") >= 0 || n === "uhid" || n.indexOf("uhidno") >= 0;
    });
    var mine = {}, blanks = 0;
    for (var r = 1; r < data.length; r++) {
      var v = i >= 0 ? String(data[r][i] || "").trim().toUpperCase() : "";
      if (!v) { blanks++; continue; }
      mine[v] = true; ids[v] = true;
    }
    noId += blanks;
    Logger.log("%s — %s data row(s), %s distinct id(s)%s",
      label, data.length - 1, Object.keys(mine).length,
      blanks ? ", " + blanks + " with no id" : "");
  }

  Logger.log("WHERE THE PATIENTS ARE");
  Logger.log("");
  count("This book, Registrations", ss.getSheetByName("Registrations"));

  try {
    var panel = SpreadsheetApp.openById("1yg9Umwwkxao-RUwxXuycjG7CVXjRAQUmMvMHa_l6sjo");
    count("Empanelled book, Registrations", panel.getSheetByName("Registrations"));
  } catch (e) { Logger.log("Empanelled book — unreachable: %s", e.message); }

  try {
    var old = SpreadsheetApp.openById("1g_sAiX91CxYNJKYiOrSSgUk3ff26Nlz1qjxRL_YyhUA");
    count("Old registration book (before the move)", old.getSheets()[0]);
  } catch (e) { Logger.log("Old registration book — unreachable: %s", e.message); }

  Logger.log("");
  Logger.log("%s distinct patient(s) across every book.", Object.keys(ids).length);
  if (noId) Logger.log("%s row(s) carry no registration id at all.", noId);
  Logger.log("");
  Logger.log("The CRM holds 2496. If the number above is larger, the extra are");
  Logger.log("in a book the register does not read; if it matches, the register");
  Logger.log("is complete and the clinic's own estimate is the thing to revisit.");
}
