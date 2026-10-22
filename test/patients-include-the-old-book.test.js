// The CRM imported every patient the register returned — and the register
// returned 2,496 while the clinic has more than that on its books. Patients
// registered before the move live in a second book, read until now only one
// at a time by getOldPatientData(uhid) and never counted by anything.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const GS = fs.readFileSync(path.join(REPO, "apps-script/out/Code.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

// ── the merge, run for real ───────────────────────────────────────────────
function boot(current, archive, opened) {
  const code =
    GS.slice(GS.indexOf("function oldBookPatients_()"), GS.indexOf("function getAllPatients(p)")) +
    `
    function getAllPatients(p) {
      var patients = CURRENT.slice();
      ` + GS.slice(GS.indexOf("  if (p && (p.includeArchive"), GS.indexOf("  return { success: true, patients: patients };\n}")) + `
      return { success: true, patients: patients };
    }
    return getAllPatients;`;
  return new Function("SpreadsheetApp", "Logger", "OLD_REG_SHEET_ID", "CURRENT", code)(
    { openById: () => {
        if (opened === false) throw new Error("no access");
        return { getSheets: () => [{ getDataRange: () => ({ getValues: () => archive }) }] };
      } },
    { log: () => {} },
    "OLD", current);
}

const HEAD = ["Registration ID", "Full Name", "Gender", "Date of Birth", "Mobile No"];
const current = [{ uhid: "KB0001", name: "Asha" }, { uhid: "KB0002", name: "Ravi" }];
const archive = [HEAD,
  ["KB0002", "Ravi", "M", "", "9811000002"],   // already migrated
  ["OLD001", "Prem Chand", "M", "", "9811000777"],
  ["OLD002", "Shanti Devi", "F", "", ""],
  ["", "", "", "", ""],
];

let api = boot(current, archive);
eq("without asking, only the current register comes back",
   api({}).patients.map(p => p.uhid), ["KB0001", "KB0002"]);
eq("so the dashboard's patient count keeps meaning \"registered here\"",
   api().patients.length, 2);

eq("asking for the archive brings the older patients too",
   api({ includeArchive: "true" }).patients.map(p => p.uhid),
   ["KB0001", "KB0002", "OLD001", "OLD002"]);
eq("a patient who was already migrated is not added twice",
   api({ includeArchive: "true" }).patients.filter(p => p.uhid === "KB0002").length, 1);
eq("a blank row in the old book is left out",
   api({ includeArchive: "true" }).patients.length, 4);
eq("the flag works as a real boolean too",
   api({ includeArchive: true }).patients.length, 4);
ok("an old patient is marked as coming from the archive",
   api({ includeArchive: "true" }).patients.find(p => p.uhid === "OLD001").fromArchive === true);
ok("and carries a name and number the CRM can use",
   api({ includeArchive: "true" }).patients.find(p => p.uhid === "OLD001").name === "Prem Chand");

// An unreachable old book must never break the patient list everything uses.
api = boot(current, archive, false);
eq("an unreachable old book leaves the current register working",
   api({ includeArchive: "true" }).patients.map(p => p.uhid), ["KB0001", "KB0002"]);

// ── who asks for it ───────────────────────────────────────────────────────
ok("the CRM import asks for the archive",
   /api\("getAllPatients", \{ includeArchive: "true" \}\)/.test(HTML));
const dash = HTML.slice(HTML.indexOf("const [birthdaysLoading"), HTML.indexOf("const [birthdaysLoading") + 900);
ok("the dashboard count does not", /api\("getAllPatients"\)\.then/.test(dash));
ok("the action passes its parameters through", /case "getAllPatients":     return getAllPatients\(p\);/.test(GS));

// ── and a way to see where everybody is ───────────────────────────────────
const RPT = fs.readFileSync(path.join(REPO, "apps-script/maintenance/report-patient-sources.gs"), "utf8");
ok("there is a report that counts each book", /function reportPatientSources\(\)/.test(RPT));
ok("it covers this book, the panel book and the old one",
   /This book, Registrations/.test(RPT) && /Empanelled book/.test(RPT) && /Old registration book/.test(RPT));
ok("it counts distinct patients across all of them", /distinct patient\(s\) across every book/.test(RPT));
ok("and it only reads", !/setValue|appendRow|clearContents|deleteRow/.test(RPT));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
