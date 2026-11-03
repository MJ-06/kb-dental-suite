// "I just wanted the endorsement part, and in panel cases I did not need to
//  fill up the care plan — it was to be direct endorsement."
//
// A panel case does not go through the Care Plan at all. The endorsement IS
// the plan: a treatment is entered on Document 3, priced at the panel's
// rate, and sent. Nothing about it belongs on the clinic's own treatment
// plan or its estimate, which are priced at the clinic's fees.
//
// It was the opposite of that. The endorsement's lines were the treatment
// plan's lines, so a line entered for a panel ended up on Document 1 and in
// Document 2's totals, and Document 1's "nothing on this patient's Care
// Plan to bring in" notice sat at the top of the endorsement.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; } else {
    fail++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : ''));
  }
};

// ── the Care Plan's messages stay on the Care Plan's documents ──────────
ok('the Care Plan hand-off notice is not shown on the endorsement',
   /seedMsg && view !== "endorsement" &&/.test(html));

// ── a line entered on the endorsement stays there ───────────────────────
ok('the plan documents work from their own rows',
   /const planRows = tpRows\.filter\(r => !r\.endAdded\);/.test(html));
ok('the estimate is totalled from those only',
   /const selRows = planRows\.filter\(r => r\.selected && r\.procedure\);/.test(html));
ok('the printed plan lists those only',
   /const pr = planRows\.filter\(r => r\.phase === phase && r\.procedure\);/.test(html));
ok('the printed plan charts those teeth only',
   /toothG\(planRows\)/.test(html));
ok("Document 1's own list shows those only",
   /\}, "Load a patient to begin\."\) : planRows\.map\(r =>/.test(html) &&
   /\}, planRows\.length === 0 \?/.test(html));
ok("Document 1's tooth chart too",
   /React\.createElement\(ToothChart, \{\n    rows: planRows,/.test(html));
ok('and the saved estimate is not inflated by endorsement lines',
   /const selRows = tpRows\.filter\(r => r\.selected && r\.procedure && !r\.endAdded\);/.test(html));

// ── and the endorsement needs nothing filled in first ───────────────────
ok('a line can be started on the endorsement itself',
   /selected: true, endAdded: true/.test(html));
ok('and it reaches the sheet without Document 1',
   /x\.r\.selected && \(x\.r\.procedure \|\| x\.r\.endAdded\)/.test(html));

// ── nothing on the endorsement depends on master data being set up ──────
// The clinic that has not pasted its CGHS rate card in yet still has to be
// able to send a sheet. Every field is typed; the card only suggests.
ok('the code is typed, with the rate card as suggestions',
   /list: "kb-panel-codes"/.test(html) && /React\.createElement\("datalist", \{ id:"kb-panel-codes" \}/.test(html));
ok('the treatment is typed when no card names it',
   /onChange: e => setRowField\(x\.at, "procedure", e\.target\.value\)/.test(html));
ok('the rate is typed when no card carries it',
   /onChange: e => setRowField\(x\.at, "cghsRate", e\.target\.value\.replace\(\/\[\^0-9\.\]\/g, ""\)\)/.test(html));
ok('a typed rate prices the line just like a looked-up one',
   /const typed = Number\(String\(x\.r\.cghsRate == null \? "" : x\.r\.cghsRate\)\.trim\(\)\);/.test(html));

// ── and the panel reaches it on the backend the clinic already has ──────
// getPatient was taught to return the panel, but that needs a redeploy on
// two deployments. getAllPatients has carried it for a long time.
ok('the panel is read from the register when the patient does not carry one',
   /api\("getAllPatients"\)\.then\(res => \{[\s\S]{0,400}?setPanelFallback\(hit/.test(html));
ok('and it is asked for only on this document, and only once',
   /if \(view !== "endorsement" \|\| !pat \|\| !pat\.uhid\) return;/.test(html) &&
   /if \(panelOf\(pat\) \|\| panelFallback\) return;/.test(html));
ok('the screen and the sheet both read the topped-up patient',
   /pat: panelPat, panel: patPanel/.test(html) &&
   /field\("Card ID", panelPat \?/.test(html));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
