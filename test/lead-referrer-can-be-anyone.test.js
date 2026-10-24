// Adding a lead in the CRM, only the patient's own name could be recorded:
// the form had a Source dropdown and a Contact list of patients, and nothing
// to say WHO sent them in. A referral is not always from another patient --
// a referring doctor, the clinic's own staff and somebody doing PR all refer,
// and the name alone cannot say which.
//
// Run in a browser. The name field changes shape with the kind -- staff are a
// list, a patient is searched for in the register, anyone else is typed -- and
// only running it shows that.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const a = html.indexOf('const CRM_B64 =');
const CRM = Buffer.from((html.slice(a, html.indexOf(';\n', a)).match(/"([^"]*)"/g) || [])
  .map(s => s.slice(1, -1)).join(''), 'base64').toString('utf8');
const CODE = CRM.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the kinds, and that they are the desk's ──────────────────────────────
const kinds = JSON.parse(/var REFERRER_KINDS = (\[[^\]]*\]);/.exec(CODE)[1].replace(/'/g, '"'));
const deskKinds = JSON.parse(/const REFERRER_KINDS = (\[[^\]]*\]);/.exec(html)[1]);
eq('the CRM offers the same kinds the front desk does', kinds, deskKinds);
ok('a patient is one', kinds.indexOf('Patient') >= 0);
ok('the clinic\'s own staff, who the user said refer', kinds.indexOf('Staff') >= 0);
ok('and the people who do PR', kinds.some(k => /PR/.test(k)));

// ── it is saved and shown ────────────────────────────────────────────────
ok('the referrer is saved with the lead',
   /referredBy:f\.referredBy\|\|'',referredByType:f\.referredByType\|\|''/.test(CODE));
ok('a referring patient\'s UHID is kept too, so it is the same person everywhere',
   /referredByUhid:f\.referredByUhid\|\|''/.test(CODE));
