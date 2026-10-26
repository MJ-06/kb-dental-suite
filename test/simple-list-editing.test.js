// Appointment Reasons — and the nine other plain lists that share
// SimpleListEditor — could only be added to and emptied. Correcting a
// spelling meant removing the entry and retyping it, and anything already
// recorded against the old wording no longer matched it.
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

const body = HTML.slice(HTML.indexOf("function SimpleListEditor"),
                        HTML.indexOf("// Name + Fee list editor (Treatments)"));
ok("it takes an onEdit", /function SimpleListEditor\(\{[^}]*onEdit/.test(body));
ok("a row opens in place", /editAt===i/.test(body));
ok("there is a Save", /\}, "Save"\)/.test(body));
ok("and a Cancel", /\}, "Cancel"\)/.test(body));
ok("Enter saves, Escape backs out",
   /e\.key==="Enter"\) saveEdit\(i\)/.test(body) && /e\.key==="Escape"\) setEditAt\(null\)/.test(body));
ok("Save is refused on an empty entry", /disabled:!txt\(draft\)\.trim\(\)/.test(body));
ok("renaming one entry onto another is refused, or the list would hold two the same",
   /items\.some\(\(x, ix\) => ix !== i && txt\(x\)\.trim\(\) === v\)/.test(body));
ok("sheet values are made text before they are touched",
   /const txt = \(v\) => \(v === undefined \|\| v === null\) \? "" : String\(v\);/.test(body));
ok("Remove asks first and names the entry", /window\.confirm\("Remove " \+ txt\(it\)/.test(body));
ok("Edit and Remove sit side by side", /"Edit"\)[\s\S]{0,400}"Remove"\)/.test(body));
ok("a list given no onEdit still shows Remove and simply has no Edit",
   /onEdit && React\.createElement\("button"/.test(body));

// ── every list that should have it, does ──────────────────────────────────
const sites = [...HTML.matchAll(/    (\w+): \(\) => React\.createElement\(SimpleListEditor, \{([\s\S]*?)\n    \}\),/g)]
  .map(m => ({ tab: m[1], hasEdit: /onEdit:/.test(m[2]) }));
eq("all nine plain lists are accounted for", sites.length, 9);
// Appointment Reasons left this editor: a reason now carries the steps it
// breaks into, so it is edited as a name plus a comma-separated list — the
// same shape, and the same editor, as implant brands and their sizes.
ok("Appointment Reasons is no longer a plain list",
   !sites.find(s => s.tab === "apptReasons"), JSON.stringify(sites.map(s => s.tab)));
ok("and is edited with its steps instead, still with an Edit",
   /apptReasons: \(\) => React\.createElement\(ImplantBrandListEditor[\s\S]{0,1400}onEdit:/.test(HTML));

const without = sites.filter(s => !s.hasEdit).map(s => s.tab);
// Panels is deliberately left alone. A panel's NAME is the key: registrations
// record it, and the rate card is keyed by it. Renaming one here would orphan
// every row that already references it, silently, which is worse than having
// to delete and re-add a panel on the rare occasion the name is wrong.
eq("only Panels is left without one, and on purpose", without, ["panels"]);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
