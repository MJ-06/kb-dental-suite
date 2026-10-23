// The clinic profile has carried the pad's four margins all along, and the
// Prescription form's host already reads them out of it. The feature was
// whole; what it never had was any sign that pressing Save had worked — the
// only confirmation was a line at the TOP of a long page, scrolled out of
// sight by the time the button at the bottom is reached.
//
// This also guards against what I did on the way here: a SECOND pad-margins
// screen with its own store, whose fetch raced the clinic profile's in the
// same component. Whichever answered last decided what the pad looked like.
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

// ── one place, not two ────────────────────────────────────────────────────
eq("there is exactly one pad-margins screen",
   (HTML.match(/Prescription Pad Print Margins/g) || []).length, 1);
ok("and it is the clinic profile's, where it always was",
   /function ClinicProfileEditor\(\{ profile, onSave \}\)/.test(HTML) &&
   HTML.indexOf("Prescription Pad Print Margins") > HTML.indexOf("function ClinicProfileEditor"));
ok("the duplicate screen is gone", !/PadMarginsEditor/.test(HTML));
ok("so is its separate store", !/getPadMargins|savePadMargins/.test(HTML) && !/PAD_MARGINS_TAB/.test(GS));
// Two effects setting the same state is a race, not a redundancy.
eq("the form's host sets its margins from one place only",
   (HTML.match(/setPadMargins\(/g) || []).length, 1);
ok("and that place is the clinic profile",
   /api\("getClinicProfile"\)\.then\(res => \{[\s\S]{0,400}setPadMargins\(\{/.test(HTML));

// ── the margins really do reach the form ──────────────────────────────────
ok("the profile's four numbers become the page margins",
   /top: \(p\.padTop \|\| "44"\) \+ "mm"/.test(HTML) && /left: \(p\.padLeft \|\| "52"\) \+ "mm"/.test(HTML));
ok("and are sent on to the form", /type: "KB_PAD_MARGINS", margins: padMargins/.test(HTML));
ok("whenever they change", /React\.useEffect\(\(\) => \{ sendPadMarginsToForm\(\); \}, \[padMargins\]\);/.test(HTML));
const m = /const PRESCRIPTION_FORM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
const PRESC = Buffer.from((m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join(""), "base64").toString("utf8");
ok("and the form listens for them", /KB_PAD_MARGINS/.test(PRESC) && /PAD_MARGINS = d\.margins/.test(PRESC));

// ── the five millimetres ──────────────────────────────────────────────────
// The footer needs about 13mm, so 18 wasted five on every case paper.
ok("the clinic profile's bottom default is 15, not 18",
   /padBottom \|\| "15"/.test(HTML) && !/padBottom \|\| "18"/.test(HTML));
ok("the host agrees", /\(p\.padBottom \|\| "15"\)/.test(HTML));
ok("and so does the form's own fallback",
   /bottom: '15mm'/.test(PRESC) && !/bottom: '18mm'/.test(PRESC));
ok("the other three are untouched, because they were measured right",
   /padTop \|\| "44"/.test(HTML) && /padLeft \|\| "52"/.test(HTML) && /padRight \|\| "15"/.test(HTML));

// ── and you can tell whether it saved ─────────────────────────────────────
const ed = HTML.slice(HTML.indexOf("function ClinicProfileEditor"), HTML.indexOf("\nfunction ", HTML.indexOf("function ClinicProfileEditor") + 10));
ok("the outcome is shown at the button, not only at the top of the page",
   /saved === "done" && React\.createElement/.test(ed));
ok("it reads the margins back, so there is something to check against the pad",
   /Saved\. The case paper will print " \+ padTop \+ "mm from the top/.test(ed));
ok("a refusal says so there too", /saved === "failed" && React\.createElement/.test(ed));
ok("the button says it is working while it is", /saved === "saving" \? "Saving/.test(ed));
ok("the confirmation waits for the save to land rather than the click",
   /Promise\.resolve\(onSave\(\{[\s\S]{0,200}\.then\(okd =>/.test(ed));
ok("and a save that failed is not shown as done", /okd === false \? "failed" : "done"/.test(ed));
ok("which it can only know because the save hands its result back",
   /if \(!saved\) window\.CLINIC = prevWindow;\n    return saved;/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
