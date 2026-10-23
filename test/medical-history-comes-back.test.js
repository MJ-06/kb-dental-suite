// The patient fills their medical history on the iPad, and the desk still had
// to tick every condition and type the medicines again. Two faults, both in
// how the register was READ back:
//
//   1. getPatient looked up headers EXACTLY (obj["Conditions"]). The register's
//      own headings are whole questions -- "Have you ever suffered/suffering
//      from any of the following?" -- so the lookup found nothing.
//   2. The fallback written for exactly that case could never run:
//      safeParseJSON(get("Conditions") || "[]") returns [], and an empty array
//      is TRUTHY, so `[] || fallback` short-circuits to []. Dead code.
//
// Together: every patient came back with no medical history, however it was
// entered. The two halves of the clinic also write it differently -- the desk
// saves a JSON array, the iPad form sends plain "A, B, C" -- so both are read.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const GS = fs.readFileSync(path.join(REPO, "apps-script/out/Code.gs"), "utf8");
const REG = fs.readFileSync(path.join(REPO, "register.html"), "utf8");
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
const regList_ = new Function(slice("function regList_(") + "\nreturn regList_;")();
const findRegColumn_ = new Function(slice("function findRegColumn_(") + "\nreturn findRegColumn_;")();

// getPatient's own reader, lifted out and run against a register row.
const GETSRC = (() => {
  const a = GS.indexOf("      function get() {");
  return GS.slice(a, GS.indexOf("\n      }", a) + 8);
})();
function reader(headers, row) {
  return new Function("headers", "data", "i", "findRegColumn_",
    GETSRC + "\nreturn get;")(headers, [headers, row], 1, findRegColumn_);
}

// ── the bug that made the fallback dead ───────────────────────────────────
ok("an empty array really is truthy, which is what broke it", !![] === true);

// ── the list reader ──────────────────────────────────────────────────────
eq("the desk's JSON array is read", regList_('["Diabetes","Thyroid"]'), ["Diabetes", "Thyroid"]);
eq("the iPad's plain text is read too", regList_("Diabetes, Thyroid"), ["Diabetes", "Thyroid"]);
eq("spacing in the text does not matter", regList_("Diabetes ,Thyroid,  Asthma"),
   ["Diabetes", "Thyroid", "Asthma"]);
eq("a single condition is still a list", regList_("Diabetes"), ["Diabetes"]);
eq("nothing recorded is an empty list, not a crash", regList_(""), []);
eq("and so is a blank cell", regList_(null), []);
eq("an array that arrives as an array is left alone", regList_(["A"]), ["A"]);
eq("text that merely starts with a bracket is not silently dropped",
   regList_("[not json after all"), ["[not json after all"]);
eq("empty entries are not kept", regList_("Diabetes, , Thyroid,"), ["Diabetes", "Thyroid"]);

// ── reading a real register row ──────────────────────────────────────────
// The headings as the clinic's register actually spells them.
const HEAD = ["Timestamp", "Registration ID", "Full Name", "Mobile No.",
              "Have you ever suffered/suffering from any of the following?",
              "Medicines you are taking currently:",
              "Are you allergic to any of the following?"];

// A patient who filled the form on the iPad.
let get = reader(HEAD, ["2026-10-23", "KB9001", "Asha Verma", "9811000001",
                        "Diabetes, Thyroid", "Metformin 500mg", "Penicillin, Latex"]);
eq("the conditions the patient ticked come back",
   regList_(get("Conditions", "Have you ever suffered/suffering from any of the following?")),
   ["Diabetes", "Thyroid"]);
eq("the medicines they typed come back",
   get("Medicines", "Medicines you are taking currently:"), "Metformin 500mg");
eq("and their allergies",
   regList_(get("Allergies", "Are you allergic to any of the following?")),
   ["Penicillin", "Latex"]);

// A patient entered at the desk, where the same fields are stored as JSON.
get = reader(HEAD, ["2026-10-23", "KB9002", "Rohit Khanna", "9811000002",
                    '["Asthma"]', "Salbutamol", '["Aspirin"]']);
eq("a record saved at the desk reads back the same way",
   regList_(get("Conditions", "Have you ever suffered/suffering from any of the following?")),
   ["Asthma"]);

// A register that uses the short headings instead.
get = reader(["Registration ID", "Conditions", "Medicines", "Allergies"],
             ["KB9003", "Jaundice", "None", "Iodine"]);
eq("a register with short headings works just as well",
   regList_(get("Conditions", "Have you ever suffered/suffering from any of the following?")),
   ["Jaundice"]);
eq("including its medicines", get("Medicines", "Medicines you are taking currently:"), "None");

// Nothing recorded at all.
get = reader(HEAD, ["2026-10-23", "KB9004", "Empty Case", "9811000004", "", "", ""]);
eq("a patient with nothing recorded comes back with nothing, not a crash",
   regList_(get("Conditions", "Have you ever suffered/suffering from any of the following?")), []);
eq("and no medicines", get("Medicines", "Medicines you are taking currently:"), "");

// The first candidate that actually HOLDS something wins, not merely the
// first that matches a column.
get = reader(["Registration ID", "Conditions", "Have you ever suffered/suffering from any of the following?"],
             ["KB9005", "", "Epilepsy"]);
eq("an empty column does not hide a filled one behind it",
   regList_(get("Conditions", "Have you ever suffered/suffering from any of the following?")),
   ["Epilepsy"]);

// ── the two ends agree ───────────────────────────────────────────────────
ok("the iPad form sends its conditions as comma-separated text",
   /conditions: F\.conditions\.join\(", "\)/.test(REG));
ok("and its allergies the same way",
   /allergies: F\.allergies\.concat/.test(REG) && /\.join\(", "\)/.test(REG));
ok("while the desk saves JSON, which is why both had to be read",
   /"Have you ever suffered\/suffering from any of the following\?\|Conditions": safeJSON\(p\.conditions\)/.test(GS));

// ── the dead pattern is gone ─────────────────────────────────────────────
ok("getPatient no longer leans on a fallback that cannot run",
   !/safeParseJSON\(get\("Conditions"\)/.test(GS));
ok("nor for allergies", !/safeParseJSON\(get\("Allergies"\)/.test(GS));
ok("and it no longer reads headers by exact name",
   GS.indexOf('var v = String(obj[tries[t]] || "").trim();') < 0);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
