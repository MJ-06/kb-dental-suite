// "This is the screen pattern I want in Other Clinic in Master."
//
// Master → CLINIC → Other Clinic was a placeholder. It is now the Create
// Clinic screen the clinic asked for: name, group, speciality, plan, what
// data the new clinic starts with, an authorization code, Create / Cancel.
//
// Two things this has to get right beyond drawing the form.
//
// One: the clinic profile sheet is CLEARED and rewritten from whatever is
// handed to it, and the profile editor used to hand over only its own
// fields. Keeping the list of clinics there meant saving the Clinic tab
// would have deleted it. Both editors now spread the profile first.
//
// Two: a button called "Create Clinic" that records a row and nothing else
// has to say so. It cannot make a Google Sheet or a deployment, and a
// screen that implies otherwise leaves somebody waiting for a clinic that
// is never coming.
//
// Rendered and driven in a browser, with React off the disk.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the component, lifted out of the page ───────────────────────────────
const A = html.indexOf('const CLINIC_SPECIALITIES = [');
const B = html.indexOf('function ClinicProfileEditor({ profile, onSave }) {', A);
ok('the Create Clinic screen was found', A > 0 && B > A, `${A}..${B}`);
const SRC = html.slice(A, B);

// Everything it leans on from the rest of the page, named here so a new
// dependency shows up as a crash rather than a blank screen.
const DEPS = `
  const T = "#0078B4", BORDER = "#e5e5e0";
  const inp = { padding:"8px", border:"1px solid #e5e5e0", borderRadius:6, fontSize:13 };
  window.CLINIC = { name: "K.B. Dental Clinic" };
  window.__saved = [];
  window.__fail = false;
  function onSave(profile){
    window.__saved.push(profile);
    if (window.__fail) return Promise.resolve(false);
    window.__profile = profile;            // the book takes it
    return Promise.resolve(true);
  }
`;

