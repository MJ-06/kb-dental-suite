// The registration ids that more than one row is using.
//
// These are NOT two people on one id. A patient returning after a long gap
// has their details collected again for NABH, and registration writes a new
// row rather than overwriting the old one — so the same person holds several
// rows under one id, and the newest is what is true now. Keeping the old row
// is right: it records what was true then.
//
// The app takes the newest row everywhere now, so nothing is being filed
// against the wrong person and there is nothing here that must be fixed.
// This is for looking: which patients came back, when they were re-collected,
// and whether any pair carries genuinely different names — which WOULD be two
// people on one id, and would want sorting out.
//
// It only reads — nothing is written, moved or changed.
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

  Logger.log("REGISTRATION IDS HELD BY MORE THAN ONE ROW");
  Logger.log("");
  shared.forEach(function (k) {
    var g = seen[k];
    extraRows += g.rows.length - 1;
    var names = {};
    g.rows.forEach(function (x) { names[x.name.toLowerCase().replace(/\s+/g, " ")] = true; });
    var distinct = Object.keys(names).length;
    if (distinct > 1) differentPeople++; else samePerson++;
    Logger.log("%s  %s", g.id, distinct > 1 ? "— DIFFERENT NAMES, worth a look" : "— same patient, re-registered");
    g.rows.forEach(function (x) {
      Logger.log("      row %s: %s%s", x.row, x.name || "(no name)", x.mobile ? "  ·  " + x.mobile : "");
    });
  });

  Logger.log("");
  Logger.log("%s id(s) used by more than one row, %s extra row(s) in all.", shared.length, extraRows);
  Logger.log("  %s where the name is the same — the patient came back and was re-collected.", samePerson);
  Logger.log("  %s where the rows carry DIFFERENT names — worth checking those are the same person.", differentPeople);
  if (noId.length) {
    Logger.log("");
    Logger.log("%s row(s) carry no registration id at all:", noId.length);
    noId.forEach(function (x) {
      Logger.log("      row %s: %s%s", x.row, x.name || "(no name)", x.mobile ? "  ·  " + x.mobile : "");
    });
  }
  Logger.log("");
  Logger.log("The app reads the newest row for each id, so these patients show");
  Logger.log("their current details. Only a pair with different names needs a");
  Logger.log("second look — the rest are ordinary NABH re-registrations.");
}
