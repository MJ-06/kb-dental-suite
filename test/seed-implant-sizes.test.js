// The clinic sent its Nobel Biocare size list as a spreadsheet, so nobody
// should have to retype 103 sizes into the master by hand. seed-implant-sizes.gs
// carries the lot. That makes the script itself the thing that can be wrong,
// so it is checked against the sheet it was generated from, line by line.
const fs = require("fs");
const path = require("path");
const GS = fs.readFileSync(path.resolve(__dirname, "../apps-script/maintenance/seed-implant-sizes.gs"), "utf8");
const SRC = fs.readFileSync(path.resolve(__dirname, "../reference/implant-sizes-nobel.txt"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

const lines = new Function(GS.slice(GS.indexOf("var LINES = ["),
                                    GS.indexOf("];", GS.indexOf("var LINES = [")) + 2) +
                           "\nreturn LINES;")();

// reference/implant-sizes-nobel.txt is Sheet1 of the workbook, exactly as it
// came: a header and one row per size.
const rows = SRC.trim().split(/\n/).slice(1).map(l => l.split("\t").map(s => s.trim()));
eq("the reference is the clinic's 105-row sheet", rows.length + 1, 105);

const want = new Map();
rows.forEach(([name, size]) => {
  if (!want.has(name)) want.set(name, []);
  const seen = want.get(name);
  if (seen.indexOf(size) < 0) seen.push(size);   // the sheet repeats RP 4.3*11.5
});

eq("one row per product line, as the sheet groups them", lines.length, want.size);
eq("the five Nobel lines", lines.map(l => l[0]), [...want.keys()]);

let badSizes = 0;
lines.forEach(([name, sizes]) => {
  if (JSON.stringify(sizes.split(", ")) !== JSON.stringify(want.get(name))) badSizes++;
});
eq("every size matches the sheet, in the sheet's order", badSizes, 0);

const total = lines.reduce((n, l) => n + l[1].split(", ").length, 0);
eq("103 sizes in all, the sheet's 104 rows less its one repeat", total, 103);

// Spot checks a human can verify against the workbook by eye.
const by = n => lines.find(l => l[0] === n)[1].split(", ");
eq("Nobel Active carries 33", by("Nobel Active").length, 33);
eq("Nobel Parallel CC carries 27", by("Nobel Parallel CC").length, 27);
eq("Nobel Replace CC carries 15", by("Nobel Replace CC").length, 15);
eq("Nobel Replace Select carries 20", by("Nobel Replace Select").length, 20);
eq("Replact Select TC carries 8", by("Replact Select TC").length, 8);
ok("sizes are kept as written, so the form matches the shelf",
   by("Nobel Active").indexOf("3.0*10mm") === 0);

ok("no line is listed twice", new Set(lines.map(l => l[0])).size === lines.length);
ok("no size is listed twice within a line",
   lines.every(l => new Set(l[1].split(", ")).size === l[1].split(", ").length));

// The safety rules the script is built on.
ok("it refuses to run until it is confirmed", /CONFIRM !== "YES"/.test(GS));
ok("it keeps other brands' rows", /!names\[String\(data\[i\]\[0\]\)/.test(GS));
ok("and writes in one go rather than row by row", /setValues\(out\)/.test(GS));
ok("it is for the main book, where the masters live", /MAIN PMS book/.test(GS));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
