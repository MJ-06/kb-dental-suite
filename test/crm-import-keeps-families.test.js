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
  const have = {}, haveSoft = {};
  const norm = v => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  const idKey = (uhid, name) => String(uhid).trim().toUpperCase() + "|" + norm(name);
  const softKey = (name, tel) => norm(name) + "|" + (tel || "");
  existing.forEach(c => {
    const nm = ((c.firstName || "") + " " + (c.lastName || "")).trim();
    if (c.uhid) { have[idKey(c.uhid, nm)] = true; return; }
    haveSoft[softKey(nm, String(c.phone || "").replace(/\D/g, "").slice(-10))] = true;
  });
  const added = [], skipped = { blank: 0, already: 0, softDup: 0, sharedId: 0 };
  const idsSeen = {};
  patients.forEach(pt => {
    const uh = String(pt.uhid || "").trim();
    const tel = String(pt.mobile == null ? "" : pt.mobile).replace(/\D/g, "").slice(-10);
    if (!uh && !String(pt.name || "").trim()) { skipped.blank++; return; }
    if (uh) {
      const ik = idKey(uh, pt.name);
      if (have[ik]) { skipped.already++; return; }
      have[ik] = true;
      const bare = uh.toUpperCase();
      if (idsSeen[bare]) skipped.sharedId++; else idsSeen[bare] = true;
    } else {
      const sk = softKey(pt.name, tel);
      if (haveSoft[sk]) { skipped.softDup++; return; }
      haveSoft[sk] = true;
    }
    added.push(pt.uhid || pt.name);
  });
  added.skipped = skipped;
  return added;
}

// Two different people were given one registration id at the desk — about
// forty rows of the real register are like this. On the id alone the second
// of them read as already imported and never became a contact.
const shared = [
  { uhid: "KB0001", name: "Asha Verma", mobile: "9811000001" },
  { uhid: "KB0001", name: "Prem Chand", mobile: "9811000777" },
  { uhid: "KB0002", name: "Ravi Verma", mobile: "9811000002" },
  { uhid: "KB0002", name: "ravi  verma", mobile: "9811000002" },
];
eq("two different people on one id are two contacts",
   importer([], shared), ["KB0001", "KB0001", "KB0002"]);
eq("and the same person entered twice is still one",
   importer([], shared).length, 3);
eq("the shared id is counted, not hidden",
   importer([], shared).skipped.sharedId, 1);
eq("re-running adds neither of them again", importer(
   [{ uhid: "KB0001", firstName: "Asha", lastName: "Verma" },
    { uhid: "KB0001", firstName: "Prem", lastName: "Chand" },
    { uhid: "KB0002", firstName: "Ravi", lastName: "Verma" }], shared), []);

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
   importer([{ uhid: "KB0001", firstName: "Asha", lastName: "Verma", phone: "9811000001" }], family),
   ["KB0002", "KB0003", "KB0004", "KB0005"]);
eq("and the match ignores case and spacing on the UHID and the name",
   importer([{ uhid: " kb0001 ", firstName: "asha", lastName: "  verma" }], family).indexOf("KB0001"), -1);
// Two DIFFERENT people with no UHID on one number are two people: a shared
// number must never cost a name, or the follow-up goes to the wrong person.
eq("two different walk-ins on one number both arrive",
   importer([], [{ name: "Walk In One", mobile: "9811000009" },
                 { name: "Walk In Two", mobile: "9811000009" }]),
   ["Walk In One", "Walk In Two"]);
eq("but the same name on the same number is one person",
   importer([], [{ name: "Walk In One", mobile: "9811000009" },
                 { name: "walk in  one", mobile: "9811000009" }]),
   ["Walk In One"]);
eq("a contact typed in by hand, with no UHID, is matched on name and number",
   importer([{ firstName: "No UHID", lastName: "person", phone: "98110 00005" }],
            [{ name: "No UHID person", mobile: "9811000005" }]), []);
eq("but that never blocks a patient who has a UHID",
   importer([{ firstName: "Someone", phone: "9811000001" }], family).length, 5);
eq("a row with neither UHID nor name is skipped", importer([], [{ mobile: "9" }]), []);
eq("running it twice adds nobody the second time",
   importer(family.map(p => {
     const n = p.name.split(" ");
     return { uhid: p.uhid, firstName: n[0], lastName: n.slice(1).join(" "), phone: String(p.mobile) };
   }), family), []);

// ── and the rule in the page matches the one tested ───────────────────────
ok("the page keys on the UHID and the name together",
   /if\(c\.uhid\) \{ have\[idKey\(c\.uhid, nm\)\] = true; return; \}/.test(CRM) &&
   /var ik = idKey\(uh, pt\.name\);/.test(CRM));
ok("a row with no UHID is keyed on its name AND number, never the number alone",
   /var sk = softKey\(pt\.name, tel\);/.test(CRM) && /if\(haveSoft\[sk\]\)/.test(CRM));
ok("no phone is recorded as taken for a patient who has a UHID",
   /if\(have\[ik\]\)\{ nAlready\+\+; return; \}/.test(CRM));
ok("a UHID doing duty for two people is reported, not quietly absorbed",
   /sharing a UHID with a different patient/.test(CRM));

// ── the import accounts for every row it was given ────────────────────────
const out = importer([], [
  { uhid: "KB1", name: "A", mobile: "1" }, { uhid: "KB1", name: "A again", mobile: "1" },
  { name: "B", mobile: "2" }, { name: "B", mobile: "2" },
  { name: "", mobile: "3" },
]);
eq("added plus every stated reason equals what the register returned",
   out.length + out.skipped.already + out.skipped.softDup + out.skipped.blank, 5);
eq("and each reason is counted separately",
   [out.length, out.skipped.already, out.skipped.softDup, out.skipped.blank], [3, 0, 1, 1]);
ok("the page reports that arithmetic rather than only a total",
   /Register holds ' \+ nTotal/.test(CRM) && /already here/.test(CRM) &&
   /the same name and number as another row/.test(CRM) &&
   /neither a UHID nor a name/.test(CRM));

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
