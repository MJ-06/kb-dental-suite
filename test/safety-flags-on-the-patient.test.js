// "Yes, put them on the patient record."
//
// A master list nobody can attach to a patient warns nobody. So a safety
// flag is now ticked on the patient in Registration, stored on their row in
// the register, and shown on the patient banner — which sits at the top of
// every page once a patient is open. That is the whole point: the staff see
// it before the patient sits down, without opening anything.
//
// Two things it has to survive.
//
// The record stores a JSON array, but the patient's own form on the iPad
// sends plain "A, B, C" and an older row may hold either. Both read as a
// list, and anything else reads as none rather than throwing a page away.
//
// And a flag RETIRED in Master must not drop silently off a patient who
// already carries it. It stays on their record, stays ticked, and stays on
// the banner.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the register keeps them ─────────────────────────────────────────────
ok('the register grows a Safety Flags column',
   /ensureRegColumns_\(sh, \["Patient Type", "Panel", "Panel Category", "Card ID",\s*\n\s*"Referred By Type", "Mobile 2", "Safety Flags"\]\);/.test(gs));
ok('and the flags are written into it', /"Safety Flags": safeJSON\(p\.safetyFlags\),/.test(gs));
ok('and read back as a list', /safetyFlags:\s+regList_\(get\("Safety Flags"\)\),/.test(gs));
// Stored the same way as conditions and allergies, so it reads back the
// same way — safeJSON on the way in, regList_ on the way out.
ok('stored the way the other list fields are',
   /"Are you allergic to any of the following\?\|Allergies": safeJSON\(p\.allergies\)/.test(gs));

// ── the form sets them, and sends them ──────────────────────────────────
ok('Registration reads the clinic’s list', /const safetyFlagOptions = useSafetyFlags\(\);/.test(html));
ok('the medical step holds the ticked ones', /safetyFlags: \[\]\n\};/.test(html));
ok('they go up with the registration', /safetyFlags: M\.safetyFlags,/.test(html));
ok('they come back when a record is loaded', /const _sf = patientFlags\(pat\);/.test(html));
// NOT behind the conditions: a patient can carry a flag and no medical
// conditions at all, and that flag still has to come back.
ok('and not only when the patient has medical conditions',
   /\/\/ On its own, not behind the conditions/.test(html));
ok('a flag retired in Master stays on a patient who has it',
   /Array\.from\(new Set\(\[\.\.\.safetyFlagOptions, \.\.\.M\.safetyFlags\]\)\)/.test(html));
ok('the banner carries them on every page a patient is open on',
   /\}, "Change Patient"\), \/\*#__PURE__\*\/React\.createElement\(SafetyFlagStrip, \{/.test(html));
ok('the list is read once per page and shared', /let _safetyFlagsCache = null;/.test(html));

// ── patientFlags and the strip, rendered and driven ─────────────────────
const A = html.indexOf('function patientFlags(pat) {');
const B = html.indexOf('function PatientBanner({', A);
ok('the reader and the strip were found', A > 0 && B > A, `${A}..${B}`);
const SRC = html.slice(A, B);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: SRC });

  // ── however the record stored them ────────────────────────────────────
  const read = await page.evaluate(() => ({
    json: patientFlags({ safetyFlags: '["Apprehensive","Latex Allergy"]' }),
    array: patientFlags({ safetyFlags: ['Apprehensive', 'Latex Allergy'] }),
    csv: patientFlags({ safetyFlags: 'Apprehensive, Latex Allergy' }),
    spacey: patientFlags({ safetyFlags: '  Apprehensive ,  Latex Allergy  ' }),
    one: patientFlags({ safetyFlags: 'Apprehensive' }),
    blanks: patientFlags({ safetyFlags: 'Apprehensive, , ,Latex Allergy' }),
    emptyArr: patientFlags({ safetyFlags: [] }),
    emptyStr: patientFlags({ safetyFlags: '' }),
    white: patientFlags({ safetyFlags: '   ' }),
    badJson: patientFlags({ safetyFlags: '[not json' }),
    none: patientFlags({}),
    nothing: patientFlags(null)
  }));
  const TWO = ['Apprehensive', 'Latex Allergy'];
  eq('a JSON array, as the desk saves it', read.json, TWO);
  eq('an array already parsed', read.array, TWO);
  eq('plain text, as the iPad form sends it', read.csv, TWO);
  eq('with the spacing somebody typed', read.spacey, TWO);
  eq('a single flag', read.one, ['Apprehensive']);
  eq('empty entries are dropped', read.blanks, TWO);
  for (const [k, v] of [['an empty list', read.emptyArr], ['an empty cell', read.emptyStr],
                        ['whitespace', read.white], ['broken JSON', read.badJson],
                        ['no field at all', read.none], ['no patient at all', read.nothing]])
    eq(k + ' reads as none', v, []);

  // ── the strip itself ──────────────────────────────────────────────────
  const draw = async pat => {
    await page.evaluate(p => {
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      root.render(null); window.__p = p;
    }, pat);
    await page.waitForTimeout(30);
    await page.evaluate(() => {
      window.__root.render(React.createElement(SafetyFlagStrip, { pat: window.__p }));
    });
    await page.waitForTimeout(50);
    return page.evaluate(() => document.body.innerText);
  };

  const shown = await draw({ safetyFlags: ['Apprehensive', 'Psychiatric Treatment'] });
  ok('the flags are drawn', /Apprehensive/.test(shown) && /Psychiatric Treatment/.test(shown), shown);
  ok('under a warning that says what they are', /Safety/.test(shown), shown);
  // A patient with none must not get an empty warning box — a box that
  // cries wolf is a box people stop reading.
  for (const none of [{ safetyFlags: [] }, { safetyFlags: '' }, {}, null]) {
    const t = await draw(none);
    eq('a patient with no flags gets no box: ' + JSON.stringify(none), t.trim(), '');
  }
  const csvDrawn = await draw({ safetyFlags: 'Apprehensive, Wheelchair User' });
  ok('a record stored as plain text still draws',
     /Apprehensive/.test(csvDrawn) && /Wheelchair User/.test(csvDrawn), csvDrawn);

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
