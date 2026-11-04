// Two things the clinic asked for, after Implant Surgery's sheet turned into
// 32 rows in one run: group the parameters under headings like RCT's, and give
// them a way to put data on the sheet so the print layout can be checked.
//
// The first exposed a worse fault. CR_CFG.topFields was NOT what the sheet
// renders — those rows are written out by hand — so the parameters "added" to
// the config in the previous change never reached paper at all: 24 of 32 on
// Implant Surgery, 12 each on the other two, including anaesthesia type,
// quantity and method, and the clinical notes, on all three.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + String(detail).slice(0, 240) : "")); }
};
function blob(name) {
  const m = src.match(new RegExp("const " + name + "\\s*=\\s*((?:\"[^\"]*\"\\s*\\+?\\s*)+);"));
  const b64 = (m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join("");
  return Buffer.from(b64, "base64").toString("utf8");
}

const FORMS = [
  // 7 -> 8 when Second Stage Surgery was added: the uncovering happens
  // months after placement and has its own flap, abutment and suture, so it
  // is a section rather than more boxes on the surgery that placed it.
  ["Implant Surgery",   "IMP_SURGERY_B64",    8, ["ANAESTHESIA","SUTURE","GRAFT / MEMBRANE / MESH","SECOND STAGE SURGERY"]],
  ["Implant Prosthetic","IMP_PROSTHETIC_B64", 4, ["ANAESTHESIA","PROSTHESIS DETAIL","NOTES"]],
  ["Crown & Bridge",    "CROWN_BRIDGE_B64",   5, ["ANAESTHESIA","PREPARATION & RETRACTION","LABORATORY"]],
];

FORMS.forEach(([label, name, nSections, titles]) => {
  const h = blob(name);
  const cfg = JSON.parse(h.match(/var CR_CFG = (\{[\s\S]*?\});/)[1]);

  ok(label + ": the extra parameters are grouped into sections",
     Array.isArray(cfg.extraSections) && cfg.extraSections.length === nSections,
     String(cfg.extraSections && cfg.extraSections.length));
  titles.forEach(t =>
    ok(label + ": has a " + t + " heading",
       (cfg.extraSections || []).some(s => s.title === t)));

  // The point of the exercise: they must actually be rendered.
  ok(label + ": the sheet renders those sections",
     /\(CR_CFG\.extraSections\|\|\[\]\)\.forEach/.test(h));
  ok(label + ": under a section heading, not run on",
     /t\+=sh\(sec\.title\)/.test(h));
  // An empty heading on a printed record is noise.
  ok(label + ": a section with nothing in it is left off",
     /if\(!any\) return;/.test(h));

  // Every parameter the form saves must appear in a section or already be a row.
  const bodyA = h.indexOf("function renderClinRec()"), bodyB = h.indexOf("function crShow(");
  const body = h.slice(bodyA, bodyB);
  // Some rows read the record directly (rec.coverType, rec.finalImp) instead of
  // going through sv(), so both spellings count as printed. Matching only sv()
  // reported four fields as missing that are on the sheet.
  const hardcoded = new Set(
    (body.match(/sv\('(\w+)'\)/g) || []).map(x => x.slice(4, -2))
      .concat((body.match(/rec\.(\w+)/g) || []).map(x => x.slice(4))));
  const grouped = new Set([].concat(...(cfg.extraSections || []).map(s => s.fields.map(p => p[0]))));
  const missing = cfg.topFields.map(p => p[0]).filter(k => !hardcoded.has(k) && !grouped.has(k));
  ok(label + ": no parameter is left off the sheet", missing.length === 0, missing.join(", "));

  // The sample used to live here too, which meant two buttons printing the
  // same layout from different places. It is on the sheets screen only now —
  // the one place that can also do Restoration and Pedo, which print from the
  // parent app rather than from a form. print-sample-every-sheet covers it.
  ok(label + ": the form no longer carries its own sample button",
     h.indexOf("loadSample") === -1);
});

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("==============================================================================");
process.exit(fail ? 1 : 0);
