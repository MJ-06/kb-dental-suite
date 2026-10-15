// Puts the implant systems the forms already carried into Master -> Implant
// Brands & Sizes, so the master is the whole list rather than Nobel alone.
//
// These six were built into the Implant Surgery form as a diameter list and a
// length list, and the form multiplied them out at the chair. The master
// stores sizes as written text, so they are multiplied out here instead, in
// the same "3.3 x 6 mm" form the form used -- what is picked now reads the
// same as what was picked before.
//
// The three Nobel entries that were also built in are deliberately NOT here.
// They were a generic diameter-by-length grid; the clinic's own Nobel sheet,
// already seeded, has the real catalogue numbers. Writing the grid over it
// would trade 103 true sizes for 65 invented ones.
//
// These are the manufacturers' published ranges, not what is on the shelf.
// Trim any line to what is actually stocked with the Edit button on that
// screen -- and an unlisted size can still be typed into the form, so no case
// is ever blocked by this list.
//
// WHERE: the MAIN PMS book's Apps Script project, as a new script file.
// HOW:   Run reportBuiltInSystems first (it only reports). Then set CONFIRM
//        to "YES" and run seedBuiltInSystems. Set it back to "" afterwards.

var CONFIRM = "";
var SYSTEMS = [
  ["Straumann", "3.3 × 6 mm, 3.3 × 8 mm, 3.3 × 10 mm, 3.3 × 12 mm, 3.3 × 14 mm, 4.1 × 6 mm, 4.1 × 8 mm, 4.1 × 10 mm, 4.1 × 12 mm, 4.1 × 14 mm, 4.8 × 6 mm, 4.8 × 8 mm, 4.8 × 10 mm, 4.8 × 12 mm, 4.8 × 14 mm"],
  ["Alpha Bio", "3.2 × 8 mm, 3.2 × 10 mm, 3.2 × 11.5 mm, 3.2 × 13 mm, 3.2 × 16 mm, 3.75 × 8 mm, 3.75 × 10 mm, 3.75 × 11.5 mm, 3.75 × 13 mm, 3.75 × 16 mm, 4.2 × 8 mm, 4.2 × 10 mm, 4.2 × 11.5 mm, 4.2 × 13 mm, 4.2 × 16 mm, 5 × 8 mm, 5 × 10 mm, 5 × 11.5 mm, 5 × 13 mm, 5 × 16 mm, 6 × 8 mm, 6 × 10 mm, 6 × 11.5 mm, 6 × 13 mm, 6 × 16 mm"],
  ["Ifix", "3.5 × 8 mm, 3.5 × 10 mm, 3.5 × 11.5 mm, 3.5 × 13 mm, 4 × 8 mm, 4 × 10 mm, 4 × 11.5 mm, 4 × 13 mm, 4.5 × 8 mm, 4.5 × 10 mm, 4.5 × 11.5 mm, 4.5 × 13 mm, 5 × 8 mm, 5 × 10 mm, 5 × 11.5 mm, 5 × 13 mm"],
  ["Osstem", "3.5 × 7 mm, 3.5 × 8.5 mm, 3.5 × 10 mm, 3.5 × 11.5 mm, 3.5 × 13 mm, 4 × 7 mm, 4 × 8.5 mm, 4 × 10 mm, 4 × 11.5 mm, 4 × 13 mm, 4.5 × 7 mm, 4.5 × 8.5 mm, 4.5 × 10 mm, 4.5 × 11.5 mm, 4.5 × 13 mm, 5 × 7 mm, 5 × 8.5 mm, 5 × 10 mm, 5 × 11.5 mm, 5 × 13 mm, 6 × 7 mm, 6 × 8.5 mm, 6 × 10 mm, 6 × 11.5 mm, 6 × 13 mm"],
  ["Norris", "3.3 × 8 mm, 3.3 × 10 mm, 3.3 × 11.5 mm, 3.3 × 13 mm, 3.3 × 16 mm, 3.75 × 8 mm, 3.75 × 10 mm, 3.75 × 11.5 mm, 3.75 × 13 mm, 3.75 × 16 mm, 4.2 × 8 mm, 4.2 × 10 mm, 4.2 × 11.5 mm, 4.2 × 13 mm, 4.2 × 16 mm, 5 × 8 mm, 5 × 10 mm, 5 × 11.5 mm, 5 × 13 mm, 5 × 16 mm, 6 × 8 mm, 6 × 10 mm, 6 × 11.5 mm, 6 × 13 mm, 6 × 16 mm"],
  ["MIS", "3.3 × 8 mm, 3.3 × 10 mm, 3.3 × 11.5 mm, 3.3 × 13 mm, 3.3 × 16 mm, 3.75 × 8 mm, 3.75 × 10 mm, 3.75 × 11.5 mm, 3.75 × 13 mm, 3.75 × 16 mm, 4.2 × 8 mm, 4.2 × 10 mm, 4.2 × 11.5 mm, 4.2 × 13 mm, 4.2 × 16 mm, 5 × 8 mm, 5 × 10 mm, 5 × 11.5 mm, 5 × 13 mm, 5 × 16 mm, 6 × 8 mm, 6 × 10 mm, 6 × 11.5 mm, 6 × 13 mm, 6 × 16 mm"]
];

