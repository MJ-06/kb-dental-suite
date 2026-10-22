// A lead carried no UHID, so a converted enquiry could not be tied to the
// patient it became. Which sources actually produce patients rather than
// phone calls, and what those patients were worth, were both unanswerable.
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

// ── the search goes to the app's own register ─────────────────────────────
ok("the CRM asks the app to search, not a list of its own",
   /function crmFindPatients\(q\)\{[\s\S]{0,180}'KB_CRM_SEARCH'/.test(CRM));
ok("the app answers it from the same patient search every screen uses",
   /d\.type === "KB_CRM_SEARCH"/.test(HTML) && /api\("searchPatients", \{ query/.test(HTML));
ok("a failed search says so rather than looking like no such patient",
   /Could not search the register/.test(CRM));
ok("and the app reports the failure rather than returning an empty list quietly",
   /type: "KB_CRM_PATIENTS", token: d\.token, ok: false,\s*\n\s*patients: \[\]/.test(HTML));

// ── the field on the lead ─────────────────────────────────────────────────
ok("the lead form has a Patient (UHID) field", /ir\('Patient \(UHID\)'/.test(CRM));
ok("it searches by name, mobile or UHID", /Search name, mobile or UHID/.test(CRM));
ok("the search is debounced rather than firing on every keystroke",
   /setTimeout\(function\(\)\{[\s\S]{0,400}crmFindPatients/.test(CRM) && /clearTimeout\(window\.__patT\)/.test(CRM));
ok("picking a patient stores the UHID and the name",
   /fUpd\('uhid'\)\(pt\.uhid\); fUpd\('patientName'\)\(pt\.name\);/.test(CRM));
ok("a linked lead can be unlinked again",
   /fUpd\('uhid'\)\(''\); fUpd\('patientName'\)\(''\);/.test(CRM));
ok("a search that matches nobody says so", /No patient matches that/.test(CRM));

// ── and it is visible where leads are read ────────────────────────────────
ok("the lead's own panel shows which patient it became",
   /\['Patient',lead\.uhid\?\(\(lead\.patientName\|\|''\)\+' — '\+lead\.uhid\):'not linked'\]/.test(CRM));
ok("an unlinked lead says 'not linked' rather than a dash that means nothing",
   /:'not linked'/.test(CRM));

// A column added without its cell shifts every column after it, silently —
// so the header, the cells and the empty-state span are checked together.
const i = CRM.indexOf("['ID','Title','Contact','Patient'");
ok("the leads list has a Patient column", i > 0);
const table = CRM.slice(i, CRM.indexOf("colSpan", i) + 40);
const headers = (table.slice(0, table.indexOf(".map(function(h)")).match(/'[A-Za-z ]+'/g) || []);
const row = table.slice(table.indexOf("pLeads.length?pLeads.map"));
// Cut before the empty-state cell, which is a row of its own and not a column.
const cells = (row.slice(0, row.indexOf("e('td',{colSpan")).match(/e\('td',\{/g) || []).length;
eq("its headers and its cells are the same number", cells, headers.length);
eq("and that is ten", headers.length, 10);
ok("the empty-state row spans them all", /colSpan:10/.test(table));
ok("the cell shows the UHID, with the name on hover",
   /e\('span',\{title:lead\.patientName\|\|'',[\s\S]{0,200}lead\.uhid\)/.test(CRM));

// The link has to survive the trip to the sheet like any other lead field.
ok("uhid is an ordinary field on the lead, so it is stored with the rest",
   !/CRM_COLLECTIONS.*uhid/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
