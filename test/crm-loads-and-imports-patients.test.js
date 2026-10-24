// Three faults, one visible: the CRM screen was blank in the app.
//
// It fetched React from unpkg while the app fetches it from cdnjs, so a
// network that reached one and not the other opened the whole suite except
// this screen — blank, with nothing on it to say why. And it was marked
// type="text/babel" while containing no JSX at all, so the browser also
// downloaded about two and a half megabytes of compiler to compile 134 KB of
// JavaScript into the JavaScript it already had.
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
// The page explains in its own comments what it no longer does, and those
// comments name the very things being checked for. Assertions about what the
// code DOES must read the code, not the prose around it.
const CODE = CRM
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

// ── why it was blank ──────────────────────────────────────────────────────
const host = u => (u.match(/^https?:\/\/([^/]+)/) || [,""])[1];
const appHosts = [...new Set((HTML.slice(0, HTML.indexOf("const CRM_B64"))
  .match(/<script src="(https:\/\/[^"]+)"/g) || []).map(s => host(s.slice(13))))];
const crmHosts = [...new Set((CRM.match(/<script src="(https:\/\/[^"]+)"/g) || []).map(s => host(s.slice(13))))];
eq("the CRM loads its libraries from the same place the app does",
   crmHosts.filter(h => appHosts.indexOf(h) < 0), []);
ok("which is cdnjs, not unpkg", crmHosts.indexOf("cdnjs.cloudflare.com") >= 0 && !/unpkg\.com/.test(CRM));

ok("nothing is compiled in the browser any more", !/text\/babel/.test(CODE));
ok("and Babel is not downloaded at all", !/babel/i.test(CODE));
// The reason that is safe: there was never any JSX to compile.
const block = CRM.slice(CRM.indexOf("<script>", CRM.indexOf("react-dom")));
eq("because the page holds no JSX", (block.match(/(?:return|=>|\(|,)\s*<[A-Za-z]/g) || []), []);
ok("every React version is pinned, so it cannot change underneath the clinic",
   (CODE.match(/<script src="(https:\/\/[^"]+)"/g) || [])
     .every(u => /\d+\.\d+\.\d+/.test(u)));

// ── the activity log says who actually did it ─────────────────────────────
ok("no activity is stamped with one hardcoded person", !/viveyk Mittel/.test(CODE));
ok("nor is the activities header", !/,'viveyk'\)/.test(CRM) && !/\}\},'VM'\)/.test(CRM));
ok("the log takes the name from the signed-in session", /userName:crmWho\(\)/.test(CRM));
ok("and falls back to \"Staff\" rather than crediting somebody who is not there",
   /return 'Staff';/.test(CRM));

// ── patients are already customers ────────────────────────────────────────
ok("Contacts has an Import Patients button", /Import Patients/.test(CRM));
ok("it reads the clinic's own register through the app",
   /crmAllPatients\(\)/.test(CRM) && /d\.type === "KB_CRM_ALL_PATIENTS"/.test(HTML) &&
   /api\("getAllPatients"\)/.test(HTML));
ok("an import that cannot read the register says so",
   /Could not read the register/.test(CRM));
// On the UHID *and* the name — two different people were given one id at the
// desk, and on the id alone the second never became a contact. See
// crm-import-keeps-families.
ok("a patient already here is skipped on UHID and name",
   /if\(have\[ik\]\)\{[\s\S]{0,900}?nAlready\+\+; return;\s*\}/.test(CRM));
// A row with no UHID is keyed on its name AND number — never the number
// alone, which dropped families and then second walk-ins. See
// crm-import-keeps-families.
ok("and on name-with-number only where there is no UHID to go on",
   /var sk = softKey\(pt\.name, tel\);/.test(CRM));
ok("a mobile stored as a number is still matched",
   /String\(pt\.mobile==null\?'':pt\.mobile\)\.replace\(\/\\D\/g,''\)/.test(CRM));
ok("the imported contact carries its UHID", /uhid: uh,/.test(CRM));
ok("running it again reports everyone as already here rather than adding them",
   /nAlready \+ ' already here'/.test(CRM));
// It used to only ever add. That left the contacts made by the first import
// -- before the panel fields were carried across -- showing as "Individual"
// for good, because a re-run skipped them untouched. It now fills in a panel
// the register knows and the contact has not got.
ok("an import fills in a panel a contact is missing",
   /mended\.push\(\{ id: ex\.id, panel: String\(pt\.panel\)\.trim\(\)/.test(CRM));
ok("but only where the contact has none, so nothing set by hand is argued with",
   /String\(pt\.panel\|\|''\)\.trim\(\) && !String\(ex\.panel\|\|''\)\.trim\(\)/.test(CRM));
ok("and the repairs go up with the additions as one list",
   /persist\('contacts','contacts', next\.concat\(added\)\)/.test(CRM));
ok("the desk is told, rather than contacts changing silently",
   /already here, now filed under their panel/.test(CRM));
ok("the result is shown on the page, not left to a toast nobody saw",
   /st\.sec==='contacts' && st\.importMsg/.test(CRM));
ok("the button is disabled while it runs, so it cannot be double-pressed",
   /onClick:importPatientsAsContacts,disabled:st\.importBusy/.test(CRM));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
