// The clinic registers panel patients in the EMPANELLED book and private
// patients in the main one, and the app reads both and merges them. But
// getAllPatients then collapses each patient to their NEWEST row -- right for
// a name or a number, since NABH re-collection is exactly what makes a newer
// row authoritative, but wrong for the panel: a blank there is somebody not
// filling the field in again, not the patient leaving the panel.
//
// So a patient with a row in both books whose main-book row happened to be
// newer arrived at the CRM with no panel, and was filed under no company.
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
// getAllPatients run for real, with only its two readers standing in.
const SRC = slice("function findRegColumn_(") + slice("function regLatestByUhid_(") +
            slice("function getAllPatients(p)");
function allPatients(rows, old) {
  return new Function("regAllRows_", "oldBookPatients_", "formatDOB",
    SRC + "\nreturn getAllPatients;")(
    () => rows, () => old || [], v => v);
}

const H = ["Timestamp", "Registration ID", "Full Name", "Mobile No.",
           "Panel", "Panel Category", "Card ID"];

// ── the case the clinic hit ──────────────────────────────────────────────
// One patient, a row in each book. The empanelled row names CGHS; the
// main-book row is newer and does not.
let res = allPatients([H,
  ["2026-03-01", "KB0100", "Meera Das", "9811000100", "CGHS", "Serving", "CG-7"],
  ["2026-09-01", "KB0100", "Meera Das", "9811000100", "", "", ""]
])({});
eq("the patient appears once, not twice", res.patients.length, 1);
eq("and keeps their panel although the newest row left it blank",
   res.patients[0].panel, "CGHS");
eq("with the category", res.patients[0].panelCategory, "Serving");
eq("and the card number", res.patients[0].cardId, "CG-7");

// Whichever way round the rows come.
res = allPatients([H,
  ["2026-09-01", "KB0101", "A B", "9811000101", "", "", ""],
  ["2026-03-01", "KB0101", "A B", "9811000101", "DGEHS", "", "DG-2"]
])({});
eq("the order the books are merged in does not matter",
   res.patients[0].panel, "DGEHS");

// ── what must NOT change ─────────────────────────────────────────────────
// The newest row still wins for everything else: that is what NABH
// re-collection is for.
res = allPatients([H,
  ["2019-01-01", "KB0102", "Old Name", "9811000001", "CGHS", "", ""],
  ["2026-09-01", "KB0102", "New Name", "9811000999", "", "", ""]
])({});
eq("the newest row still gives the name", res.patients[0].name, "New Name");
eq("and the number", String(res.patients[0].mobile), "9811000999");
eq("while the panel survives from the older row", res.patients[0].panel, "CGHS");

// A panel on the newest row wins over an older, different one -- somebody
// moving panel is a real thing and the recent answer is the right one.
res = allPatients([H,
  ["2019-01-01", "KB0103", "C D", "", "CGHS", "Serving", "CG-1"],
  ["2026-09-01", "KB0103", "C D", "", "DGEHS", "Pensioner", "DG-5"]
])({});
eq("a patient who changed panel shows their current one", res.patients[0].panel, "DGEHS");
eq("with the matching category", res.patients[0].panelCategory, "Pensioner");
eq("and the card that goes with it, not the old panel's", res.patients[0].cardId, "DG-5");

// A private patient is never given a panel.
res = allPatients([H,
  ["2026-01-01", "KB0104", "E F", "9811000104", "", "", ""],
  ["2026-02-01", "KB0105", "G H", "9811000105", "CGHS", "", ""]
])({});
eq("a private patient stays private", res.patients[0].panel, "");
eq("and another patient's panel is not borrowed", res.patients[0].panelCategory, "");
eq("while the panel patient keeps theirs", res.patients[1].panel, "CGHS");

// A register with no Panel column at all must not throw.
res = allPatients([["Timestamp", "Registration ID", "Full Name"],
                   ["2026-01-01", "KB0106", "I J"]])({});
eq("a register without the column simply reports no panel", res.patients[0].panel, "");

// Rows with no id are still returned -- they are patients too.
res = allPatients([H, ["2026-01-01", "", "No Id", "9811000107", "CGHS", "", ""]])({});
eq("a row with no registration id still comes back", res.patients.length, 1);
eq("carrying the panel on its own row", res.patients[0].panel, "CGHS");

// ── both books are read in the first place ───────────────────────────────
const rs = slice("function regSheets_(");
ok("the app opens the empanelled book as well as this one",
   /SpreadsheetApp\.openById\(PANEL_PMS_SHEET_ID\)\.getSheetByName\("Registrations"\)/.test(rs), rs);
ok("unless it IS the empanelled book, when there is only one to read",
   /if \(SS_ID === PANEL_PMS_SHEET_ID\)/.test(rs));
ok("and a book it cannot open is reported, not silently skipped",
   /Panel book unreachable/.test(rs));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