ok('and the lead shows who referred them, so recording it is worth something',
   /\['Referred By', lead\.referredBy/.test(CODE));

// ── the form, rendered ───────────────────────────────────────────────────
// The two rows are lifted out and rendered with the form's own helpers.
function sliceBalanced(marker) {
  const start = CODE.indexOf(marker);
  let i = CODE.indexOf('(', start), depth = 0, q = null;
  for (; i < CODE.length; i++) {
    const c = CODE[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  return CODE.slice(start, i);
}
const WHO = sliceBalanced("ir('Referred By \\u2014 who'");
const NAME = sliceBalanced("ir('Referred By \\u2014 name'");
ok('both rows are in the lead form', WHO.length > 0 && NAME.length > 0);

const STAFF = [{ name: 'Dr. Manika Mittel', role: 'Doctor' }, { name: 'Sunita', role: 'Reception' }];

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, 'node_modules/react/umd/react.production.min.js'), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8') });

  // The form's own ir/inp/sel helpers, so this renders what the CRM renders.
  const HELPERS = ['function ir(', 'function inp(', 'function sel('].map(m => {
    const i = CODE.indexOf(m);
    return CODE.slice(i, CODE.indexOf('\n  }', i) + 4);
  }).join('\n');

  const render = (form) => page.evaluate(({ WHO, NAME, HELPERS, STAFF, kinds, form }) => {
    const e = React.createElement;
    window.wrote = [];
    window.st = { refQuery: '', refHits: [], refMsg: '' };
    const f = form;
    const fUpd = (k) => (v) => { window.wrote.push([k, v]); };
    const upd = (p) => { Object.assign(window.st, p); };
    const staff = STAFF;
    const REFERRER_KINDS = kinds;
    const st = window.st;
    const crmFindPatients = () => Promise.resolve({ ok: true, patients: [] });
    const body = HELPERS + '\nreturn [' + WHO + ',' + NAME + '];';
    const rows = new Function('React', 'e', 'f', 'fUpd', 'upd', 'st', 'staff',
      'REFERRER_KINDS', 'crmFindPatients', body)(
      React, e, f, fUpd, upd, st, staff, REFERRER_KINDS, crmFindPatients);
    ReactDOM.createRoot(document.getElementById('root')).render(e('div', null, rows));
    return null;
  }, { WHO, NAME, HELPERS, STAFF, kinds, form });

  // Nothing chosen yet.
  await render({});
  await page.waitForTimeout(120);
  let sels = await page.$$eval('select', ns => ns.map(n => Array.from(n.options).map(o => o.textContent)));
  ok('the kind is a dropdown of the five', kinds.every(k => sels[0].indexOf(k) >= 0), sels[0]);
  ok('nothing is preselected, so an unclassified referral stays unclassified',
     await page.$eval('select', n => n.value) === '');
  let ph = await page.$$eval('input', ns => ns.map(n => n.placeholder));
  ok('and the name box asks which kind first', /who referred/i.test(ph[0] || ''), ph);

  // Staff: a list to pick from, not a name to spell.
  await render({ referredByType: 'Staff' });
  await page.waitForTimeout(120);
  sels = await page.$$eval('select', ns => ns.map(n => Array.from(n.options).map(o => o.textContent)));
  ok('choosing Staff offers the clinic\'s own people',
     sels[1].some(o => /Sunita/.test(o)) && sels[1].some(o => /Manika/.test(o)), sels[1]);
  ok('with their role beside the name, so two Sunitas are telling apart',
     sels[1].some(o => /Reception/.test(o)), sels[1]);
  eq('and no free-text box for a name that should be picked',
     await page.$$eval('input', ns => ns.length), 0);

  // PR: typed, because an agency is on no list of ours.
  await render({ referredByType: 'PR / Marketing' });
  await page.waitForTimeout(120);
  eq('someone doing PR is typed in', await page.$$eval('input', ns => ns.length), 1);
  ph = await page.$eval('input', n => n.placeholder);
  ok('and simply asked for by name', /name/i.test(ph), ph);
  await page.fill('input', 'Agency Nine');
  let wrote = await page.evaluate(() => window.wrote);
  eq('typing the name records the name', wrote[wrote.length - 1], ['referredBy', 'Agency Nine']);

  // A doctor, likewise typed -- referring doctors are not clinic staff.
  await render({ referredByType: 'Doctor' });
  await page.waitForTimeout(120);
  eq('a referring doctor is typed in too', await page.$$eval('input', ns => ns.length), 1);

  // Patient: searchable in the register.
  await render({ referredByType: 'Patient' });
  await page.waitForTimeout(120);
  const inputs = await page.$$eval('input', ns => ns.map(n => n.placeholder));
  ok('a referring patient can be searched for in the register',
     inputs.length === 2 && /register/i.test(inputs[1]), inputs);

  // Changing the kind must not leave the old name behind.
  await render({ referredByType: 'Staff', referredBy: 'Sunita' });
  await page.waitForTimeout(120);
  await page.selectOption('select >> nth=0', 'PR / Marketing');
  wrote = await page.evaluate(() => window.wrote);
  const keys = wrote.map(w => w[0]);
  ok('changing who referred them clears a name belonging to the old kind',
     keys.indexOf('referredByType') >= 0 && keys.indexOf('referredBy') >= 0, JSON.stringify(wrote));
  eq('the name is cleared, not carried across',
     wrote.filter(w => w[0] === 'referredBy').pop(), ['referredBy', '']);

  // Re-picking the same kind must NOT wipe a name already entered.
  await render({ referredByType: 'Staff', referredBy: 'Sunita' });
  await page.waitForTimeout(120);
  await page.selectOption('select >> nth=0', 'Staff');
  wrote = await page.evaluate(() => window.wrote);
  ok('but re-picking the same kind leaves the name alone',
     !wrote.some(w => w[0] === 'referredBy' && w[1] === ''), JSON.stringify(wrote));

  // A lead that already names a referrer shows it.
  await render({ referredByType: 'Staff', referredBy: 'Sunita' });
  await page.waitForTimeout(120);
  eq('a lead already naming a referrer opens on them',
     await page.$$eval('select', ns => ns.map(n => n.value)), ['Staff', 'Sunita']);

  ok('nothing threw', errors.length === 0, errors.join(' | '));
  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => {
    if (c.ok) { pass++; console.log('  PASS  ' + c.name); }
    else {
      fail++;
      console.log('  FAIL  ' + c.name +
        (c.want !== undefined ? '\n          got ' + JSON.stringify(c.got) + ', want ' + JSON.stringify(c.want)
                              : c.got ? '\n          ' + JSON.stringify(c.got) : ''));
    }
  });
  console.log('==============================================================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
