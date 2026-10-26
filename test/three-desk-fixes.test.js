// Three things reported from the desk.
//
//  1. The Personal Information sheet never asked whether the patient is
//     private or on a panel. It was asked once, on the screen BEFORE the
//     quick form, so anyone opening an existing patient or filling the full
//     form on the iPad never saw it and could not see or correct it.
//  2. That sheet had a "Landline" box that nothing saved and nothing read
//     back -- whatever was typed into it was thrown away on submit. It is a
//     second mobile now, and it is written to the register.
//  3. A check-in pressed by accident could not be undone. The appointment
//     stayed Checked In and the time stayed on the day sheet for good.
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

// ── 1. private or panel, on the sheet ────────────────────────────────────
const sec = HTML.slice(HTML.indexOf('t: "Personal Information"'),
                       HTML.indexOf('c: "Full Name *"'));
ok("the sheet asks which kind of patient", /c: "Patient Type"/.test(sec), sec.slice(0, 300));
ok("as two buttons, since it is always one of the two",
   /\["normal", "Normal", T\], \["panel", "Panel", "#7C3AED"\]/.test(sec));
ok("choosing Panel asks which panel", /c: "Panel"/.test(sec));
ok("whether the holder is serving or a pensioner", /c: "Card Holder"/.test(sec));
ok("and the card number", /c: "Card ID"/.test(sec));
ok("the panels come from Master, with no built-in list to go stale",
   /panels\.map\(n => ceQ\("option"/.test(sec) && /Master \\u2192 Accounts \\u2192 Panels/.test(sec));
ok("going back to Normal clears the panel, so none is left behind",
   /if \(v === "normal"\) \{ setPanel\(""\); setQ\(prev => \(\{ \.\.\.prev, panelCat: "", cardId: "" \}\)\); \}/.test(sec));
// It is data only. The slip must stay the same for both.
const slip = HTML.slice(HTML.indexOf("KBDC/FORMS/REG-01"), HTML.indexOf("General Consent Form"));
ok("nothing about the panel is printed on the registration slip",
   slip.indexOf("patientType") < 0 && slip.indexOf("Card ID") < 0 && slip.indexOf("panelCategory") < 0);

// ── 2. Mobile 2 ──────────────────────────────────────────────────────────
ok("the Landline box is gone", HTML.indexOf('c: "Landline"') < 0);
ok("nothing in the page still carries a landline", !/\blandline\b/.test(HTML.replace(/\/\/.*$/gm, "")));
ok("the sheet asks for a second mobile instead", /c: "Mobile 2"/.test(HTML));
ok("a blank registration has the field", /\n  mobile2: "",/.test(HTML));
ok("it is sent when the form is saved", /mobile2: P\.mobile2 \|\| "",/.test(HTML));
ok("and read back when an existing patient is opened",
   /mobile2:\s*p\.mobile2\s*\|\| ""/.test(HTML));
// The register must have somewhere to put it, or it is thrown away again.
const save = GS.slice(GS.indexOf("function saveRegistration(p)"),
                      GS.indexOf("\n}", GS.indexOf("function saveRegistration(p)")));
const ensured = (save.match(/ensureRegColumns_\(sh, \[[\s\S]*?\]\)/) || [""])[0];
ok("the register is given a Mobile 2 column, not assumed to have one",
   ensured.indexOf('"Mobile 2"') >= 0, ensured);
ok("and the value is written into it", /"Mobile 2": p\.mobile2 \|\| ""/.test(save));
ok("a record whose old number sat under Landline is still read",
   /mobile2:\s+get\("Mobile 2", "Mobile2", "Landline"\)/.test(GS));

// ── 3. undoing a check-in ────────────────────────────────────────────────
// The backend rule, run.
const steps = GS.slice(GS.indexOf("var APPT_STEPS = ["), GS.indexOf("\n}", GS.indexOf("function apptStepOf_")) + 2);
const apptStepOf_ = new Function(steps + "\nreturn apptStepOf_;")();
eq("Scheduled is the start of the line", apptStepOf_("Scheduled"), 0);
eq("and Completed the end", apptStepOf_("Completed"), 3);
eq("a cancelled visit is not on the line at all", apptStepOf_("Cancelled"), -1);
eq("nor is a no-show", apptStepOf_("No Show"), -1);

const upd = GS.slice(GS.indexOf("function updateAppointmentStatus(p)"),
                     GS.indexOf("\n}", GS.indexOf("function updateAppointmentStatus(p)")));
ok("stamps after the step being set are cleared",
   /for \(var k = step \+ 1; k < APPT_STEPS\.length; k\+\+\)/.test(upd) &&
   /setValue\(""\)/.test(upd), upd);
ok("and the step's own stamp is only written if it has none",
   /if \(own >= 0 && !String\(data\[i\]\[own\] \|\| ""\)\.trim\(\)\)/.test(upd));
ok("so stepping back does not rewrite when the patient actually arrived",
   /must not rewrite the time the patient/.test(GS));
ok("undoing a cancellation clears the reason behind it",
   /if \(step >= 0 && col\("CancelReason"\) >= 0 && !p\.cancelReason\)/.test(upd));

// The screen must say the same as the sheet.
const cleared = new Function(
  HTML.slice(HTML.indexOf("const APPT_STAMP_ORDER = ["),
             HTML.indexOf("\n}", HTML.indexOf("function apptClearedStamps")) + 2) +
  "\nreturn apptClearedStamps;")();
eq("putting a patient back to Scheduled clears every stamp on screen",
   cleared("Scheduled"), { checkinTime: "", engagedTime: "", checkoutTime: "" });
eq("back to Checked In clears only what came after",
   cleared("Checked In"), { engagedTime: "", checkoutTime: "" });
eq("a completed visit clears nothing", cleared("Completed"), {});
eq("and cancelling clears nothing either", cleared("Cancelled"), {});

// The way back is offered where the check-in happens.
ok("there is a way back from every step forward",
   /"Checked In": \{ label: "Undo check-in", back: "Scheduled"/.test(HTML) &&
   /"In Chair":   \{ label: "Back to checked in", back: "Checked In"/.test(HTML) &&
   /"Completed":  \{ label: "Reopen visit", back: "In Chair"/.test(HTML));
ok("each one says what it will do before doing it",
   (HTML.match(/confirm: "/g) || []).length >= 3);
ok("the day sheet offers it, which is where the check-in is pressed",
   /undo && React\.createElement\("button"/.test(HTML));
ok("and so does the appointment itself",
   /APPT_UNDO_ACTION\[a\.status\] && React\.createElement\("button"/.test(HTML));
ok("the day sheet can call a visit off outright, with a reason",
   /const cancelFromDaysheet = async \(a\) =>/.test(HTML) &&
   /await updateStatus\(a\.id, "Cancelled", pick\)/.test(HTML));
ok("a reason that is not one of the four changes nothing",
   /if \(!pick\) \{ setStatusErr/.test(HTML));
ok("and the screen's own copy of the row is cleared with the sheet's",
   (HTML.match(/\.\.\.apptClearedStamps\(status\)|\.\.\.cleared/g) || []).length >= 3);


// ── the status change, run against a sheet ───────────────────────────────
// It writes into the live Appointments sheet, so the cells it touches are
// inspected rather than the source read.
function apptBook(grid) {
  const g = grid.map(r => r.slice());
  const sheet = {
    grid: g,
    getDataRange: () => ({ getValues: () => g.map(r => r.slice()) }),
    getRange(r, c) {
      return { setValue(v) { while (g[r - 1].length < c) g[r - 1].push(""); g[r - 1][c - 1] = v; } };
    }
  };
  return sheet;
}
const UPD = GS.slice(GS.indexOf("var APPT_STEPS = ["),
                     GS.indexOf("\n}", GS.indexOf("function updateAppointmentStatus(p)")) + 2);
function setStatus(sheet, p) {
  return new Function("getAppointmentsSheet", "fmtTime", "__p",
    UPD + "\nreturn updateAppointmentStatus(__p);")(
    () => sheet, () => "15:42", p);
}
const AH = ["ID", "Date", "UHID", "Patient Name", "Time", "Status",
            "CheckinTime", "EngagedTime", "CheckoutTime", "CancelReason"];
const row = (status, ci, en, co, reason) =>
  ["A1", "2026-10-26", "KB1", "Asha", "10:00", status, ci || "", en || "", co || "", reason || ""];
const col = n => AH.indexOf(n);

// The exact complaint: checked in by accident, patient never came.
let sh = apptBook([AH, row("Checked In", "09:58")]);
let r = setStatus(sh, { apptId: "A1", status: "Scheduled" });
ok("the check-in can be undone", r.success, JSON.stringify(r));
eq("the appointment is scheduled again", sh.grid[1][col("Status")], "Scheduled");
eq("and the check-in time is cleared, not left behind",
   sh.grid[1][col("CheckinTime")], "");

// Stepping back one notch must not rewrite when the patient actually arrived.
sh = apptBook([AH, row("In Chair", "09:58", "10:05")]);
setStatus(sh, { apptId: "A1", status: "Checked In" });
eq("going back to checked in keeps the real arrival time",
   sh.grid[1][col("CheckinTime")], "09:58");
eq("and clears the engaged time", sh.grid[1][col("EngagedTime")], "");

// All the way back from completed.
sh = apptBook([AH, row("Completed", "09:58", "10:05", "10:40")]);
setStatus(sh, { apptId: "A1", status: "Scheduled" });
eq("undoing a whole visit clears all three stamps",
   [sh.grid[1][col("CheckinTime")], sh.grid[1][col("EngagedTime")], sh.grid[1][col("CheckoutTime")]],
   ["", "", ""]);

// Going forward is unchanged.
sh = apptBook([AH, row("Scheduled")]);
setStatus(sh, { apptId: "A1", status: "Checked In" });
eq("checking a patient in still stamps the time", sh.grid[1][col("CheckinTime")], "15:42");
eq("and sets the status", sh.grid[1][col("Status")], "Checked In");

sh = apptBook([AH, row("Checked In", "09:58")]);
setStatus(sh, { apptId: "A1", status: "In Chair" });
eq("engaging stamps its own time", sh.grid[1][col("EngagedTime")], "15:42");
eq("without disturbing the check-in", sh.grid[1][col("CheckinTime")], "09:58");

// Cancelling records the reason and leaves the record alone.
sh = apptBook([AH, row("Checked In", "09:58")]);
setStatus(sh, { apptId: "A1", status: "Cancelled", cancelReason: "No Show" });
eq("a cancelled visit says so", sh.grid[1][col("Status")], "Cancelled");
eq("with the reason recorded", sh.grid[1][col("CancelReason")], "No Show");
eq("and a genuine arrival time is not erased by cancelling",
   sh.grid[1][col("CheckinTime")], "09:58");

// Putting a cancelled appointment back must not leave the reason behind.
sh = apptBook([AH, row("Cancelled", "", "", "", "No Show")]);
setStatus(sh, { apptId: "A1", status: "Scheduled" });
eq("un-cancelling clears the reason", sh.grid[1][col("CancelReason")], "");
eq("and the appointment stands again", sh.grid[1][col("Status")], "Scheduled");

// Nothing else on the row is touched.
sh = apptBook([AH, row("Checked In", "09:58")]);
setStatus(sh, { apptId: "A1", status: "Scheduled" });
eq("the patient, date and time on the row are untouched",
   sh.grid[1].slice(0, 5), ["A1", "2026-10-26", "KB1", "Asha", "10:00"]);

// Only the appointment asked for.
sh = apptBook([AH, row("Checked In", "09:58"),
               ["A2", "2026-10-26", "KB2", "Bina", "10:30", "Checked In", "10:29", "", "", ""]]);
setStatus(sh, { apptId: "A1", status: "Scheduled" });
eq("the other patient on the day sheet is left alone",
   sh.grid[2][col("CheckinTime")], "10:29");

r = setStatus(apptBook([AH, row("Checked In", "09:58")]), { apptId: "NOPE", status: "Scheduled" });
ok("an appointment that is not there is reported, not silently ignored",
   !r.success && /not found/.test(r.error), JSON.stringify(r));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
