// The appointment book was drawn from a fixed list in the code that ran
// 09:00 to 19:30 whatever the clinic actually did. The hours and the slot
// length are Master -> Schedule -> Clinic Timings now, so a clinic that opens
// at eight, or runs twenty-minute slots, is a master edit and not a release.
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

// ── the slot builder the book actually uses ───────────────────────────────
const front = new Function(
  HTML.slice(HTML.indexOf("const DEFAULT_TIMINGS ="), HTML.indexOf("let _timingsCache = null;")) +
  "\nreturn { buildSlots, hhmmToMin, TIME_SLOTS, DEFAULT_TIMINGS };")();
const { buildSlots, hhmmToMin, DEFAULT_TIMINGS } = front;

// What the clinic asked for: 9 to 7, half-hour slots.
const nine2seven = buildSlots({ open: "09:00", close: "19:00", slotMinutes: 30 });
eq("9:00 to 7:00 at 30 minutes is 20 slots", nine2seven.length, 20);
eq("the first is 09:00", nine2seven[0], "09:00");
eq("the last starts before closing, not at it", nine2seven[nine2seven.length - 1], "18:30");
ok("and 19:00 is not offered, because nothing could finish",
   nine2seven.indexOf("19:00") < 0, nine2seven.join(","));
eq("the default is that same day", buildSlots(DEFAULT_TIMINGS), nine2seven);

eq("a twenty-minute slot divides the day finer",
   buildSlots({ open: "09:00", close: "10:00", slotMinutes: 20 }), ["09:00", "09:20", "09:40"]);
eq("an hour-long slot works too",
   buildSlots({ open: "08:00", close: "11:00", slotMinutes: 60 }), ["08:00", "09:00", "10:00"]);
eq("times are padded, so they sort and compare",
   buildSlots({ open: "8:00", close: "9:30", slotMinutes: 45 }), ["08:00", "08:45"]);

// Anything that would draw an empty book, or never stop drawing, falls back
// rather than leaving the clinic unable to see the day.
const fallback = front.TIME_SLOTS;
eq("closing before opening falls back", buildSlots({ open: "19:00", close: "09:00", slotMinutes: 30 }), fallback);
eq("a zero-minute slot falls back", buildSlots({ open: "09:00", close: "19:00", slotMinutes: 0 }), fallback);
eq("so does a negative one", buildSlots({ open: "09:00", close: "19:00", slotMinutes: -30 }), fallback);
eq("and nonsense for a time", buildSlots({ open: "half nine", close: "19:00", slotMinutes: 30 }), fallback);
eq("and nothing at all", buildSlots(null), fallback);
ok("25:00 is not a time", isNaN(hhmmToMin("25:00")));

// ── the backend ───────────────────────────────────────────────────────────
function boot(rows) {
  const sheet = {
    rows: rows.slice(),
    getDataRange: () => ({ getValues: () => sheet.rows }),
    clearContents: () => { sheet.rows = []; },
    getRange: () => ({ setValues: v => { sheet.rows = v; } }),
  };
  const code = GS.slice(GS.indexOf("var CLINIC_TIMINGS_TAB"), GS.indexOf("var WORKING_DAYS_TAB"));
  const api = new Function("getSheet", "Utilities", "Session",
    code + "\nreturn { getClinicTimings, saveClinicTimings, hhmm_ };")(
    () => sheet,
    { formatDate: (d) => d.toISOString().slice(11, 16) },
    { getScriptTimeZone: () => "Asia/Kolkata" });
  return { sheet, api };
}
const HEAD = ["Setting", "Value", "Updated At"];

let e = boot([HEAD, ["Open", "09:00", ""], ["Close", "19:00", ""], ["Slot Minutes", 30, ""]]);
eq("the sheet's timings come back", e.api.getClinicTimings(),
   { success: true, open: "09:00", close: "19:00", slotMinutes: 30 });

eq("an unfilled tab answers with the usual clinic day, not an empty book",
   boot([HEAD]).api.getClinicTimings(),
   { success: true, open: "09:00", close: "19:00", slotMinutes: 30 });

// Sheets turns something that looks like a time into a Date; both forms have
// to end up as "HH:MM" or the book draws nothing.
e = boot([HEAD, ["Open", new Date("2026-01-01T08:30:00Z"), ""], ["Close", "17:00", ""], ["Slot Minutes", 20, ""]]);
eq("a time cell that is a real Date still reads as a time",
   e.api.getClinicTimings(), { success: true, open: "08:30", close: "17:00", slotMinutes: 20 });

e = boot([HEAD]);
eq("saving reports success",
   e.api.saveClinicTimings({ open: "09:00", close: "19:00", slotMinutes: "30" }).success, true);
ok("the time is written as text, so Sheets cannot reformat it under us",
   e.sheet.rows.some(r => r[0] === "Open" && r[1] === "'09:00"), JSON.stringify(e.sheet.rows));
eq("and it reads back as what was saved",
   boot(e.sheet.rows.map(r => [r[0], String(r[1]).replace(/^'/, ""), r[2]])).api.getClinicTimings(),
   { success: true, open: "09:00", close: "19:00", slotMinutes: 30 });

e = boot([HEAD, ["Open", "09:00", ""]]);
let res = e.api.saveClinicTimings({ open: "19:00", close: "09:00", slotMinutes: "30" });
eq("closing before opening is refused", res.success, false);
ok("and says why", /cannot close before it opens/.test(res.error), res.error);
eq("with the tab left exactly as it was", e.sheet.rows, [HEAD, ["Open", "09:00", ""]]);
eq("a zero-minute slot is refused",
   e.api.saveClinicTimings({ open: "09:00", close: "19:00", slotMinutes: "0" }).success, false);
eq("and a time that is not a time",
   e.api.saveClinicTimings({ open: "soon", close: "19:00", slotMinutes: "30" }).success, false);

// ── the screens ───────────────────────────────────────────────────────────
ok("Clinic Timings is a real tab now, not a placeholder",
   /\{ id:"clinicTimings", label:"Clinic Timings" \}/.test(HTML));
ok("wired to its editor", /clinicTimings: \(\) => React\.createElement\(ClinicTimingsEditor/.test(HTML));
ok("the master loads it", /"getWorkingDays", "getClinicTimings"/.test(HTML));
ok("and destructures it in the same position", /pnl,wd,ct\]\) =>/.test(HTML));
ok("the appointment book reads the master, not the fixed list",
   /function Appointments\(\{[^}]*\}\) \{\n  const \{ slots: TIME_SLOTS \} = useClinicTimings\(\);/.test(HTML));
ok("and so does the quick-booking box",
   /function QuickApptModal\(\{[^}]*\}\) \{\n  const \{ slots: TIME_SLOTS \} = useClinicTimings\(\);/.test(HTML));
ok("the timings are fetched once per page and shared",
   /let _timingsCache = null;/.test(HTML) && /_timingsCache \|\| DEFAULT_TIMINGS/.test(HTML));
ok("and a save refreshes that copy, so the columns change without a reload",
   /if \(saved\) _timingsCache = next;/.test(HTML));

const ed = HTML.slice(HTML.indexOf("function ClinicTimingsEditor"),
                      HTML.indexOf("// Which days the clinic is closed"));
ok("it refuses to save a day that closes before it opens",
   /b <= a \? "The clinic cannot close before it opens."/.test(ed));
ok("Save is dead until something actually changed", /!!bad \|\| !dirty/.test(ed));
ok("and it shows the slots it is about to make",
   /preview\.map\(t =>/.test(ed) && /" slots a day/.test(ed));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
