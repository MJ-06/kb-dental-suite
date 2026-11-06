// "Under Masters, under Patient, before Safety Flags add a placeholder
//  Patient Type and make it same as Safety Flags, and also under Referral
//  Source same as Safety Flags to add."
//
// Two more lists on the shared screen. Patient Type sits immediately before
// Safety Flags, as asked.
//
// Referral Source is not decorative: Registration already asked "How did you
// know about us" from a list hardcoded in the page. Leaving the master list
// beside it would mean two lists, and editing the one in Master would do
// nothing at all. So the question is drawn from the master list now, with
// the hardcoded six as the fallback — the question must never come up with
// nothing to tick.
//
// Patient Type is deliberately NOT wired into Registration. "Panel" is what
// routes a patient to the panel register and what the CRM reads to put them
// on the panel board; a free list cannot drive that, and the screen says so
// rather than implying it can.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── where the tabs sit ──────────────────────────────────────────────────
const patientTabs = (() => {
  const a = html.indexOf('{ id:"patient", label:"Patient", subtabs:[');
  const b = html.indexOf(']}', a);
  return html.slice(a, b);
})();
ok('the Patient tabs were found', patientTabs.length > 20, patientTabs.slice(0, 60));
eq('Patient Type comes immediately before Safety Flags',
   (patientTabs.match(/id:"(\w+)"/g) || []).map(x => x.slice(4, -1)),
   ['patient', 'referralSource', 'patientType', 'flags', 'occupation', 'docCategories']);
ok('neither is a placeholder any more',
   !/id:"referralSource", label:"Referral Source", placeholder:true/.test(html) &&
   !/id:"patientType"[^}]*placeholder:true/.test(html));
