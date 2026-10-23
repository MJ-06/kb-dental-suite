// Registration asks whether the patient is private or on a panel, and which
// panel — but it only ever WROTE that when the answer was panel. A private
// patient's row carried a blank, which cannot be told apart from a patient
// nobody has got round to marking, so the CRM could not separate them with
// any confidence.
//
// It is data only. Nothing about the panel is printed: the registration slip
// is the same for both, and the panel belongs on the claim, not on the
// patient's own copy.
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

// ── a private patient is recorded as private ──────────────────────────────
// The rule the two save paths share, run rather than read.
const sent = (patientType, panel, q) => ({
  ...(patientType === "panel" ? {
    patientType: "Panel", panel: panel, panelCategory: q.panelCat, cardId: q.cardId.trim()
  } : patientType === "normal" ? { patientType: "Normal" } : {})
});
eq("a panel patient carries their panel, category and card",
   sent("panel", "CGHS", { panelCat: "Serving", cardId: " C-1 " }),
   { patientType: "Panel", panel: "CGHS", panelCategory: "Serving", cardId: "C-1" });
eq("a private patient is recorded as Normal, not as a blank",
   sent("normal", "", { panelCat: "", cardId: "" }), { patientType: "Normal" });
// The iPad form is opened from a link and knows neither, so it must send
// neither — or it would blank what the desk already recorded.
eq("a form that was never asked sends nothing, rather than guessing",
   sent("", "", { panelCat: "", cardId: "" }), {});

eq("both save paths use that rule", (HTML.match(/patientType === "normal" \? \{ patientType: "Normal" \}/g) || []).length, 2);

// ── the columns exist to receive it ───────────────────────────────────────
const fn = GS.slice(GS.indexOf("function saveRegistration(p)"), GS.indexOf("\n}", GS.indexOf("function saveRegistration(p)")));
const ensured = (fn.match(/ensureRegColumns_\(sh, \[[\s\S]*?\]\)/) || [""])[0];
ok("both books get the four columns, not only the panel one",
   ["Patient Type", "Panel", "Panel Category", "Card ID"].every(n => ensured.indexOf('"' + n + '"') >= 0),
   ensured);
ok("and it is no longer gated on the patient being a panel one",
   !/if \(isPanel\) ensureRegColumns_/.test(GS));
ok("the value is written to the Patient Type column", /"Patient Type": p\.patientType \|\| ""/.test(fn));

// ── it is shown at the desk ───────────────────────────────────────────────
ok("registration shows which kind of patient this is",
   /patientType === "panel" \? "PANEL" \+ \(panel \? " \\u00b7 " \+ panel : ""\) : "PRIVATE"/.test(HTML));
ok("as a badge rather than a sentence, so it reads across the desk",
   /borderRadius: 20,\n      background: patientType === "panel"/.test(HTML));
ok("and it can be changed before saving", /setPatientType\(""\); setPanel\(""\);/.test(HTML));

// ── and never printed ─────────────────────────────────────────────────────
const a = HTML.indexOf("  const buildPrintHTML = () => {");
const printBuilder = HTML.slice(a, HTML.indexOf("\n  };", a));
ok("the printed registration slip exists to check against", printBuilder.length > 2000);
eq("and says nothing about the panel, the card or the patient type",
   ["panel", "Panel", "patientType", "Patient Type", "cardId", "Card ID", "panelCat"]
     .filter(w => printBuilder.indexOf(w) >= 0), []);

// ── which is what lets the CRM separate them ──────────────────────────────
ok("the panel leaves the register with the patient",
   /panel: panelCol >= 0 \? String\(r\[panelCol\]\|\|""\)\.trim\(\) : ""/.test(GS));
// That rule lives inside the CRM's base64 blob, so it has to be decoded.
const m = /const CRM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
const CRM = Buffer.from((m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join(""), "base64").toString("utf8");
ok("and the CRM files a panel patient under their panel",
   /companyId: companyFor\(pt\.panel\)/.test(CRM));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
