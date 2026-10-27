/**
 * Phase 3, step one: get the data out.
 *
 * Paste this into the Apps Script editor of EITHER book (it reads all of
 * them by id), press Run on exportEverything, and it writes one JSON file
 * per tab into a new folder in your Drive called
 * "KB Dental export <date>". Download that folder, and the importer reads it.
 *
 * It only reads. Nothing in any sheet is changed, so running it twice is
 * safe and running it while the clinic is working is safe — the second run
 * simply makes a newer folder.
 *
 * Why an export file rather than reading the sheets from the new server:
 * the move happens once, and a file can be checked, counted and re-imported
 * as many times as it takes to get right. A live read cannot be re-run
 * against the same data once the clinic has carried on working.
 */

// The three books, plus Finance. Ids taken from Code.gs — if any of them has
// been replaced, change it here and nowhere else.
var EXPORT_BOOKS = [
  { key: "pms",        id: "1DtoZ3MNFq2Enr-ClAjENWFzk8SF2dYN9e1nGf7tAJC4", label: "Main (PMS)" },
  { key: "empanelled", id: "1yg9Umwwkxao-RUwxXuycjG7CVXjRAQUmMvMHa_l6sjo", label: "Empanelled" },
  { key: "oldreg",     id: "1g_sAiX91CxYNJKYiOrSSgUk3ff26Nlz1qjxRL_YyhUA", label: "Old registration" },
  { key: "finance",    id: "1Zdxq3Xf-e41Xak4VDcufrURLkKDAp8MvRCZadC0htUI", label: "Finance" }
];

function exportEverything() {
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HHmm");
  var folder = DriveApp.createFolder("KB Dental export " + stamp);
  var manifest = { exportedAt: new Date().toISOString(), books: [] };

  EXPORT_BOOKS.forEach(function (book) {
    var ss;
    try {
      ss = SpreadsheetApp.openById(book.id);
    } catch (e) {
      // A book that cannot be opened is reported, not skipped silently —
      // an export missing a book must be obvious before the import runs.
      manifest.books.push({ key: book.key, label: book.label, error: String(e.message || e) });
      Logger.log("COULD NOT OPEN " + book.label + ": " + e);
      return;
    }

    var tabs = [];
    ss.getSheets().forEach(function (sh) {
      var rows = sh.getDataRange().getDisplayValues();
      // Display values, deliberately. A date cell read as a value comes back
      // as a Date on whatever timezone the script runs in, and a phone
      // number of digits comes back as a number that has lost its leading
      // zero. What the clinic SEES in the cell is what it means.
      var name = sh.getName();
      var file = folder.createFile(
        book.key + "__" + name.replace(/[^A-Za-z0-9 _-]/g, "_") + ".json",
        JSON.stringify({ book: book.key, tab: name, rows: rows }),
        "application/json"
      );
      tabs.push({ tab: name, rows: rows.length, columns: rows.length ? rows[0].length : 0, file: file.getName() });
      Logger.log(book.label + " / " + name + ": " + rows.length + " rows");
    });

    manifest.books.push({ key: book.key, label: book.label, id: book.id, tabs: tabs });
  });

  folder.createFile("manifest.json", JSON.stringify(manifest, null, 2), "application/json");

  Logger.log("");
  Logger.log("Done. Folder: " + folder.getName());
  Logger.log("Folder link: " + folder.getUrl());
  Logger.log("Download it as a zip (right-click the folder in Drive > Download),");
  Logger.log("unzip it, and give the folder to the importer.");
  return folder.getUrl();
}

/**
 * A quick count without exporting anything, so the numbers can be written
 * down BEFORE the move and checked against afterwards.
 */
function countEverything() {
  EXPORT_BOOKS.forEach(function (book) {
    try {
      var ss = SpreadsheetApp.openById(book.id);
      Logger.log("── " + book.label);
      ss.getSheets().forEach(function (sh) {
        Logger.log("   " + sh.getName() + ": " + Math.max(0, sh.getLastRow() - 1) + " rows");
      });
    } catch (e) {
      Logger.log("── " + book.label + ": COULD NOT OPEN (" + e + ")");
    }
  });
}
