// The registration ids that more than one row is using.
//
// The register holds 2,535 rows but only 2,492 distinct registration ids, so
// about forty rows share an id with another row. That is why the CRM stopped
// at 2,496: it files a patient under their id, and an id already taken reads
// as somebody already imported.
//
// It matters a great deal more than the CRM. Clinical records, billing,
// appointments and the work-done sheets are ALL keyed on the registration id.
// Two different people sharing one means their histories are mixed: one
// patient's sheet shows the other's treatment, and a claim can be raised
// against the wrong person.
//
// This lists them so they can be put right. It only reads — nothing is
// written, moved or changed.
//
// WHERE: the MAIN PMS book's Apps Script project, as a new script file.
// HOW:   pick reportDuplicateUhids in the function dropdown and press Run.

function reportDuplicateUhids() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Registrations");
  if (!sh) { Logger.log("No Registrations tab in this book."); return; }
  var data = sh.getDataRange().getValues();
  if (data.length <= 1) { Logger.log("The register is empty."); return; }

  var h = data[0];
  function col(/* names */) {
    var names = Array.prototype.slice.call(arguments);
    for (var n = 0; n < names.length; n++) {
      for (var i = 0; i < h.length; i++) {
        var a = String(h[i]).toLowerCase().replace(/[^a-z]/g, "");
        var b = names[n].toLowerCase().replace(/[^a-z]/g, "");
        if (a.indexOf(b) >= 0) return i;
      }
    }
    return -1;
  }
  var iId = col("registrationid", "uhid");
  var iNm = col("fullname", "name");
  var iMo = col("mobileno", "mobile");
  var iTs = col("timestamp", "registeredon");

  var seen = {}, noId = [];
  for (var r = 1; r < data.length; r++) {
    var id = iId >= 0 ? String(data[r][iId] || "").trim() : "";
    var rec = {
      row: r + 1,
      name: iNm >= 0 ? String(data[r][iNm] || "").trim() : "",
      mobile: iMo >= 0 ? String(data[r][iMo] || "").trim() : "",
      on: iTs >= 0 ? data[r][iTs] : ""
    };
    if (!id) { noId.push(rec); continue; }
    var k = id.toUpperCase();
    if (!seen[k]) seen[k] = { id: id, rows: [] };
    seen[k].rows.push(rec);
  }

  var shared = Object.keys(seen).filter(function (k) { return seen[k].rows.length > 1; });
  var samePerson = 0, differentPeople = 0, extraRows = 0;

  Logger.log("REGISTRATION IDS IN USE MORE THAN ONCE");
  Logger.log("");
  shared.forEach(function (k) {
    var g = seen[k];
    extraRows += g.rows.length - 1;
    var names = {};
    g.rows.forEach(function (x) { names[x.name.toLowerCase().replace(/\s+/g, " ")] = true; });
    var distinct = Object.keys(names).length;
    if (distinct > 1) differentPeople++; else samePerson++;
    Logger.log("%s  %s", g.id, distinct > 1 ? "— DIFFERENT NAMES" : "— same name, entered twice");
    g.rows.forEach(function (x) {
      Logger.log("      row %s: %s%s", x.row, x.name || "(no name)", x.mobile ? "  ·  " + x.mobile : "");
    });
  });

  Logger.log("");
  Logger.log("%s id(s) used by more than one row, %s extra row(s) in all.", shared.length, extraRows);
  Logger.log("  %s where the rows carry DIFFERENT names — two people on one id.", differentPeople);
  Logger.log("  %s where the name is the same — the patient was entered twice.", samePerson);
  if (noId.length) {
    Logger.log("");
    Logger.log("%s row(s) carry no registration id at all:", noId.length);
    noId.forEach(function (x) {
      Logger.log("      row %s: %s%s", x.row, x.name || "(no name)", x.mobile ? "  ·  " + x.mobile : "");
    });
  }
  Logger.log("");
  Logger.log("Two people on one id is the one to fix first: their records,");
  Logger.log("bills and work-done sheets are being filed against each other.");
}
