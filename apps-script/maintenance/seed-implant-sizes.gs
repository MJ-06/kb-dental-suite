// Puts the clinic's Nobel Biocare implant sizes into Master -> Implant Brands
// & Sizes, from Sheet1 of their IMPLANTS - Nobel Biocare workbook: 103 sizes
// across the five Nobel product lines.
//
// One row per PRODUCT LINE, not one row for "Nobel Biocare". That is how the
// sheet is written and how the choice is actually made at the chair: the line
// first, then the size. A hundred and three sizes under a single brand would
// be one unusable dropdown.
//
// Sizes are kept exactly as the sheet writes them, so what is picked in the
// form matches what is ordered from the shelf. Rename anything with the Edit
// button on that screen.
//
// WHERE: the MAIN PMS book's Apps Script project, as a new script file.
// HOW:   Run reportImplantSizes first (it only reports). Then set CONFIRM to
//        "YES" and run seedImplantSizes. Set it back to "" afterwards.
//
// It adds or replaces these five lines only. Any other brand already in the
// tab is written back untouched — a seed that cleared the tab would take
// Straumann, Alpha Bio and the rest with it.

var CONFIRM = "";
var LINES = [
  ["Nobel Active", "3.0*10mm, 3.0*11.5mm, 3.0*13mm, 3.0*15mm, NP 3.5*8.5mm, NP 3.5*10mm, NP 3.5*11.5mm, NP 3.5*13mm, NP 3.5*15mm, NP 3.5*18mm, RP 4.3*8.5mm, RP 4.3*10mm, RP 4.3*11.5mm, RP 4.3*13mm, RP 4.3*15mm, RP 4.3*18mm, RP 5.0*8.5mm, RP 5.0*10mm, RP 5.0*11.5mm, RP 5.0*13mm, RP 5.0*15mm, RP 5.0*18mm, WP 5.5*7mm, WP 5.5*8.5mm, WP 5.5*10mm, WP 5.5*11.5mm, WP 5.5*13mm, WP 5.5*15mm, NP 3.5*10, NP 3.5*11.5, RP 4.3*10, RP 4.3*11.5, RP 4.3*13"],
  ["Nobel Parallel CC", "NP 3.75*7mm, NP 3.75*8.5mm, NP 3.75*10mm, NP 3.75*11.5mm, NP 3.75*13mm, NP 3.75*15mm, NP 3.75*18mm, RP 4.3*7mm, RP 4.3*8.5mm, RP 4.3*10mm, RP 4.3*11.5mm, RP 4.3*13mm, RP 4.3*15mm, RP 4.3*18mm, RP 5.0*7mm, RP 5.0*8.5mm, RP 5.0*10mm, RP 5.0*11.5mm, RP 5.0*13mm, RP 5.0*15mm, RP 5.0*18mm, WP 5.5*7mm, WP 5.5*8.5mm, WP 5.5*10mm, WP 5.5*11.5mm, WP 5.5*13mm, WP 5.5*15mm"],
  ["Replact Select TC", "NP 3.5*7mm, NP 3.5*10mm, NP 3.5*13mm, NP 3.5*15mm, RP 4.0*7mm, RP 4.0*10mm, RP 4.0*13mm, RP 4.0*15mm"],
  ["Nobel Replace CC", "NP 3.5*8mm, NP 3.5*10mm, NP 3.5*11.5mm, NP 3.5*13mm, NP 3.5*16mm, RP 4.3*8mm, RP 4.3*10mm, RP 4.3*11.5mm, RP 4.3*13mm, RP 4.3*16mm, RP 5.0*8mm, RP 5.0*10mm, RP 5.0*11.5mm, RP 5.0*13mm, RP 5.0*16mm"],
  ["Nobel Replace Select", "NP 3.5*8mm, NP 3.5*10mm, NP 3.5*11.5mm, NP 3.5*13mm, NP 3.5*16mm, RP 4.3*8mm, RP 4.3*10mm, RP 4.3*11.5mm, RP 4.3*13mm, RP 4.3*16mm, WP 5.0*8mm, WP 5.0*10mm, WP 5.0*11.5mm, WP 5.0*13mm, WP 5.0*16mm, 6.0*8mm, 6.0*10mm, 6.0*11.5mm, 6.0*13mm, 6.0*16mm"]
];

function reportImplantSizes() {
  var total = 0;
  LINES.forEach(function (r) {
    var n = r[1].split(", ").length;
    total += n;
    Logger.log("%s \u2014 %s sizes", r[0], n);
  });
  Logger.log("");
  Logger.log("%s lines, %s sizes in all.", LINES.length, total);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Implant Brands");
  if (!sh) { Logger.log(""); Logger.log("The Implant Brands tab does not exist yet. Seeding creates it."); return; }
  var names = {};
  LINES.forEach(function (r) { names[r[0].toUpperCase()] = true; });
  var data = sh.getDataRange().getValues();
  var replacing = [], keeping = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var nm = String(data[i][0]).trim();
    if (names[nm.toUpperCase()]) replacing.push(nm); else keeping.push(nm);
  }
  Logger.log("");
  Logger.log("Rows this will replace: %s", replacing.length ? replacing.join(", ") : "(none \u2014 all five are new)");
  Logger.log("Rows left exactly as they are: %s", keeping.length ? keeping.join(", ") : "(none)");
  Logger.log("");
  Logger.log('Set CONFIRM = "YES" and run seedImplantSizes.');
}

function seedImplantSizes() {
  if (CONFIRM !== "YES") {
    Logger.log('Nothing done. Set CONFIRM = "YES" at the top of this file first.');
    return;
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Implant Brands") || ss.insertSheet("Implant Brands");
  var headers = ["Brand", "Sizes", "Updated At"];

  var names = {};
  LINES.forEach(function (r) { names[r[0].toUpperCase()] = true; });

  var data = sh.getDataRange().getValues();
  var kept = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && !names[String(data[i][0]).trim().toUpperCase()]) {
      kept.push([data[i][0], data[i][1] || "", data[i][2] || ""]);
    }
  }
  var others = kept.length;

  var now = new Date().toISOString();
  LINES.forEach(function (r) { kept.push([r[0], r[1], now]); });

  sh.clearContents();
  var out = [headers].concat(kept);
  sh.getRange(1, 1, out.length, headers.length).setValues(out);

  Logger.log("Done. %s lines written; %s other brand(s) left as they were.", LINES.length, others);
  Logger.log("Check Master -> CLINIC -> Implant Brands & Sizes.");
  Logger.log('Set CONFIRM back to "" so this cannot run again by accident.');
}
