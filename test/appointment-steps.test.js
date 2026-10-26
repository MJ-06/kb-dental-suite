// An appointment should say which step of the treatment it is — "RCT ·
// Access opening", not just "RCT" — so the chair and tray can be set up
// before the patient arrives.
//
// The form already knows. Picking the Procedure attaches the patient's
// treatment case and the panel beside it reads "CURRENT: <stage>". Asking a
// second time, with a dropdown of steps kept in Master, was asking staff to
// repeat what the screen had already worked out, and gave two places to edit
// the same list of stages and two to disagree.
//
// So the stage is taken from the case, and nothing extra is asked.
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

// ── nothing extra is asked ───────────────────────────────────────────────
ok("there is no second dropdown of steps to fill in",
   HTML.indexOf('c:"Step"') < 0 && HTML.indexOf('c: "Step"') < 0);
ok("nor a list of them kept beside the reasons",
   HTML.indexOf("stepsForReason") < 0 && HTML.indexOf("reasonSteps") < 0);
ok("and appointment reasons are a plain list again",
   /apptReasons: \(\) => React\.createElement\(SimpleListEditor/.test(HTML));
ok("so the stages live in one place only — the procedure library",
   /procedureLibrary: \(\) => React\.createElement\(ProcedureLibraryEditor/.test(HTML));

// ── the stage comes from the case the form already picked ────────────────
const save = HTML.slice(HTML.indexOf("    let stageName = \"\";"),
                        HTML.indexOf("const res = editingId"));
ok("the booking takes the stage from the case", /stageName = String\(cs\.currentStageName \|\| ""\)\.trim\(\);/.test(save), save.slice(0, 400));
ok("and sends it as the appointment's sub-type",
   /type: fReason, subType: stageName,/.test(save), save.slice(-400));
ok("a booking with no procedure attached sends no stage, rather than a guess",
   /let stageName = "";/.test(save) && save.indexOf('stageName = String') > save.indexOf('let stageName = ""'));
// The case is started first where it is new, so the stage read is the real
// one rather than the blank of a case that does not exist yet.
ok("the case is started before its stage is read",
   save.indexOf("startTreatmentCase") < save.indexOf("stageName = String(cs.currentStageName"));
ok("the walk-in form sends none, because it tracks no case",
   !/subType/.test(HTML.slice(HTML.indexOf("function QuickApptModal"), HTML.indexOf("function Daysheet"))));

// ── it is shown where staff read it ──────────────────────────────────────
const i = HTML.indexOf("function reasonWithStep(");
const reasonWithStep = new Function(HTML.slice(i, HTML.indexOf("\n}", i) + 2) + "\nreturn reasonWithStep;")();
eq("the day sheet shows the reason and the step",
   reasonWithStep("RCT", "Access opening"), "RCT · Access opening");
eq("just the reason where the visit is not part of a case",
   reasonWithStep("Cleaning", ""), "Cleaning");
eq("and a dash where there is neither", reasonWithStep("", ""), "—");
eq("a step with no reason still reads", reasonWithStep("", "BMP"), "BMP");
eq("whitespace is not mistaken for a step", reasonWithStep("RCT", "   "), "RCT");

ok("the day sheet uses it", /reasonWithStep\(a\.type, a\.subType\)\)/.test(HTML));
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

// ── the stage the case reports is the one the form shows ─────────────────
// The panel reads CURRENT off the same field, so the two cannot drift.
ok("the panel on screen reads the same field",
   /"CURRENT: " \+ \(displayCase\.currentStageName \|\| "—"\)/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
