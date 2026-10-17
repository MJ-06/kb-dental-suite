// The Working Days master held the closed days but nothing consulted them, so
// a receptionist could still book a patient into Diwali. Booking is now
// refused on a weekly off or a holiday, in the app and again in the sheet.
//
// A walk-in is deliberately exempt. It records a patient who actually came —
// a fact about the past, not a booking — and an emergency seen on a holiday
// must still be recordable, or the register lies about the day.
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

// ── the app's own rule, run for real ──────────────────────────────────────
const closedReasonFor = new Function(
  'const WD_DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];' +
  HTML.slice(HTML.indexOf("function closedReasonFor("), HTML.indexOf("function useWorkingDays(")) +
  "\nreturn closedReasonFor;")();

const SUNDAY = [0], HOLS = [{ date: "2026-11-08", name: "Diwali" }];
eq("an ordinary Thursday is open", closedReasonFor("2026-10-15", SUNDAY, HOLS), "");
eq("a weekly off says which day it is", closedReasonFor("2026-10-18", SUNDAY, HOLS), "Sunday — weekly off");
eq("a holiday says what it is", closedReasonFor("2026-11-08", SUNDAY, HOLS), "Diwali — holiday");
eq("a holiday with no name still closes the day",
   closedReasonFor("2026-11-08", [], [{ date: "2026-11-08", name: "" }]), "Holiday — holiday");
// 2026-11-08 is itself a Sunday; the holiday is the more useful thing to say.
eq("a holiday falling on a weekly off is named as the holiday",
   closedReasonFor("2026-11-08", SUNDAY, HOLS), "Diwali — holiday");
eq("nothing configured means open", closedReasonFor("2026-10-18", [], []), "");
eq("rubbish for a date is not treated as closed", closedReasonFor("", SUNDAY, HOLS), "");
eq("nor a half-written one", closedReasonFor("2026-11", SUNDAY, HOLS), "");

// A date read as UTC lands on the previous day east of Greenwich, which would
// close the wrong day — the parse has to be local.
eq("the day is worked out locally, not in UTC",
   closedReasonFor("2026-10-19", [1], []), "Monday — weekly off");

// ── the backend's rule, run for real ──────────────────────────────────────
const backend = new Function("getWorkingDays",
  'var WD_DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];' +
  GS.slice(GS.indexOf("function closedReason_("), GS.indexOf("function saveAppointment(")) +
  "\nreturn closedReason_;");
const closed_ = backend(() => ({ weekOff: [0], holidays: [{ date: "2026-11-08", name: "Diwali" }] }));
eq("the sheet agrees about a weekly off", closed_("2026-10-18"), "Sunday (weekly off)");
eq("and about a holiday", closed_("2026-11-08"), "Diwali (holiday)");
eq("and about an open day", closed_("2026-10-15"), "");
// If the working-days read fails, booking must not stop clinic-wide.
eq("a failed read never blocks the clinic",
   backend(() => { throw new Error("sheet unreachable"); })("2026-10-18"), "");

// ── where it is applied ───────────────────────────────────────────────────
const appts = HTML.slice(HTML.indexOf("function Appointments({"),
                         HTML.indexOf("function QuickApptModal({"));
ok("the booking form knows the closed days", /const \{ closedReason \} = useWorkingDays\(\);/.test(appts));
ok("and refuses to save into one",
   /const shut = closedReason\(fDate\);\n    if \(shut\) e\.date = "The clinic is closed/.test(appts));
ok("it says so when the date is picked, not only when Save is pressed",
   /const dateClosedNotice = \(\) =>/.test(appts) && /dateClosedNotice\(\),/.test(appts));
ok("the day's grid carries a banner", /"Clinic closed \\u2014 " \+ closedReason\(selDate\)/.test(appts));
ok("and its empty cells are shown shut rather than inviting a click",
   /isBlocked\(chair, slot\) \|\| !!closedReason\(selDate\)/.test(appts));
ok("a shut cell explains itself instead of reading \"Blocked:\" with nothing after it",
   /title: closedReason\(selDate\) \? "Clinic closed/.test(appts));

ok("the sheet refuses a booking on a closed day",
   /if \(!p\.walkIn\) \{\n    var shut = closedReason_\(p\.date\);/.test(GS));
ok("and refuses to reschedule one onto a closed day",
   /function updateAppointment\(p\) \{[\s\S]{0,400}closedReason_\(p\.date\)/.test(GS));

// ── the walk-in exemption, deliberately ───────────────────────────────────
ok("a walk-in is exempt in the sheet", /if \(!p\.walkIn\)/.test(GS));
ok("the Daily Register marks its entries as walk-ins",
   /notes: "Walk-in — added from Daily Register", status: "Scheduled",[\s\S]{0,260}walkIn: true/.test(HTML));
ok("and so does the quick-add box at the desk",
   /status: "Scheduled",[\s\S]{0,260}walkIn: true\n    \};/.test(HTML));
const quick = HTML.slice(HTML.indexOf("function QuickApptModal({"));
ok("the quick-add box does not block, because the patient is already there",
   !/const shut = closedReason\(fDate\)/.test(quick.slice(0, quick.indexOf("const apptPayload"))));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
