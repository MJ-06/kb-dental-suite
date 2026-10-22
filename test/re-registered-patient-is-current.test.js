// A patient returning after a long gap has their details collected again for
// NABH, and registration keeps the old row rather than overwriting it. That
// is right — the old row records what was true then — but it means one
// patient can hold several rows under one registration id.
//
// Everything that answers "who is this patient" took the FIRST row, so the
// app showed exactly the details the re-registration was performed to
// replace: the old address, the old number, the old history. And anything
// that listed rows counted that patient twice.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const GS = fs.readFileSync(path.join(REPO, "apps-script/out/Code.gs"), "utf8");
const HTML = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

// ── the rule itself, run for real ─────────────────────────────────────────
const latest = new Function("findRegColumn_",
  GS.slice(GS.indexOf("function regLatestByUhid_("), GS.indexOf("function regAllRows_()")) +
  "\nreturn regLatestByUhid_;")(
  (headers, names) => headers.findIndex(h =>
    names.some(n => String(h).toLowerCase().replace(/[^a-z]/g, "")
      .indexOf(n.toLowerCase().replace(/[^a-z]/g, "")) >= 0)));

const H = ["UHID", "Full Name", "Mobile No.", "Timestamp"];
let rows = [H,
  ["KB0001", "Asha Verma", "9811000001", "2021-03-04T10:00:00Z"],   // first visit
  ["KB0001", "Asha Verma", "9898989898", "2026-09-01T10:00:00Z"],   // back after years
  ["KB0002", "Ravi Kumar", "9811000002", "2024-01-01T10:00:00Z"],
];
let best = latest(rows, 0);
eq("the newest row wins for a re-registered patient", best["KB0001"].row, 2);
eq("a patient with one row is unaffected", best["KB0002"].row, 3);

// The rows are not always in date order in the sheet.
rows = [H,
  ["KB0001", "Asha", "1", "2026-09-01T10:00:00Z"],
  ["KB0001", "Asha", "2", "2021-03-04T10:00:00Z"],
];
eq("the later DATE wins, not the later row", latest(rows, 0)["KB0001"].row, 1);

// Older rows can predate the timestamp column being filled in.
rows = [H, ["KB0001", "Asha", "1", ""], ["KB0001", "Asha", "2", "2026-09-01T10:00:00Z"]];
eq("a dated row beats an undated one", latest(rows, 0)["KB0001"].row, 2);
rows = [H, ["KB0001", "Asha", "1", "2026-09-01T10:00:00Z"], ["KB0001", "Asha", "2", ""]];
eq("even when the undated one comes after it", latest(rows, 0)["KB0001"].row, 1);
rows = [H, ["KB0001", "Asha", "1", ""], ["KB0001", "Asha", "2", ""]];
eq("with no dates at all the later row wins, since registration appends",
   latest(rows, 0)["KB0001"].row, 2);
eq("a row with no id is ignored rather than keyed on nothing",
   Object.keys(latest([H, ["", "Nobody", "", ""]], 0)), []);

// ── and it is actually used ───────────────────────────────────────────────
const fnOf = n => GS.slice(GS.indexOf("function " + n + "("), GS.indexOf("\n}", GS.indexOf("function " + n + "(")));
ok("looking a patient up takes their newest row",
   /var latest = regLatestByUhid_\(data, uhidColIdx\);/.test(fnOf("getPatient")) &&
   /for \(var i = hit \? hit\.row : 1;/.test(fnOf("getPatient")));
ok("search shows one line per patient, from the newest row",
   /var newest = iUhid >= 0 \? regLatestByUhid_\(data, iUhid\) : \{\};/.test(fnOf("searchPatients")) &&
   /if \(rowId && newest\[rowId\] && newest\[rowId\]\.row !== i\) continue;/.test(fnOf("searchPatients")));
ok("and the patient list counts patients, not rows",
   /if \(rowId && newest\[rowId\] && newest\[rowId\]\.row !== idx \+ 1\) return;/.test(fnOf("getAllPatients")));

// ── the CRM follows from that ─────────────────────────────────────────────
const m = /const CRM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
const CRM = Buffer.from((m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join(""), "base64").toString("utf8");
ok("one registration id is one contact again",
   /if\(c\.uhid\) \{ have\[String\(c\.uhid\)\.trim\(\)\.toUpperCase\(\)\] = true; return; \}/.test(CRM));
ok("the id-and-name key is gone, with its talk of two people on one id",
   !/idKey\(/.test(CRM) && !/sharing a UHID with a different patient/.test(CRM));
// The phone rule must NOT come back with it: families really do share a number.
ok("a row with no id is still keyed on name AND number, not the number alone",
   /var sk = softKey\(pt\.name, tel\);/.test(CRM));
ok("and the import still shows its arithmetic", /Register holds ' \+ nTotal/.test(CRM));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
