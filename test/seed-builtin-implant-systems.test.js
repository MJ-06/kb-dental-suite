// The implant systems the forms carried built in belong in Master too, or the
// master is Nobel and nothing else while the forms quietly know about six
// more. seed-builtin-implant-systems.gs moves them across, so the generated
// script is checked against the catalogue inside the form itself — if one is
// ever edited without the other, this says so.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const GS = fs.readFileSync(path.join(REPO, "apps-script/maintenance/seed-builtin-implant-systems.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

function formText(blob) {
  const m = new RegExp("const " + blob + "\\s*=\\s*([\\s\\S]*?);\\n").exec(HTML);
  const b64 = (m[1].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)).join("");
  return Buffer.from(b64, "base64").toString("utf8");
}

// The catalogue as the Implant Surgery form really declares it.
const imps = formText("IMP_SURGERY_B64");
const catSrc = imps.slice(imps.indexOf("sizeCatalogue._c={"), imps.indexOf("};", imps.indexOf("sizeCatalogue._c={")) + 2);
const cat = new Function("return " + catSrc.replace("sizeCatalogue._c=", ""))();

const systems = new Function(GS.slice(GS.indexOf("var SYSTEMS = ["),
                                      GS.indexOf("];", GS.indexOf("var SYSTEMS = [")) + 2) +
                             "\nreturn SYSTEMS;")();

const num = x => (x === Math.trunc(x) ? String(Math.trunc(x)) : String(x));
const expand = c => {
  const out = [];
  c.d.forEach(d => c.l.forEach(l => out.push(num(d) + " × " + num(l) + " mm")));
  return out;
};

const nobel = Object.keys(cat).filter(n => /^Nobel/.test(n));
const others = Object.keys(cat).filter(n => !/^Nobel/.test(n));

eq("every non-Nobel built-in system is seeded", systems.map(s => s[0]), others);
eq("and that is six", systems.length, 6);

// The clinic's own Nobel sheet is already in the master with the real
// catalogue numbers. The built-in Nobel entries are a generic
// diameter-by-length grid, and writing them over it would trade real sizes
// for invented ones.
ok("the built-in Nobel grids are deliberately left out",
   nobel.length > 0 && systems.every(s => !/^Nobel/.test(s[0])), nobel.join(", "));

let bad = 0;
systems.forEach(([name, sizes]) => {
  if (JSON.stringify(sizes.split(", ")) !== JSON.stringify(expand(cat[name]))) bad++;
});
eq("every size is the form's own grid, multiplied out", bad, 0);

const by = n => systems.find(s => s[0] === n)[1].split(", ");
eq("Straumann is 3 diameters x 5 lengths", by("Straumann").length, 15);
eq("and reads the way the form wrote it", by("Straumann")[0], "3.3 × 6 mm");
eq("Ifix is 4 x 4", by("Ifix").length, 16);
eq("Osstem is 5 x 5", by("Osstem").length, 25);
ok("a whole number keeps no decimal point", by("Straumann").indexOf("3.3 × 10 mm") >= 0,
   by("Straumann").join(" | "));

ok("no system is listed twice", new Set(systems.map(s => s[0])).size === systems.length);
ok("no size is listed twice within a system",
   systems.every(s => new Set(s[1].split(", ")).size === s[1].split(", ").length));

// The safety rules the script is built on.
ok("it refuses to run until it is confirmed", /CONFIRM !== "YES"/.test(GS));
ok("it keeps the Nobel rows and any other brand", /!names\[String\(data\[i\]\[0\]\)/.test(GS));
ok("and writes in one go rather than row by row", /setValues\(out\)/.test(GS));
ok("it is for the main book, where the masters live", /MAIN PMS book/.test(GS));
ok("it says these are published ranges, not what is on the shelf",
   /not what is on the shelf/.test(GS));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