ok('Referral Source uses the shared screen',
   /referralSource: \(\) => React\.createElement\(EntryListEditor, \{\n      title:"Referral Source", noun:"referral sources",/.test(html));
ok('and so does Patient Type',
   /patientType: \(\) => React\.createElement\(EntryListEditor, \{\n      title:"Patient Type", noun:"patient types",/.test(html));
ok('Patient Type says plainly that Panel is not just a label',
   /is what sends a patient to the panel/.test(html));

// ── the clinic book behind them ─────────────────────────────────────────
for (const [sheet, def, get, save, key] of [
  ['REFERRAL_SOURCES_SHEET = "Referral Sources"', 'DEFAULT_REFERRAL_SOURCES',
   'getReferralSourcesList', 'saveReferralSourcesList', 'sources'],
  ['PATIENT_TYPES_SHEET = "Patient Types"', 'DEFAULT_PATIENT_TYPES',
   'getPatientTypesList', 'savePatientTypesList', 'types']
]) {
  ok(sheet.split(' =')[0] + ' has a tab of its own', gs.indexOf('var ' + sheet) > 0);
  ok(def + ' seeds it', gs.indexOf('var ' + def + ' = [') > 0);
  ok(get + ' is routed', gs.indexOf('case "' + get + '":') > 0);
  ok(save + ' is routed', gs.indexOf('case "' + save + '":') > 0);
  ok(save + ' refuses a payload cut short',
     gs.indexOf('parseList_(p.' + key + ',') > 0);
}
// They started as the six Registration always offered; the clinic has since
// given me its own thirteen, and a tab still holding exactly those six is
// replaced with them. referral-list-and-renaming.test.js covers that.
ok('the referral sources start as the clinic\u2019s own list',
   /DEFAULT_REFERRAL_SOURCES = \[[\s\S]{0,400}"Instagram"[\s\S]{0,400}"Just Dial"/.test(gs));
ok('and the six it shipped with are kept only to recognise an untouched tab',
   /LEGACY_REFERRAL_SOURCES = \[[\s\S]{0,200}"An Existing Patient"[\s\S]{0,200}"Google"/.test(gs));
ok('and the patient types as the two the app acts on',
   /DEFAULT_PATIENT_TYPES = \["Normal", "Panel"\];/.test(gs));
ok('Master fetches both',
   /"getReferralSourcesList", "getPatientTypesList"/.test(html));
ok('and takes them off the same destructure, in the same order',
   // Not anchored to the end of the destructure: a list added after these
// is fine, a list that moves in front of them is not.
   /,wd,ct,sf,oc,rs,pt[,\]]/.test(html));
ok('and reads them back',
   /if \(rs && rs\.success\) setReferralSources\(rs\.sources \|\| \[\]\);/.test(html) &&
   /if \(pt && pt\.success\) setPatientTypes\(pt\.types \|\| \[\]\);/.test(html));
ok('and saves them',
   /persist\("saveReferralSourcesList", \{ sources: JSON\.stringify\(arr\) \}/.test(html) &&
   /persist\("savePatientTypesList", \{ types: JSON\.stringify\(arr\) \}/.test(html));

// ── the referral list is not decorative ─────────────────────────────────
ok('Registration reads it', /const referralOptions = useReferralSources\(\);/.test(html));
ok('and it is read once per page and shared', /let _referralSourcesCache = null;/.test(html));
ok('the hardcoded list is no longer what the question offers',
   !/\[\.\.\.HOW_KNOWN, "Other"\]\.map/.test(html));

// The option list, lifted out and run: it is one expression, and all three
// of its jobs are easy to break.
const EXPR = `[...new Set([...(referralOptions.length ? referralOptions : HOW_KNOWN),
               ...D.howKnown, "Other"])]`;
ok('the option list was found in the page', html.indexOf(EXPR) > 0);
const build = (referralOptions, howKnown) => {
  const HOW_KNOWN = ["An Existing Patient", "Website", "Word of Mouth",
                     "Sign Board", "Social Media", "Google"];
  const D = { howKnown };
  return eval(EXPR);
};
eq('with a master list, that is what is offered',
   build(['Camp', 'Newspaper'], []), ['Camp', 'Newspaper', 'Other']);
// The question must never come up with nothing to tick.
eq('with none, the six it always offered',
   build([], []),
   ['An Existing Patient', 'Website', 'Word of Mouth', 'Sign Board', 'Social Media', 'Google', 'Other']);
// A source retired in Master must not vanish off the patient who gave it.
eq('something already ticked is kept, even if retired in Master',
   build(['Camp'], ['Newspaper']), ['Camp', 'Newspaper', 'Other']);
eq('and is not listed twice when it is still on the list',
   build(['Camp', 'Newspaper'], ['Newspaper']), ['Camp', 'Newspaper', 'Other']);
eq('"Other" is never duplicated', build(['Other'], ['Other']), ['Other']);

// ── the shared screen, driven once more with these props ────────────────
const A = html.indexOf('function EntryListEditor({ title, blurb, noun, items, onAdd, onRemove, onEdit }) {');
const B = html.indexOf('// When the day runs, and how long a slot is.', A);
ok('the shared screen was found', A > 0 && B > A, `${A}..${B}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const T = "#0078B4", BORDER = "#e5e5e0", BGS = "#f5f5f0";
    const MASTER_LIST_WIDTH = ${(/const MASTER_LIST_WIDTH = (\d+);/.exec(html) || [])[1]};
    const inp = { padding:"8px", border:"1px solid #e5e5e0", borderRadius:6, fontSize:13, fontFamily:"inherit" };
    window.__added = []; window.__removed = [];
  ` });
  await page.addScriptTag({ content: html.slice(A, B) });

  for (const [title, noun, items] of [
    ['Patient Type', 'patient types', ['Normal', 'Panel']],
    ['Referral Source', 'referral sources', ['Website', 'Google']]
  ]) {
    await page.evaluate(([t, n, i]) => {
      window.__added = []; window.__removed = [];
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      root.render(null); window.__args = [t, n, i];
    }, [title, noun, items]);
    await page.waitForTimeout(30);
    await page.evaluate(() => {
      const [t, n, i] = window.__args;
      window.__root.render(React.createElement(EntryListEditor, {
        title: t, noun: n, blurb: 'blurb', items: i,
        onAdd: v => window.__added.push(v),
        onRemove: ix => window.__removed.push(ix) }));
    });
    await page.waitForTimeout(60);
    const text = await page.evaluate(() => document.body.innerText);
    ok(title + ': it is headed correctly', text.indexOf(title) >= 0, text.slice(0, 80));
    for (const it of items) ok(title + ': "' + it + '" is listed', text.indexOf(it) >= 0);
    eq(title + ': one Delete per entry',
       await page.getByRole('button', { name: 'Delete' }).count(), items.length);
    await page.locator('input[placeholder="Type new entry here"]').fill(items[0].toLowerCase());
    await page.getByRole('button', { name: 'Add' }).click();
    await page.waitForTimeout(50);
    eq(title + ': one already on the list is refused', await page.evaluate(() => window.__added), []);
    await page.locator('input[placeholder="Type new entry here"]').fill('Something New');
    await page.getByRole('button', { name: 'Add' }).click();
    await page.waitForTimeout(50);
    eq(title + ': a new one is passed up', await page.evaluate(() => window.__added), ['Something New']);
  }
  // The empty line names what is missing, per list.
  await page.evaluate(() => {
    window.__root.render(null);
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    window.__root.render(React.createElement(EntryListEditor, {
      title: 'Patient Type', noun: 'patient types', blurb: 'b', items: [],
      onAdd: () => {}, onRemove: () => {} }));
  });
  await page.waitForTimeout(60);
  ok('an empty list names what is missing',
     /No patient types yet/.test(await page.evaluate(() => document.body.innerText)));

  ok('nothing threw', errors.length === 0, errors.join(' // '));
  await browser.close();

  let pass = 0, fail = 0;
  for (const c of checks) {
    if (c.ok) pass++;
    else {
      fail++;
      console.log('  FAIL  ' + c.name +
        (c.got !== undefined ? '\n          got ' + JSON.stringify(c.got) : '') +
        (c.want !== undefined ? ', wanted ' + JSON.stringify(c.want) : ''));
    }
  }
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  CRASH  ' + ((e && e.stack) || e)); process.exit(1); });