// ── the profile editor must not throw the list away ─────────────────────
ok('the profile editor spreads the profile before saving',
   /Promise\.resolve\(onSave\(\{ \.\.\.profile, name, address, phone, mobiles, email, logo, padTop/.test(html));
ok('and so does the Create Clinic screen',
   /onSave\(\{ \.\.\.profile, otherClinics: JSON\.stringify\(existing\.concat/.test(html));
ok('Other Clinic is no longer a placeholder',
   /\{ id:"otherClinic",   label:"Other Clinic" \}/.test(html) &&
   !/id:"otherClinic",   label:"Other Clinic", placeholder:true/.test(html));
ok('and it is wired to the screen',
   /otherClinic: \(\) => React\.createElement\(OtherClinicEditor, \{/.test(html));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: DEPS });
  await page.addScriptTag({ content: SRC });

  async function mount(profile) {
    await page.evaluate(p => {
      window.__saved = []; window.__profile = p;
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      // Unmount first. Leaving the instance in place carries its state from
      // one case to the next, which is not what opening the tab does.
      root.render(null);
      window.__pending = p;
    }, profile);
    await page.waitForTimeout(40);
    await page.evaluate(() => {
      window.__root.render(React.createElement(OtherClinicEditor,
        { profile: window.__pending, onSave: window.onSave }));
    });
    await page.waitForTimeout(80);
  }

  // ── it draws the pattern ──────────────────────────────────────────────
  await mount({ name: 'K.B. Dental Clinic', phone: '011-22131942' });
  const text = await page.evaluate(() => document.body.innerText);
  ok('the screen drew', text.length > 100, text.slice(0, 120));
  for (const label of ['Create Clinic', 'Clinic Name', 'Group', 'Speciality', 'Plan', 'Data',
                       'Authorization Code', 'Cancel'])
    ok('it has "' + label + '"', text.indexOf(label) >= 0);
  for (const choice of ['Use Defaults',
                        'Copy from a same speciality clinic owned by you',
                        'Share with other clinics in the same group and speciality'])
    ok('and the data choice "' + choice.slice(0, 28) + '…"', text.indexOf(choice) >= 0);
  eq('three data choices, as in the pattern',
     await page.locator('input[type=radio]').count(), 3);
  ok('"Use Defaults" is the one already chosen',
     await page.locator('input[type=radio]').first().isChecked());

  // The group dropdown starts on this clinic, the way the original shows
  // the clinic's own group.
  const groupOpts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select')[0].options).map(o => o.textContent));
  ok('the group dropdown offers this clinic', groupOpts.indexOf('K.B. Dental Clinic') >= 0, groupOpts);
  ok('and a way to add another group', groupOpts.some(o => /Add a new group/.test(o)), groupOpts);

  // ── it says what it actually does ─────────────────────────────────────
  ok('it says plainly what pressing Create does today',
     /records the clinic here/.test(text), text.slice(-400));
  ok('and that a second clinic still needs its own sheet and deployment',
     /own Google Sheet and its own deployment/.test(text));
  ok('the authorization code does not pretend to be checked',
     /nothing here checks it/.test(text));

  // ── nothing is recorded until the form is complete ────────────────────
  const fill = async (sel, value) => { await page.locator(sel).fill(value); };
  await page.getByRole('button', { name: 'Create Clinic' }).click();
  await page.waitForTimeout(60);
  eq('an empty form saves nothing', await page.evaluate(() => window.__saved.length), 0);
  ok('and says why', /The clinic needs a name/.test(await page.evaluate(() => document.body.innerText)));

  await fill('input[placeholder^="e.g. K.B. Dental Clinic"]', 'K.B. Dental Clinic — Vasundhara');
  await page.getByRole('button', { name: 'Create Clinic' }).click();
  await page.waitForTimeout(60);
  eq('a name alone is not enough either', await page.evaluate(() => window.__saved.length), 0);
  ok('the plan is asked for', /Choose a plan/.test(await page.evaluate(() => document.body.innerText)));

  await fill('input[placeholder="e.g. Dental Inventory Plus"]', 'Dental Inventory Plus');
  await page.getByRole('button', { name: 'Create Clinic' }).click();
  await page.waitForTimeout(60);
  eq('and nor is a plan without the code', await page.evaluate(() => window.__saved.length), 0);
  ok('the code is required', /authorization code is needed/.test(await page.evaluate(() => document.body.innerText)));

  // ── a complete form records the clinic ────────────────────────────────
  await fill('input[placeholder="Enter the code"]', 'KB-2026-0001');
  await page.getByRole('button', { name: 'Create Clinic' }).click();
  await page.waitForTimeout(120);
  const saved = await page.evaluate(() => window.__saved);
  eq('one save', saved.length, 1);
  const written = JSON.parse(saved[0].otherClinics || '[]');
  eq('one clinic recorded', written.length, 1);
  eq('with the name typed', written[0].name, 'K.B. Dental Clinic — Vasundhara');
  eq('the group chosen', written[0].group, 'K.B. Dental Clinic');
  eq('the speciality', written[0].speciality, 'Dentistry');
  eq('the plan', written[0].plan, 'Dental Inventory Plus');
  eq('the data choice', written[0].data, 'defaults');
  eq('and the code as given', written[0].authCode, 'KB-2026-0001');
  ok('it carries an id of its own', !!written[0].id, written[0].id);
  // THE TRAP. The sheet is cleared and rewritten from this object, so
  // anything else the profile held has to still be in it.
  eq('the clinic name on the profile survived', saved[0].name, 'K.B. Dental Clinic');
  eq('and its phone', saved[0].phone, '011-22131942');

  // ── a recorded clinic shows, and can be removed ───────────────────────
  await mount({ name: 'K.B. Dental Clinic', phone: '011-22131942',
                otherClinics: JSON.stringify(written) });
  const withOne = await page.evaluate(() => document.body.innerText);
  ok('the recorded clinic is listed', /Vasundhara/.test(withOne));
  ok('under a heading that counts them', /Clinics recorded \(1\)/i.test(withOne), withOne.slice(-200));
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await page.waitForTimeout(120);
  const afterRemove = await page.evaluate(() => window.__saved);
  eq('removing writes the list back without it',
     JSON.parse(afterRemove[afterRemove.length - 1].otherClinics), []);
  eq('and still keeps the rest of the profile',
     afterRemove[afterRemove.length - 1].phone, '011-22131942');

  // ── the same clinic twice ─────────────────────────────────────────────
  await mount({ name: 'K.B. Dental Clinic', otherClinics: JSON.stringify(written) });
  await fill('input[placeholder^="e.g. K.B. Dental Clinic"]', 'k.b. dental clinic — vasundhara');
  await fill('input[placeholder="Enter the code"]', 'X');
  await page.getByRole('button', { name: 'Create Clinic' }).click();
  await page.waitForTimeout(80);
  eq('a name already on the list is refused', await page.evaluate(() => window.__saved.length), 0);
  { const t = await page.evaluate(() => document.body.innerText);
    ok('whatever the case it was typed in', /is already on this list/.test(t), t.slice(0, 600)); }

  // ── copying needs something to copy from ──────────────────────────────
  await mount({ name: 'K.B. Dental Clinic' });
  await fill('input[placeholder^="e.g. K.B. Dental Clinic"]', 'Second Branch');
  await fill('input[placeholder="e.g. Dental Inventory Plus"]', 'Plan A');
  await fill('input[placeholder="Enter the code"]', 'CODE');
  await page.locator('input[type=radio]').nth(1).check();
  await page.waitForTimeout(60);
  await page.getByRole('button', { name: 'Create Clinic' }).click();
  await page.waitForTimeout(60);
  eq('copying with no clinic chosen saves nothing', await page.evaluate(() => window.__saved.length), 0);
  ok('and asks which one', /which clinic to copy/.test(await page.evaluate(() => document.body.innerText)));

  // ── a book that refuses the write ─────────────────────────────────────
  await mount({ name: 'K.B. Dental Clinic' });
  await page.evaluate(() => { window.__fail = true; });
  await fill('input[placeholder^="e.g. K.B. Dental Clinic"]', 'Third Branch');
  await fill('input[placeholder="e.g. Dental Inventory Plus"]', 'Plan A');
  await fill('input[placeholder="Enter the code"]', 'CODE');
  await page.getByRole('button', { name: 'Create Clinic' }).click();
  await page.waitForTimeout(120);
  { const t = await page.evaluate(() => document.body.innerText);
    ok('a refused save says so rather than looking done', /Not saved/.test(t), t.slice(0, 600)); }
  await page.evaluate(() => { window.__fail = false; });

  // ── a mangled cell does not take the page down ────────────────────────
  for (const bad of ['not json at all', '{"not":"a list"}', '[1,2,3]', '']) {
    await mount({ name: 'K.B. Dental Clinic', otherClinics: bad });
    const t = await page.evaluate(() => document.body.innerText);
    ok('a cell holding ' + JSON.stringify(bad.slice(0, 16)) + ' still draws the screen',
       /Create Clinic/.test(t) && /Clinics recorded \(0\)/i.test(t), t.slice(-160));
  }

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
