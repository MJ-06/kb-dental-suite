// "RCT" is not one appointment. Access opening, biomechanical preparation and
// obturation need different time, a different tray and a different chair
// set-up, and the desk could only ever write "RCT" — so nothing could be
// prepared before the patient arrived.
//
// A reason now carries the steps it breaks into, and booking asks which one.
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

// ── the two rules, run ───────────────────────────────────────────────────
function fn(marker) {
  const i = HTML.indexOf(marker);
  return new Function(HTML.slice(i, HTML.indexOf("\n}", i) + 2) +
    "\nreturn " + marker.replace("function ", "").replace(/\(.*/, "") + ";")();
}
const stepsForReason = fn("function stepsForReason(");
const reasonWithStep = fn("function reasonWithStep(");

const MASTER = [
  { name: "RCT", steps: "Access opening, BMP, Obturation" },
  { name: "Cleaning", steps: "" },
  { name: "Crown", steps: "Preparation , Trial,Cementation " }
];
eq("a reason that takes several visits lists them",
   stepsForReason(MASTER, "RCT"), ["Access opening", "BMP", "Obturation"]);
eq("spacing in the master list does not matter",
   stepsForReason(MASTER, "Crown"), ["Preparation", "Trial", "Cementation"]);
eq("a one-visit reason has none", stepsForReason(MASTER, "Cleaning"), []);
eq("a reason nobody has set up has none", stepsForReason(MASTER, "Whitening"), []);
eq("and no master at all does not throw", stepsForReason(null, "RCT"), []);
eq("an empty step is not a step", stepsForReason([{ name: "X", steps: "A,,B," }], "X"), ["A", "B"]);

eq("the day sheet shows the reason and the step",
   reasonWithStep("RCT", "Obturation"), "RCT · Obturation");
eq("just the reason where there is no step", reasonWithStep("Cleaning", ""), "Cleaning");
eq("and a dash where there is neither", reasonWithStep("", ""), "—");
eq("a step with no reason still reads", reasonWithStep("", "BMP"), "BMP");

// ── booking asks for it ──────────────────────────────────────────────────
ok("both booking forms ask which step",
   (HTML.match(/stepsForReason\(reasonSteps, fReason\)\.length > 0/g) || []).length === 2);
ok("only where the reason has steps, so a cleaning is not interrogated",
   /stepsForReason\(reasonSteps, fReason\)\.length > 0 &&/.test(HTML));
ok("nothing is preselected, so an unanswered step stays unanswered",
   /which step/.test(HTML));
ok("changing the reason drops a step belonging to the old one",
   (HTML.match(/setFReason\(e\.target\.value\); setFSubReason\(""\);/g) || []).length === 2);
ok("both forms send it", (HTML.match(/type: fReason, subType: fSubReason/g) || []).length === 2);
ok("editing a booking shows the step it already has",
   /setFSubReason\(a\.subType\|\|""\);/.test(HTML));
ok("and both forms clear it when reset",
   (HTML.match(/setFSubReason\(""\)/g) || []).length >= 4);
ok("the desk is told why it is being asked",
   /So the chair and tray can be set up before the patient arrives\./.test(HTML));

// ── it is shown where staff read it ─────────────────────────────────────
ok("the day sheet shows it", /reasonWithStep\(a\.type, a\.subType\)\)/.test(HTML));
ok("and the appointment itself", /"For: ", React\.createElement/.test(HTML));

// ── the clinic book keeps it ─────────────────────────────────────────────
ok("the appointments sheet has a column for it",
   /"Date","UHID","Patient Name","Time","Type","SubType","Doctor","Chair"/.test(GS));
ok("which is added to a sheet that predates it rather than assumed",
   /var missing = APPOINTMENT_HEADERS\.filter/.test(GS));
ok("a new booking writes it", /"SubType": p\.subType \|\| ""/.test(GS));
ok("an edited booking updates it", /"Type": p\.type, "SubType": p\.subType,/.test(GS));
ok("and reading a day gives it back",
   /subType: col\("SubType"\) >= 0 \? String\(row\[col\("SubType"\)\] \|\| ""\) : ""/.test(GS));

// ── the master keeps reason and steps together ───────────────────────────
const getR = GS.slice(GS.indexOf("function getReasonsList()"),
                      GS.indexOf("\n}", GS.indexOf("function getReasonsList()")));
ok("the reasons come back as names, as everything reading them expects",
   /reasons: reasons/.test(getR));
ok("with the steps alongside rather than instead",
   /reasonSteps: steps/.test(getR));
ok("a book with no steps column reads as no steps, not as a failure",
   /data\[i\]\[1\] === undefined \|\| data\[i\]\[1\] === null \? "" : data\[i\]\[1\]/.test(getR));
const saveR = GS.slice(GS.indexOf("function saveReasonsList(p)"),
                       GS.indexOf("\n}", GS.indexOf("function saveReasonsList(p)")));
ok("saving accepts a reason with its steps",
   /if \(r && typeof r === "object"\)/.test(saveR));
ok("and a plain name, as this list has always been saved",
   /sh\.appendRow\(\[String\(r\)\.trim\(\), "", now\]\)/.test(saveR));
ok("the list is parsed before the tab is cleared, so a bad payload empties nothing",
   saveR.indexOf("parseList_") < saveR.indexOf("clearContents"));

// ── Master edits them ────────────────────────────────────────────────────
ok("Master edits a reason and its steps together",
   /apptReasons: \(\) => React\.createElement\(ImplantBrandListEditor/.test(HTML));
ok("reusing the one editor rather than a second copy of it",
   (HTML.match(/function ImplantBrandListEditor/g) || []).length === 1);
ok("with its own wording, not an implant's",
   /nameLabel:"Reason", sizesLabel:"Steps"/.test(HTML));
ok("and the editor still says brand and sizes where it is an implant",
   /nameLabel \|\| "Brand"/.test(HTML) && /sizesLabel \|\| "Sizes"/.test(HTML));
ok("Master loads the steps, not only the names",
   /setApptReasons\(ar\.reasonSteps \|\|/.test(HTML));
ok("and an older book with only names still loads",
   /\(ar\.reasons \|\| \[\]\)\.map\(r => \(\{ name: r, steps: "" \}\)\)/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
