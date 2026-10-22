// The import matched on the mobile as well as the UHID, which dropped whole
// families: a husband, wife and two children share one number at the desk
// every day, so the first was imported and the rest were silently skipped as
// duplicates. The clinic has 2,500-odd patients and 2,134 arrived.
//
// The UHID is the register's own unique key, so it is the only thing that
// decides whether a patient is already a contact.
const fs = require("fs");
const path = require("path");
const HTML = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
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

// The rule itself, lifted out and run — this is the part that lost patients.
function importer(existing, patients) {
  const have = {}, haveTelNoUhid = {};
  existing.forEach(c => {
    if (c.uhid) { have[String(c.uhid).trim().toUpperCase()] = true; return; }
    if (c.phone) haveTelNoUhid[String(c.phone).replace(/\D/g, "").slice(-10)] = true;
  });
  const added = [];
  patients.forEach(pt => {
    const uh = String(pt.uhid || "").trim();
    if (!uh && !pt.name) return;
    if (uh && have[uh.toUpperCase()]) return;
    const tel = String(pt.mobile == null ? "" : pt.mobile).replace(/\D/g, "").slice(-10);
    if (!uh && tel && haveTelNoUhid[tel]) return;
    if (uh) have[uh.toUpperCase()] = true;
    else if (tel) haveTelNoUhid[tel] = true;
    added.push(pt.uhid || pt.name);
  });
  return added;
}

// A family of four on one number: every one of them is a patient.
const family = [
  { uhid: "KB0001", name: "Asha Verma",   mobile: "9811000001" },
  { uhid: "KB0002", name: "Ravi Verma",   mobile: "9811000001" },
  { uhid: "KB0003", name: "Ishaan Verma", mobile: "9811000001" },
  { uhid: "KB0004", name: "Diya Verma",   mobile: 9811000001 },
  { uhid: "KB0005", name: "Sunil Rao",    mobile: "9811000005" },
];
eq("a family sharing one mobile all arrive",
   importer([], family), ["KB0001", "KB0002", "KB0003", "KB0004", "KB0005"]);

// The old rule, for the record, so the regression is unmistakable.
const old = (() => {
  const have = {}, tel = {}, out = [];
  family.forEach(pt => {
    const uh = String(pt.uhid || "").trim();
    const t = String(pt.mobile == null ? "" : pt.mobile).replace(/\D/g, "").slice(-10);
    if (uh && have[uh.toUpperCase()]) return;
    if (t && tel[t]) return;
    if (uh) have[uh.toUpperCase()] = true;
    if (t) tel[t] = true;
    out.push(pt.uhid);
  });
  return out;
})();
eq("where matching on the mobile kept only two of the five", old.length, 2);

eq("a patient already imported is not added twice",
   importer([{ uhid: "KB0001", phone: "9811000001" }], family),
   ["KB0002", "KB0003", "KB0004", "KB0005"]);
eq("and the match ignores case and spacing on the UHID",
   importer([{ uhid: " kb0001 " }], family).indexOf("KB0001"), -1);
eq("a contact typed in by hand, with no UHID, is still matched on phone",
   importer([{ firstName: "Someone", phone: "98110 00005" }],
            [{ name: "No UHID person", mobile: "9811000005" }]), []);
eq("but that never blocks a patient who has a UHID",
   importer([{ firstName: "Someone", phone: "9811000001" }], family).length, 5);
eq("a row with neither UHID nor name is skipped", importer([], [{ mobile: "9" }]), []);
eq("running it twice adds nobody the second time",
   importer(family.map(p => ({ uhid: p.uhid, phone: String(p.mobile) })), family), []);

// ── and the rule in the page matches the one tested ───────────────────────
ok("the page keys on the UHID alone when there is one",
   /if\(c\.uhid\) \{ have\[String\(c\.uhid\)\.trim\(\)\.toUpperCase\(\)\] = true; return; \}/.test(CRM));
ok("and only falls back to the phone for a contact with no UHID",
   /if\(!uh && tel && haveTelNoUhid\[tel\]\) return;/.test(CRM));
ok("no phone is recorded as taken for a patient who has a UHID",
   /else if\(tel\) haveTelNoUhid\[tel\] = true;/.test(CRM));

// ── the toolbar that was cutting off ──────────────────────────────────────
ok("the contacts count says what it is counting, not 'of 1'", !/' of 1'/.test(CRM));
ok("it shows the total when nothing is filtered out",
   /filtered\.length\+' contacts'/.test(CRM));
ok("and both numbers when it is", /filtered\.length\+' of '\+st\.contacts\.length/.test(CRM));
ok("the toolbar wraps rather than running off the edge",
   /alignItems:'center',flexShrink:0,flexWrap:'wrap'\}\}/.test(CRM));
ok("and the search box can shrink to let it",
   /flex:'1 1 220px',minWidth:160/.test(CRM));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
