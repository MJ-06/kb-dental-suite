// Two things a receptionist would notice.
//
// "Lead Title" is sales-software language that means nothing at a dental
// desk, and the field is simply what the person rang up about.
//
// And the people a lead could be assigned to came from a list the MANAGEMENT
// SUITE keeps in this browser, not from the clinic's own Doctors master — so
// a doctor added in Master never appeared, and on a machine without that
// other app there were no names at all. That was also the last thing tying
// this screen to an app a customer will not have.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

const m = /const CRM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
const CRM = Buffer.from((m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join(""), "base64").toString("utf8");
// The page explains in its own comments what it no longer says, and those
// comments quote the very wording being checked for. What the code DOES is
// read from the code.
const CODE = CRM
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

// ── the wording ───────────────────────────────────────────────────────────
ok("the lead's first field says what it is for",
   /ir\('Enquiry \\u2014 what they want',/.test(CRM));
ok("with an example from the chair", /e\.g\. Implant for lower back tooth/.test(CRM));
ok("the required marker is not doubled", !/what they want\*'/.test(CRM));
ok("nothing still calls it a Lead Title", !/Lead Title/.test(CODE));
ok("and the warning when it is empty says what to do",
   /Say what the enquiry is about/.test(CRM));
ok("the field is still stored as title, so saved leads are untouched",
   /inp\(f\.title,fUpd\('title'\)/.test(CRM));

// ── where the people come from ────────────────────────────────────────────
ok("the CRM asks the app for its staff", /function crmStaff\(\)/.test(CRM) && /'KB_CRM_STAFF'/.test(CRM));
ok("and uses that list when it has one",
   /if\(st\.staffList && st\.staffList\.length\) return st\.staffList;/.test(CRM));
ok("falling back only until the app answers, so the dropdown is never empty",
   /kbdc_shared_staff/.test(CRM));
ok("it is fetched when the screen opens", /crmStaff\(\)\.then\(function\(r\)\{/.test(CRM));

// The app's side: the clinic's own masters, not another app's storage.
const mod = HTML.slice(HTML.indexOf('d.type === "KB_CRM_STAFF"'),
                       HTML.indexOf('if (d.type === "KB_CRM_SAVE")'));
ok("the app answers from Doctors and Employees",
   /apiBatch\(\["getDoctorDetailsList", "getEmployeesList"\]\)/.test(mod));
ok("a doctor carries their role", /role: x\.role \|\| "Doctor"/.test(mod));
ok("and is marked as a doctor rather than lumped in with everybody",
   /kind: "doctor"/.test(mod) && /kind: "staff"/.test(mod));
ok("somebody in both masters appears once", /if \(seen\[k\]\) return;/.test(mod));
ok("a nameless row is left out", /return x\.name;/.test(mod));
ok("a failed read sends an empty list rather than hanging the form",
   /ok: false,\s*\n\s*staff: \[\]/.test(mod));

// ── the dedupe rule, run ──────────────────────────────────────────────────
const dedupe = (docs, emps) => {
  const people = docs.map(x => ({ name: String(x.name || "").trim(), role: x.role || "Doctor", kind: "doctor" }))
    .concat(emps.map(x => ({ name: String(x.name || "").trim(), role: x.role || "", kind: "staff" })))
    .filter(x => x.name);
  const seen = {}, list = [];
  people.forEach(x => { const k = x.name.toLowerCase(); if (seen[k]) return; seen[k] = true; list.push(x); });
  return list;
};
eq("doctors come first, then staff",
   dedupe([{ name: "Dr. Mittal" }], [{ name: "Anita", role: "Assistant" }]).map(x => x.name),
   ["Dr. Mittal", "Anita"]);
eq("a person in both lists appears once, as the doctor",
   dedupe([{ name: "Dr. Mehta", role: "Oral Surgeon" }], [{ name: "dr. mehta", role: "Partner" }]),
   [{ name: "Dr. Mehta", role: "Oral Surgeon", kind: "doctor" }]);
eq("a blank name is dropped", dedupe([{ name: "  " }], [{}]), []);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
