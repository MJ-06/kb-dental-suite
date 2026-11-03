// "I have tried to save the panel patient details with their beneficiary id
//  but I think either it is not saving or it is not getting linked to
//  Endorsement."
//
// It was saving. getPatient returns a hand-picked set of fields, built by
// naming each one, and Panel / Panel Category / Card ID were simply not in
// the list — so the register held them and nothing downstream ever saw
// them. A panel patient looked private to the whole app: the endorsement
// could not find a panel however carefully it had been entered, and the
// registration form came up blank when the patient was opened again, so
// typing the card ID back in saved nothing at all (the payload only carries
// panel details when the type says "panel").
//
// A field that is written and never read back is invisible to every test
// that only looks at one side, so this one walks the whole path: the
// register's columns, what getPatient hands back, what the registration
// form restores, and what the endorsement reads.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; } else {
    fail++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : ''));
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

// ── 1. the register keeps them ──────────────────────────────────────────
ok('the register has columns for the panel, the card holder and the card',
   /ensureRegColumns_\(sh, \["Patient Type", "Panel", "Panel Category", "Card ID"/.test(gs));
for (const col of ['"Panel": p.panel', '"Panel Category": p.panelCategory', '"Card ID": p.cardId'])
  ok('registration writes ' + col.split(':')[0], gs.indexOf(col) >= 0);

// A blank must not wipe what is already there, or the iPad form — which
// knows nothing about panels — would clear a panel on every save.
ok('a blank does not overwrite a value already on an existing row',
   /if \(existingRow > 0 && \(val === undefined \|\| val === null \|\| String\(val\)\.trim\(\) === ""\)\) return;/.test(gs));

// ── 2. getPatient hands them back ───────────────────────────────────────
// This is the one that was missing. It is checked inside getPatient's own
// returned object, not anywhere in the file: the strings appear elsewhere.
const gp = gs.slice(gs.indexOf('function getPatient(p)'),
                    gs.indexOf('// Patients registered before the move live in a second book'));
ok('getPatient was found', gp.length > 200, gp.length);
for (const [key, col] of [['patientType', 'Patient Type'], ['panel', 'Panel'],
                          ['panelCategory', 'Panel Category'], ['cardId', 'Card ID']])
  ok('getPatient returns ' + key,
     new RegExp(key + ':\\s*get\\("' + col + '"\\)').test(gp), gp.slice(-400));

// The app must NOT demand this build. The panel is read from getAllPatients
// when getPatient is too old to hand it over, so the endorsement works on
// the backend the clinic already has; demanding a redeploy for something
// that is merely nicer puts a red warning across a working screen.
const required = (/const KB_BACKEND_BUILD_REQUIRED = "([^"]+)"/.exec(html) || [])[1];
const backend = (/var BACKEND_BUILD = "([^"]+)"/.exec(gs) || [])[1];
ok('the new backend is there to deploy', backend >= '2026-11-03', backend);
ok('but the app does not demand it, because it does not need it',
   required < backend, required + ' vs ' + backend);

// ── 3. the registration form shows it back ──────────────────────────────
const regAt = html.indexOf('// Auto-load existing patient if globalPat is set');
const reg = html.slice(regAt, html.indexOf('QUICK_BLANK', regAt));
ok('the registration form was found', reg.length > 200, reg.length);
ok('opening an existing patient restores whether they are on a panel',
   /setPatientType\(isPanel \? "panel" : "normal"\)/.test(reg), reg.slice(-500));
ok('and the panel itself', /setPanel\(p\.panel \|\| ""\)/.test(reg));
ok('and the card holder and card ID',
   /panelCat: p\.panelCategory \|\| "", cardId: p\.cardId \|\| ""/.test(reg));
// Restoring the type is what makes a re-save keep the panel: the payload
// only carries panel fields when the type says "panel".
ok('which is what lets a re-save keep them',
   /\.\.\.\(patientType === "panel" \? \{[\s\S]{0,200}?panel: panel,/.test(html));

// ── 4. the endorsement reads it ─────────────────────────────────────────
ok('the endorsement reads the panel getPatient now returns',
   /const panelOf = \(p\) => String\(\(p && \(p\.panel \|\| p\.Panel\)\) \|\| ""\)\.trim\(\);/.test(html));
ok('the screen reads the card ID getPatient now returns',
   /"Card ID: " \+ \(pat\.cardId \|\| pat\["Card ID"\]/.test(html));
// The sheet prints from the topped-up patient, so that an older backend --
// one that does not return the panel from getPatient yet -- still produces a
// correct sheet from what the register holds.
ok('and the printed sheet reads them too',
   /field\("Card ID", panelPat \? \(panelPat\.cardId \|\| panelPat\["Card ID"\]/.test(html) &&
   /field\("Card Holder", panelPat \? \(panelPat\.panelCategory/.test(html));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
