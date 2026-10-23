// The case paper prints onto the clinic's pre-printed pad, so it has to keep
// clear of the letterhead at the top, the doctors down the left and the
// footer at the bottom. Those measurements belong to the PAD, not the app:
// when the pad is reprinted with a taller header they change, and that should
// be a ruler and a text box rather than a developer.
//
// The plumbing to send them already existed — the form listens for
// KB_PAD_MARGINS — but padMargins was state nothing ever filled, so the
// message never fired and the form always used the numbers compiled into it.
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

// ── reading a margin, run for real ────────────────────────────────────────
const padMm_ = new Function(
  GS.slice(GS.indexOf("function padMm_("), GS.indexOf("\n}", GS.indexOf("function padMm_(")) + 2) +
  "\nreturn padMm_;")();

eq("a plain number is millimetres", padMm_("15"), "15mm");
eq("so is one that says so", padMm_("15mm"), "15mm");
eq("spacing and case do not matter", padMm_("  15 MM "), "15mm");
eq("centimetres are converted", padMm_("1.5cm"), "15mm");
eq("and inches", padMm_("1in"), "25.4mm");
eq("a half millimetre survives", padMm_("13.5"), "13.5mm");
eq("zero is a real margin", padMm_("0"), "0mm");
eq("nothing is not", padMm_(""), "");
eq("nor is a word", padMm_("wide"), "");
eq("nor a negative", padMm_("-5"), "");
// A margin bigger than the sheet leaves nowhere to print, which prints blank
// pages and looks like the app is broken.
eq("a margin bigger than the page is refused", padMm_("500"), "");

// ── the store ─────────────────────────────────────────────────────────────
function boot(rows) {
  const sheet = {
    rows: rows.slice(),
    getDataRange: () => ({ getValues: () => sheet.rows }),
    clearContents: () => { sheet.rows = []; },
    getRange: () => ({ setValues: v => { sheet.rows = v; } }),
  };
  const code = GS.slice(GS.indexOf("var PAD_MARGINS_TAB"), GS.indexOf("var CLINIC_TIMINGS_TAB"));
  return { sheet, api: new Function("getSheet", code + "\nreturn { getPadMargins, savePadMargins };")(() => sheet) };
}
const HEAD = ["Setting", "Value", "Updated At"];

eq("an unset pad answers with the clinic's own measurements",
   boot([HEAD]).api.getPadMargins().margins,
   { top: "44mm", right: "15mm", bottom: "15mm", left: "52mm" });

let e = boot([HEAD, ["top", "40mm", ""], ["left", "50mm", ""], ["bottom", "13mm", ""], ["right", "12mm", ""]]);
eq("what is set comes back", e.api.getPadMargins().margins,
   { top: "40mm", right: "12mm", bottom: "13mm", left: "50mm" });

e = boot([HEAD, ["top", "40mm", ""]]);
eq("a side that was never set falls back rather than printing at the edge",
   e.api.getPadMargins().margins.left, "52mm");

e = boot([HEAD]);
let res = e.api.savePadMargins({ margins: JSON.stringify({ top: "40", right: "12", bottom: "13", left: "50" }) });
eq("saving normalises to millimetres", [res.success, res.margins.top], [true, "40mm"]);
eq("and it reads back", e.api.getPadMargins().margins.bottom, "13mm");

res = boot([HEAD, ["top", "44mm", ""]]).api.savePadMargins({ margins: JSON.stringify({ top: "wide", right: "12", bottom: "13", left: "50" }) });
eq("a margin that is not a measurement is refused", res.success, false);
ok("and the message names which one", /top/.test(res.error), res.error);
e = boot([HEAD, ["top", "44mm", ""]]);
e.api.savePadMargins({ margins: JSON.stringify({ top: "wide", right: "12", bottom: "13", left: "50" }) });
eq("with the tab left exactly as it was", e.sheet.rows, [HEAD, ["top", "44mm", ""]]);
eq("a payload that never arrived is refused too",
   boot([HEAD]).api.savePadMargins({}).success, false);

// ── it actually reaches the form now ──────────────────────────────────────
ok("the form's host fetches the margins", /api\("getPadMargins"\)\.then/.test(HTML));
ok("and the existing send fires once it has them",
   /React\.useEffect\(\(\) => \{ sendPadMarginsToForm\(\); \}, \[padMargins\]\);/.test(HTML));
ok("Master has a screen for them",
   /\{ id:"padMargins",    label:"Prescription Pad" \}/.test(HTML) &&
   /padMargins: \(\) => React\.createElement\(PadMarginsEditor/.test(HTML));
ok("it is loaded with the rest of the masters", /"getClinicTimings",\n      "getPadMargins"/.test(HTML));
ok("and saved through the checked save, like every other master",
   /persist\("savePadMargins"/.test(HTML));

const ed = HTML.slice(HTML.indexOf("function PadMarginsEditor"), HTML.indexOf("// When the day runs"));
ok("each side says what it is clearing", /clears the letterhead/.test(ed) && /clears the doctors' names/.test(ed) && /clears the footer/.test(ed));
ok("it shows what is left to print in", /to print in, on an A4 sheet/.test(ed));
ok("a margin larger than the page is refused before it is saved", /num\(k\) > 120/.test(ed));
ok("Save is dead until something changed", /!!bad \|\| !dirty/.test(ed));

// ── the form's own fallback ───────────────────────────────────────────────
const m = /const PRESCRIPTION_FORM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
const PRESC = Buffer.from((m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join(""), "base64").toString("utf8");
ok("the form still listens for them", /KB_PAD_MARGINS/.test(PRESC));
// The footer needs about 13mm; 18 threw away five on every sheet.
ok("and its fallback no longer wastes five millimetres at the foot",
   /bottom: '15mm'/.test(PRESC) && !/bottom: '18mm'/.test(PRESC));
ok("the other three are unchanged, because they were measured right",
   /top: '44mm'/.test(PRESC) && /left: '52mm'/.test(PRESC) && /right: '15mm'/.test(PRESC));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
