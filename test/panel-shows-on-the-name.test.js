// An empanelled patient should read "Deepa Tyagi CGHS" in the CRM, so they
// are recognisable in a list, a dropdown or on the lead board without being
// opened.
//
// Display only. firstName and lastName are left exactly as they are, so
// nothing printed, claimed or signed is touched, and a contact exported or
// edited still carries the patient's real name.
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

const a = html.indexOf("const CRM_B64 =");
const CRM = Buffer.from((html.slice(a, html.indexOf(";\n", a)).match(/"([^"]*)"/g) || [])
  .map(s => s.slice(1, -1)).join(""), "base64").toString("utf8");
const CODE = CRM.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/^\s*\/\/.*$/gm, "");

const i = CODE.indexOf("function contactName(c){");
const contactName = new Function(CODE.slice(i, CODE.indexOf("\n  }", i) + 4) + "\nreturn contactName;")();

// ── the name as the CRM reads it ─────────────────────────────────────────
eq("an empanelled patient carries their panel",
   contactName({ firstName: "Deepa", lastName: "Tyagi", panel: "CGHS" }), "Deepa Tyagi CGHS");
eq("a private patient reads exactly as before",
   contactName({ firstName: "Vikram", lastName: "Rao" }), "Vikram Rao");
eq("a blank panel is not a panel",
   contactName({ firstName: "A", lastName: "B", panel: "   " }), "A B");
eq("any panel, not only CGHS",
   contactName({ firstName: "Lata", lastName: "Sharma", panel: "DGEHS" }), "Lata Sharma DGEHS");
eq("a patient with one name still works",
   contactName({ firstName: "Santosh", panel: "CGHS" }), "Santosh CGHS");
eq("and one with no name at all does not throw", contactName({ panel: "CGHS" }), "CGHS");
eq("nor does no contact at all", contactName(null), "");

// Somebody may have typed the panel onto the name before this existed.
eq("a name already ending in the panel does not get it twice",
   contactName({ firstName: "Deepa", lastName: "Tyagi CGHS", panel: "CGHS" }), "Deepa Tyagi CGHS");
eq("however it was typed",
   contactName({ firstName: "Deepa", lastName: "Tyagi cghs", panel: "CGHS" }), "Deepa Tyagi cghs");
// But a name that merely CONTAINS it still gets the suffix -- "CGHS Colony"
// is an address, not a panel marking.
eq("a name that only mentions it elsewhere is still marked",
   contactName({ firstName: "CGHS", lastName: "Colony Patient", panel: "CGHS" }),
   "CGHS Colony Patient CGHS");

// ── the stored record is untouched ───────────────────────────────────────
const c = { firstName: "Deepa", lastName: "Tyagi", panel: "CGHS" };
contactName(c);
eq("reading the name does not change the record stored",
   [c.firstName, c.lastName], ["Deepa", "Tyagi"]);
ok("the suffix is never saved onto a contact",
   !/firstName:.*\+ ' ' \+ .*panel/.test(CODE) && !/lastName.*panel\b.*\+/.test(CODE));
// Editing a contact must show the real name, or saving would bake the suffix
// into the record.
ok("the edit form still binds the real first and last name",
   /ir\('First Name\*',inp\(f\.firstName,fUpd\('firstName'\)/.test(CODE) &&
   /inp\(f\.lastName,fUpd\('lastName'\)/.test(CODE));
// The contact's own detail panel lists the stored fields, so the real name
// is always readable somewhere even while the heading carries the suffix.
ok("and the detail panel lists the stored name, not the display one",
   /\['First Name',c\.firstName\],\['Last Name',c\.lastName\|\|'—'\]/.test(CODE));
ok("and a contact is saved from those fields, not from what is displayed",
   /firstName:f\.firstName,lastName:f\.lastName\|\|''/.test(CODE));

// ── it is used everywhere a contact is named ─────────────────────────────
const uses = (CODE.match(/contactName\(/g) || []).length;
ok("the one rule is used in several places, not copied", uses >= 7, uses);
ok("the contacts list uses it", /\n\s*contactName\(c\)\n/.test(CODE) || /,contactName\(c\)\)/.test(CODE));
ok("the lead's contact dropdown uses it",
   /e\('option',\{key:c\.id,value:c\.id\},contactName\(c\)/.test(CODE));
ok("the lead card uses it", /contactName\(contact\)\+\(contact\.phone/.test(CODE));
ok("the contact's own page uses it",
   /flex:1\}\},contactName\(c\)\)/.test(CODE));
ok("searching finds what is on the screen",
   /contactName\(c\)\.toLowerCase\(\)\.indexOf\(s\)>=0/.test(CODE));
ok("and still finds the real name, for anyone searching that",
   /\(c\.firstName\|\|''\)\.toLowerCase\(\)\.indexOf\(s\)>=0/.test(CODE));

// The export is the record, not the screen: it keeps the real names.
ok("the CSV export carries the patient's real name, not the display one",
   /\[c\.firstName,c\.lastName\|\|''/.test(CODE));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