function reportBuiltInSystems() {
  var total = 0;
  SYSTEMS.forEach(function (r) {
    var n = r[1].split(", ").length;
    total += n;
    Logger.log("%s \u2014 %s sizes", r[0], n);
  });
  Logger.log("");
  Logger.log("%s systems, %s sizes in all.", SYSTEMS.length, total);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Implant Brands");
  if (!sh) { Logger.log(""); Logger.log("The Implant Brands tab does not exist yet. Seeding creates it."); return; }
  var names = {};
  SYSTEMS.forEach(function (r) { names[r[0].toUpperCase()] = true; });
  var data = sh.getDataRange().getValues();
  var replacing = [], keeping = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var nm = String(data[i][0]).trim();
    if (names[nm.toUpperCase()]) replacing.push(nm); else keeping.push(nm);
  }
  Logger.log("");
  Logger.log("Rows this will replace: %s", replacing.length ? replacing.join(", ") : "(none \u2014 all six are new)");
  Logger.log("Rows left exactly as they are: %s", keeping.length ? keeping.join(", ") : "(none)");
  Logger.log("");
  Logger.log('The Nobel lines must appear in that second list. If one appears in the first, stop and say so.');
  Logger.log('Otherwise set CONFIRM = "YES" and run seedBuiltInSystems.');
}

function seedBuiltInSystems() {
  if (CONFIRM !== "YES") {
    Logger.log('Nothing done. Set CONFIRM = "YES" at the top of this file first.');
    return;
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Implant Brands") || ss.insertSheet("Implant Brands");
  var headers = ["Brand", "Sizes", "Updated At"];

  var names = {};
  SYSTEMS.forEach(function (r) { names[r[0].toUpperCase()] = true; });

  var data = sh.getDataRange().getValues();
  var kept = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && !names[String(data[i][0]).trim().toUpperCase()]) {
      kept.push([data[i][0], data[i][1] || "", data[i][2] || ""]);
    }
  }
  var others = kept.length;

  var now = new Date().toISOString();
  SYSTEMS.forEach(function (r) { kept.push([r[0], r[1], now]); });

  sh.clearContents();
  var out = [headers].concat(kept);
  sh.getRange(1, 1, out.length, headers.length).setValues(out);

  Logger.log("Done. %s systems written; %s other brand(s) left as they were.", SYSTEMS.length, others);
  Logger.log("Check Master -> CLINIC -> Implant Brands & Sizes.");
  Logger.log('Set CONFIRM back to "" so this cannot run again by accident.');
}
