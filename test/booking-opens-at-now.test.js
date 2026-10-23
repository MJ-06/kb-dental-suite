// A walk-in seen at five in the evening was offered ten in the morning. The
// booking time was hardcoded "10:00": Appointments' resetForm never touched
// it at all, so it kept the initial value, and the quick/walk-in form reset
// to 10:00 on every open. Somebody had to correct it every single time.
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

// The rule itself, pulled out of the page and run.
function slice(marker) {
  const i = html.indexOf(marker);
  if (i < 0) throw new Error("not found: " + marker);
  return html.slice(i, html.indexOf("\n}", i) + 2);
}
const SRC = slice("function hhmmToMin(") + slice("function isoDateLocal(") +
            slice("function slotForNow(");
const slotForNow = new Function("TIME_SLOTS",
  SRC + "\nreturn slotForNow;")(["09:00", "09:30", "10:00"]);

// The clinic's real day: 9am to 7pm, half-hour slots.
const SLOTS = [];
for (let m = 9 * 60; m < 19 * 60; m += 30) {
  SLOTS.push(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
}
const at = (h, mi, dateISO) => slotForNow(SLOTS, dateISO || "2026-10-23", new Date(2026, 9, 23, h, mi));

// ── the complaint, exactly ────────────────────────────────────────────────
eq("a walk-in at 5pm opens at 5pm, not ten in the morning", at(17, 0), "17:00");
eq("and at 5:05pm, still the slot they are standing in", at(17, 5), "17:00");
eq("at 5:29 it has not jumped ahead to the next slot", at(17, 29), "17:00");
eq("at 5:30 it moves on", at(17, 30), "17:30");
eq("first thing, nine o'clock", at(9, 0), "09:00");
eq("mid-morning", at(11, 20), "11:00");

// ── outside the clinic's hours ───────────────────────────────────────────
eq("before opening, the day starts at its first slot", at(7, 30), "09:00");
eq("right up to the minute it opens", at(8, 59), "09:00");
eq("after closing, the last slot rather than a time nobody chose", at(20, 15), "18:30");

// ── another day has no "now" to use ──────────────────────────────────────
eq("a booking for tomorrow opens at the first slot", at(17, 0, "2026-10-24"), "09:00");
eq("and so does one for last week", at(17, 0, "2026-10-20"), "09:00");

// ── a clinic with different hours ────────────────────────────────────────
const EVE = ["14:00", "15:00", "16:00", "17:00"];
eq("the slots are the clinic's, not a fixed nine-to-seven",
   slotForNow(EVE, "2026-10-23", new Date(2026, 9, 23, 16, 45)), "16:00");
eq("and before they start, the first of them",
   slotForNow(EVE, "2026-10-23", new Date(2026, 9, 23, 9, 0)), "14:00");

// ── nothing to pick from ─────────────────────────────────────────────────
ok("an empty slot list falls back rather than returning nothing",
   !!slotForNow([], "2026-10-23", new Date(2026, 9, 23, 17, 0)));

// The date is compared in LOCAL time. toISOString() would call the evening of
// the 23rd in India the 23rd until 05:30, then still the 23rd -- but an
// appointment booked at 11pm IST is on the 24th by UTC, and the form would
// silently decide "not today" and open at 9am.
ok("today is judged in local time, not UTC",
   /isoDateLocal\(when\)/.test(SRC), SRC.slice(SRC.indexOf("function slotForNow")));
eq("so a late evening booking is still today",
   slotForNow(SLOTS, "2026-10-23", new Date(2026, 9, 23, 23, 30)), "18:30");

// ── and the page actually uses it ────────────────────────────────────────
ok("the walk-in form no longer resets to a hardcoded ten o'clock",
   !/setFTime\("10:00"\)/.test(html));
ok("nor does anything else", html.indexOf('"10:00"') < 0 || !/fTime.*"10:00"/.test(html));
ok("Appointments resets the time along with the rest of the form",
   /setFTime\(slotForNow\(TIME_SLOTS, selDate\)\)/.test(html));
ok("the walk-in form opens on it too",
   /setFTime\(slotForNow\(TIME_SLOTS, defaultDate\)\)/.test(html));
ok("and the very first render is right, not corrected afterwards",
   /useState\(\(\) => slotForNow\(TIME_SLOTS, selDate\)\)/.test(html) &&
   /React\.useState\(\(\) => slotForNow\(TIME_SLOTS, defaultDate\)\)/.test(html));
// Clicking a box on the grid must still win over the clock.
ok("clicking a slot on the grid still books that slot",
   /if \(time\) setFTime\(time\);/.test(html));
ok("and editing a booking keeps the time it already had",
   /setFTime\(a\.time \|\| slotForNow\(/.test(html));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
