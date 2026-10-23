// The register holds 2,500-odd patients who were entered before the app asked
// whether they are private or on a panel, and the CRM now sorts contacts by
// that word. backfill-patient-type.gs writes it in. It writes into the live
// register, so it is not checked by reading it — it is RUN, against a fake
// Sheets API, and the cells it touched are inspected afterwards.
const fs = require("fs");
const path = require("path");
const GS = fs.readFileSync(path.resolve(__dirname, "../apps-script/maintenance/backfill-patient-type.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

const PANEL_ID = "1yg9Umwwkxao-RUwxXuycjG7CVXjRAQUmMvMHa_l6sjo";

// A spreadsheet just real enough: a grid, A1 header row, and ranges that read
// and write it. setValue on a column past the end grows the row, as Sheets
// does.
function book(id, grid) {
  const g = grid.map(r => r.slice());
  const width = () => g.reduce((n, r) => Math.max(n, r.length), 0);
  const sheet = {
    getDataRange: () => ({ getValues: () => g.map(r => r.slice()) }),
    getLastRow: () => g.length,
    getLastColumn: () => width(),
    getRange(row, col, nRows, nCols) {
      return {
        getValues() {
          const out = [];
          for (let r = row; r < row + (nRows || 1); r++) {
            const line = [];
            for (let c = col; c < col + (nCols || 1); c++) line.push((g[r - 1] || [])[c - 1] || "");
            out.push(line);
          }
          return out;
        },
        setValue(v) { while (g[row - 1].length < col) g[row - 1].push(""); g[row - 1][col - 1] = v; },
        setValues(vals) {
          vals.forEach((line, ri) => {
            const r = row - 1 + ri;
            while (g[r].length < col - 1 + line.length) g[r].push("");
            line.forEach((v, ci) => { g[r][col - 1 + ci] = v; });
          });
        }
      };
    }
  };
  return { id, grid: g, ss: { getId: () => id, getSheetByName: n => (n === "Registrations" ? sheet : null) } };
}

function run(fn, bk, confirm) {
  const log = [];
  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => bk.ss, flush() {} },
    Logger: { log: (...a) => log.push(String(a[0]).replace(/%s/g, () => String(a.splice(1, 1)[0]))) }
  };
  const f = new Function("SpreadsheetApp", "Logger", "WHICH", "SET_CONFIRM",
    GS.replace('var CONFIRM = "";', "var CONFIRM = SET_CONFIRM;") +
    "\nif (WHICH === 'report') reportPatientType(); else backfillPatientType();");
  f(sandbox.SpreadsheetApp, sandbox.Logger, fn, confirm || "");
  return log.join("\n");
}

// Column 7 is Patient Type; the main book's rows have it blank, bar one that
// was registered since the app started asking, and one panel patient that
// somehow got filed in the private book.
const HEAD = ["Timestamp", "Registration ID", "Full Name", "Mobile No.", "Panel", "Card ID", "Patient Type"];
const main = () => book("MAIN_BOOK", [
  HEAD,
  ["2019-04-02", "KB0001", "Asha Verma",   "9811000001", "", "", ""],
  ["2020-07-19", "KB0002", "Rohit Khanna", "9811000002", "", "", ""],
  ["2026-10-20", "KB0003", "Neha Gill",    "9811000003", "", "", "Normal"],
  ["2021-01-05", "KB0004", "S. Raghavan",  "9811000004", "CGHS", "CG-77", ""]
]);

// ---- it only reads until it is told twice ----
let b = main();
let out = run("report", b);
ok("the report changes nothing", b.grid[1][6] === "" && b.grid[2][6] === "");
ok("and says what it would write", /Would be marked "Normal": 2/.test(out), out);
ok("counting the row that is already marked", /Already marked:             1/.test(out), out);

b = main();
out = run("backfill", b, "");
ok("running the backfill without CONFIRM changes nothing", b.grid[1][6] === "");
ok("and says so rather than looking like it worked", /CONFIRM is not set/.test(out), out);

// ---- the main book ----
b = main();
out = run("backfill", b, "YES");
eq("the two unmarked private patients are marked Normal",
   [b.grid[1][6], b.grid[2][6]], ["Normal", "Normal"]);
eq("a row that already said what it was is untouched", b.grid[3][6], "Normal");
eq("a panel patient in the private book is NOT called Normal", b.grid[4][6], "");
ok("and is named so it can be looked at", /KB0004/.test(run("report", main())), out);
eq("nothing else in any row moved",
   b.grid.map(r => r.slice(0, 6)), main().grid.map(r => r.slice(0, 6)));
ok("it reports what it wrote", /Marked 2 row\(s\) "Normal"/.test(out), out);
ok("and writes consecutive rows in one call, not one call each",
   /in 1 write\(s\)/.test(out), out);

// ---- the empanelled book: the same rows mean the opposite ----
const panel = () => book(PANEL_ID, [
  HEAD,
  ["2022-03-11", "KB0900", "Meera Das", "9811000900", "DGEHS", "DG-12", ""],
  ["2023-06-01", "KB0901", "T. Iyer",   "9811000901", "", "", ""]
]);
b = panel();
out = run("backfill", b, "YES");
eq("every row in the empanelled book is a panel patient",
   [b.grid[1][6], b.grid[2][6]], ["Panel", "Panel"]);
ok("and it says which book it decided it was in", /EMPANELLED book/.test(out), out);
ok("the report says it too, before anything is written", /EMPANELLED book/.test(run("report", panel())));

// ---- a register that never had the column ----
b = book("MAIN_BOOK", [
  ["Timestamp", "Registration ID", "Full Name"],
  ["2018-02-02", "KB0007", "Old Patient"]
]);
out = run("backfill", b, "YES");
eq("a Patient Type column is added when the register has none", b.grid[0][3], "Patient Type");
eq("and the row is marked in it", b.grid[1][3], "Normal");
ok("the report warns the column is missing first", /no Patient Type column yet/.test(
  run("report", book("MAIN_BOOK", [["Timestamp", "Registration ID"], ["2018-02-02", "KB0007"]]))));

// ---- nothing to do, and nothing there ----
b = main(); run("backfill", b, "YES");
ok("a second run finds nothing left to do", /Nothing to do/.test(run("backfill", b, "YES")));
ok("an empty register is said to be empty", /register is empty/.test(
  run("report", book("MAIN_BOOK", [HEAD]))));
ok("a book with no register says so instead of failing",
   /No Registrations tab/.test(run("report", { ss: { getId: () => "X", getSheetByName: () => null } })));

// ---- the header match is the app's ----
b = book("MAIN_BOOK", [["Timestamp", "Registration ID", "patienttype"], ["2019-01-01", "KB0010", ""]]);
run("backfill", b, "YES");
eq("a header spelled differently is still the same column", [b.grid[0].length, b.grid[1][2]], [3, "Normal"]);

ok("it tells the user to re-import the CRM contacts afterwards", /Import Patients/.test(
  run("backfill", main(), "YES")));
ok("it is meant for both books", /BOTH books/.test(GS));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
