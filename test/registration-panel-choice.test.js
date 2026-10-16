// Registration now asks ONE thing first: normal patient, or panel patient.
// It decides which book the registration is written to and which form
// follows, so it has to come before anything is typed — asking later would
// mean re-routing a record that had already been saved to the wrong book.
//
// The panel registration form itself is not built yet. Until it is, choosing
// a panel must STOP rather than fall through to the normal form, because that
// form saves to the main book.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const GS = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail, want: 'truthy' });

// --- the choice comes before anything is typed ----------------------------
ok('registration asks normal or panel first',
  /step === 0 && !patientType/.test(html));
ok('with both choices on screen',
  /"Normal Patient"/.test(html) && /"Panel Patient"/.test(html));
// The panel picker and the holding screen are gone. A panel patient now goes
// straight from the type choice to the ordinary registration form, with three
// panel fields on it. These pin that the shortcut did not lose anything: the
// type choice still comes before the form, and the fields are still required.
const iType = html.indexOf('step === 0 && !patientType');
const iForm = html.indexOf('if (step === 0) return /*#__PURE__*/React.createElement');
ok('the type screen is checked before the form', iType > 0 && iType < iForm, [iType, iForm]);
ok('there is no separate panel picker screen any more',
  html.indexOf('step === 0 && patientType === "panel" && !panel') === -1);
ok('and no holding screen that saves nothing',
  html.indexOf('registration form is not ready yet') === -1);

// --- the three panel fields -----------------------------------------------
ok('the panel is chosen on the form itself', /qField\("Panel \*", "panel"/.test(html));
ok('the card number is taken', /qField\("Card ID \*", "cardId"/.test(html));
ok('and serving or pensioner, as two tabs',
  /\["Serving", "Pensioner"\]\.map/.test(html));
ok('they show only for a panel patient',
  /patientType === "panel" && ceQ\("div", \{/.test(html));

// A claim cannot be filed without these three, and chasing them after the
// patient has gone home is how claims get rejected. Required at the counter.
ok('the panel is required', /if \(!panel\) e\.panel =/.test(html));
ok('serving or pensioner is required', /if \(!q\.panelCat\) e\.panelCat =/.test(html));
ok('the card ID is required', /if \(!q\.cardId\.trim\(\)\) e\.cardId =/.test(html));
ok('and only for a panel patient',
  /if \(patientType === "panel"\) \{\n      if \(!panel\)/.test(html));

// --- what is sent ----------------------------------------------------------
ok('a panel registration carries the panel', /panel: panel,/.test(html));
ok('the card holder category', /panelCategory: q\.panelCat,/.test(html));
ok('the card ID', /cardId: q\.cardId\.trim\(\)/.test(html));
ok('and is marked as a panel row', /patientType: "Panel"/.test(html));
ok('a normal registration sends none of it, so its row is unchanged',
  /\.\.\.\(patientType === "panel" \? \{/.test(html));

// A panel patient is saved by the SAME quickRegister as everyone else. A second
// save path would be a second place for the duplicate check, the UHID sequence
// and the validation to drift apart, which is the bug this whole session has
// been about. There is one.
eq('there is one registration save path, not a panel copy of it',
  (html.match(/const quickRegister = async/g) || []).length, 1);
// There are two saves: the quick one at the counter and the full iPad form.
// Both must carry the panel marking — a full form that dropped it would save a
// panel patient as an ordinary one and put the row in the wrong book.
eq('there are exactly two saveRegistration calls',
  (html.match(/api\("saveRegistration", \{/g) || []).length, 2);
eq('and both carry the panel marking',
  (html.match(/\.\.\.\(patientType === "panel" \? \{/g) || []).length, 2);

// --- the panel list is the clinic's own, not the developer's --------------
ok('the panel list is loaded from the backend',
  /api\("getPanelsList"\)/.test(html));
// Master is the only source. A built-in list that is usually right is worse
// than none: nobody can tell which list the screen is showing, and a panel
// removed in Master would go on appearing.
eq('there is no built-in panel list to drift from Master',
  /DEFAULT_PANELS/.test(html), false);
eq('the picker starts empty and waits for Master',
  /const \[panels, setPanels\] = useState\(\[\]\)/.test(html), true);
eq('whatever Master returns is what is shown, empty included',
  /if \(res && res\.success\) setPanels\(res\.panels \|\| \[\]\)/.test(html), true);
// "Still loading" and "genuinely none" look identical on screen but mean very
// different things; showing the same message for both sends someone hunting
// through Master for a list that is on its way.
ok('loading and empty are told apart', /panelsLoaded/.test(html));
ok('and an empty list says where to fix it',
  /Master \\u2192 Accounts \\u2192 Panels/.test(html));

// --- and the clinic can edit it, without a developer ----------------------
ok('Master has a Panels tab', /\{ id:"panels",\s*label:"Panels" \}/.test(html));
ok('it uses the same list editor as the other lists',
  /panels: \(\) => React\.createElement\(SimpleListEditor/.test(html));
// It goes through the Master screen's checked save, which reports a refused
// write instead of leaving the panel on screen and losing it at the next
// refresh — so look for the action, not for a bare api() call.
ok('adding a panel saves it', /persist\("savePanelsList"/.test(html));
ok('the panels load with the other Master lists in one request',
  /"getImplantBrandsList", "getPanelsList"/.test(html));

// --- the backend end ------------------------------------------------------
ok('Code.gs serves the panel list', /case "getPanelsList":\s*return getPanelsList\(\);/.test(GS));
ok('and saves it', /case "savePanelsList":\s*return savePanelsList\(p\);/.test(GS));
ok('from a tab the clinic can see', /getSheet\("Panels"\)/.test(GS));
// A blank row typed by accident must not become a panel called "".
ok('blank entries are not stored',
  /arr\.forEach\(function \(m\) \{ if \(String\(m \|\| ""\)\.trim\(\)\)/.test(GS));

let pass = 0, fail = 0;
console.log('\n' + '='.repeat(78));
console.log('NORMAL OR PANEL, ASKED FIRST');
console.log('='.repeat(78));
for (const c of checks) {
  c.ok ? pass++ : fail++;
  console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name +
    (c.ok ? '' : `\n          expected ${JSON.stringify(c.want)}, got ${JSON.stringify(c.got)}`));
}
console.log('='.repeat(78));
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(78) + '\n');
process.exit(fail ? 1 : 0);
