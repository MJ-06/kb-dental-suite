// The clinic's closed days — the weekly offs and the dated holidays — live in
// the Management Suite's Leave & Attendance, which is one browser's storage
// on one machine. They are copied into the PMS master once, so every machine
// sees the same days and the PMS carries no dependency on that other app
// still being installed. That matters: the app is to be sold, and a customer
// will not have a Management Suite.
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

// ── the backend, run for real against a stand-in sheet ────────────────────
function boot(rows) {
  const sheet = {
    rows: rows.slice(),
    getDataRange: () => ({ getValues: () => sheet.rows }),
    clearContents: () => { sheet.rows = []; },
    getRange: () => ({ setValues: v => { sheet.rows = v; } }),
  };
  const code = GS.slice(GS.indexOf("function parseList_("), GS.indexOf("function getDocumentCategoriesList(")) +
               GS.slice(GS.indexOf("var WORKING_DAYS_TAB"), GS.indexOf("function getChairsList()"));
  const api = new Function("getSheet", "Utilities", "Session",
    code + "\nreturn { getWorkingDays, saveWorkingDays, isoDay_ };")(
    () => sheet,
    { formatDate: (d) => d.toISOString().slice(0, 10) },
    { getScriptTimeZone: () => "Asia/Kolkata" });
  return { sheet, api };
}

const HEAD = ["Type", "Day / Date", "Name", "Updated At"];
let e = boot([HEAD,
  ["Week Off", 0, "Sunday", ""],
  ["Holiday", "2026-11-08", "Diwali", ""],
  ["Holiday", "2026-01-26", "Republic Day", ""]]);
let got = e.api.getWorkingDays();
eq("the weekly offs come back as day numbers", got.weekOff, [0]);
eq("and the holidays in date order",
   got.holidays, [{ date: "2026-01-26", name: "Republic Day" },
                  { date: "2026-11-08", name: "Diwali" }]);

e = boot([HEAD, ["Week Off", "Wednesday", "", ""]]);
eq("a day written by name is read too, not dropped", e.api.getWorkingDays().weekOff, [3]);

e = boot([HEAD, ["Week Off", 0, "Sunday", ""], ["Week Off", 0, "Sunday", ""]]);
eq("a day listed twice counts once", e.api.getWorkingDays().weekOff, [0]);

// A date cell can come back as a Date object rather than text; the app
// compares "YYYY-MM-DD" strings, so one has to be made.
e = boot([HEAD, ["Holiday", new Date("2026-11-08T00:00:00Z"), "Diwali", ""]]);
eq("a date cell that is a real Date still reads as the day",
   e.api.getWorkingDays().holidays, [{ date: "2026-11-08", name: "Diwali" }]);

eq("an empty tab means open every day, not an invented week",
   boot([HEAD]).api.getWorkingDays(), { success: true, weekOff: [], holidays: [] });

// ── saving ────────────────────────────────────────────────────────────────
e = boot([HEAD, ["Week Off", 0, "Sunday", ""]]);
let res = e.api.saveWorkingDays({
  weekOff: JSON.stringify([0, 3]),
  holidays: JSON.stringify([{ date: "2026-11-08", name: "Diwali" }]),
});
eq("a save reports success", res.success, true);
eq("it writes the header back", e.sheet.rows[0], HEAD);
eq("a week off row names the day for whoever opens the sheet",
   e.sheet.rows.filter(r => r[0] === "Week Off").map(r => [r[1], r[2]]), [[0, "Sunday"], [3, "Wednesday"]]);
ok("a holiday date is written as text, so Sheets cannot reformat it under us",
   e.sheet.rows.some(r => r[0] === "Holiday" && r[1] === "'2026-11-08"),
   JSON.stringify(e.sheet.rows));
eq("and it reads back as what was saved",
   boot(e.sheet.rows.map(r => [r[0], String(r[1]).replace(/^'/, ""), r[2], r[3]])).api.getWorkingDays().holidays,
   [{ date: "2026-11-08", name: "Diwali" }]);

// Emptying both is legitimate — a clinic open every day with no holidays.
e = boot([HEAD, ["Week Off", 0, "Sunday", ""]]);
eq("clearing both is allowed",
   e.api.saveWorkingDays({ weekOff: "[]", holidays: "[]" }).success, true);

// But a payload that went missing must not be read as "open every day".
e = boot([HEAD, ["Week Off", 0, "Sunday", ""]]);
res = e.api.saveWorkingDays({ holidays: "[]" });
eq("a missing week-off payload is refused", res.success, false);
ok("and it says so", /never reached the sheet/.test(res.error), res.error);
eq("with the tab left exactly as it was",
   e.sheet.rows, [HEAD, ["Week Off", 0, "Sunday", ""]]);

e = boot([HEAD]);
res = e.api.saveWorkingDays({ weekOff: "[0]", holidays: '[{"date":"2026-11-0' });
eq("a holiday list cut short in transit is refused too", res.success, false);

// ── the screen ────────────────────────────────────────────────────────────
ok("Working Days is a real tab now, not a placeholder",
   /\{ id:"workingDays",   label:"Working Days" \}/.test(HTML));
ok("it is wired to the editor", /workingDays: \(\) => React\.createElement\(WorkingDaysEditor/.test(HTML));
ok("the master asks the backend for it", /"getPanelsList", "getWorkingDays"/.test(HTML));
ok("and destructures it in the same position", /pnl,wd\]\) =>/.test(HTML));
ok("an older backend leaves the clinic open rather than inventing a week",
   /if \(wd && wd\.success\) \{ setWeekOff/.test(HTML));

const ed = HTML.slice(HTML.indexOf("function WorkingDaysEditor"),
                      HTML.indexOf("// Name + Default Dosage/Frequency list editor"));
ok("all seven days can be toggled", /WD_DAYS\.map\(\(d, n\) =>/.test(ed));
ok("a holiday can be added with a date and a name", /const addHoliday = \(\) =>/.test(ed));
ok("adding a date already listed renames it instead of doubling it",
   /holidays\.filter\(h => txt\(h\.date\)\.trim\(\) !== d\)/.test(ed));
ok("a holiday can be edited", /const saveEdit = \(i\) =>/.test(ed) && /\}, "Edit"\)/.test(ed));
ok("and removed, asking first", /window\.confirm\("Remove "/.test(ed));
ok("Edit and Remove sit side by side", /"Edit"\)[\s\S]{0,500}"Remove"\)/.test(ed));
ok("sheet values are made text before they are touched",
   /const txt = \(v\) => \(v === undefined \|\| v === null\) \? "" : String\(v\);/.test(ed));
ok("the two halves are saved together, as one answer",
   /persist\("saveWorkingDays",[\s\S]{0,160}weekOff: JSON\.stringify\(days\), holidays: JSON\.stringify\(hols\)/.test(HTML));
ok("and a failed save puts the holidays back too",
   /if \(!saved\) setHolidays\(prevHols\);/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
