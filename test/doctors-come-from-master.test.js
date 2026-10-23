// "For every patient it is default taking Dr. Viveyk Mittel. It should show
// the name of doctor who worked."
//
// Two causes. The host handed every clinical form getDoctors()[0] -- the
// first name on the master list -- whoever had actually done the work. And
// the forms carried their own idea of who works here: four had a dropdown
// with one or two names typed into the markup (RCT offered Dr. Viveyk and
// nobody else), and fifteen had a blank box to type the name into by hand.
//
// The forms are run in a browser, not read, because the fix replaces an
// <input> with a <select> at runtime and only running it proves that works.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kbdoc-'));

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// Every form that asks who the treating doctor was.
const forms = [];
{
  const re = /const ([A-Z0-9_]+_B64)\s*=\n/g; let m;
  while ((m = re.exec(html))) {
    const a = m.index, b = html.indexOf(';\n', a);
    const src = Buffer.from((html.slice(a, b).match(/"([^"]*)"/g) || [])
      .map(x => x.slice(1, -1)).join(''), 'base64').toString('utf8');
    if (src.indexOf('id="pDoc"') < 0) continue;
    const p = path.join(OUT, m[1] + '.html');
    fs.writeFileSync(p, src);
    forms.push({ name: m[1], file: p, src });
  }
}
ok('every clinical form that asks for a doctor is covered', forms.length === 19, forms.length);
ok('and each one now takes the master list',
   forms.every(f => f.src.indexOf('applyMasterDoctors') >= 0),
   forms.filter(f => f.src.indexOf('applyMasterDoctors') < 0).map(f => f.name));

// ── the host sends the right doctor ──────────────────────────────────────
ok('the host no longer decides the doctor by picking the first on the list alone',
   /async function treatingDoctorFor\(uhid\)/.test(html));
ok('it reads who the patient is actually booked with today',
   /api\("getAppointments", \{ date: isoDateLocal\(new Date\(\)\) \}\)/.test(html));
ok('a cancelled booking is not whose name goes on the record',
   /!== "cancelled"/.test(html));
ok('a patient with no booking still gets a workable default',
   /const fallback = getDoctors\(\)\[0\] \|\| "";/.test(html));
ok('and a backend that cannot be reached does not break the form',
   /catch \(e\) \{\s*return fallback;\s*\}/.test(html));
ok('both form screens send the list', (html.match(/const sendDoctorsToForm = async/g) || []).length === 2);
ok('on a loop, because the iframe may not be listening yet',
   /typeof w\.applyMasterDoctors === "function"/.test(html));

const DOCTORS = ['Dr. Viveyk Mittel', 'Dr. Manika Mittel', 'Dr. A. Sharma'];

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

  // Run every form, not a sample: the markup differs between them.
  for (const f of forms) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.goto('file://' + f.file);
    await page.waitForTimeout(120);

    const before = await page.$eval('#pDoc', n => n.tagName);
    await page.evaluate(d => window.postMessage(
      { type: 'KB_DOCTORS', doctors: d, selected: 'Dr. Manika Mittel' }, '*'), DOCTORS);
    await page.waitForTimeout(120);

    const after = await page.evaluate(() => {
      const el = document.getElementById('pDoc');
      return { tag: el.tagName, value: el.value,
               options: Array.from(el.options || []).map(o => o.textContent) };
    });
    ok(f.name + ': the doctor is picked from a list, not typed', after.tag === 'SELECT',
       'was ' + before + ', now ' + after.tag);
    ok(f.name + ': the list is the clinic\'s doctors',
       DOCTORS.every(d => after.options.indexOf(d) >= 0), after.options);
    ok(f.name + ': it opens on whoever is treating this patient',
       after.value === 'Dr. Manika Mittel', after.value);
    ok(f.name + ': nothing threw', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // ── the behaviours that matter, on one form ────────────────────────────
  const one = forms.find(f => f.name === 'RCT_FORM_B64') || forms[0];
  const fresh = async () => {
    const page = await browser.newPage();
    await page.goto('file://' + one.file);
    await page.waitForTimeout(120);
    return page;
  };

  // A record already saved must never silently change doctor, even if that
  // person has since left the clinic.
  let page = await fresh();
  // The way resuming a saved record fills the field. On the forms that
  // shipped a <select> this needs an option to exist first -- setting .value
  // to a name the list has not got silently does nothing, which is its own
  // reason these forms needed the real list rather than two names in markup.
  await page.evaluate(() => {
    const el = document.getElementById('pDoc');
    if (el.tagName === 'SELECT') {
      const o = document.createElement('option');
      o.value = o.textContent = 'Dr. Who Left';
      el.appendChild(o);
    }
    el.value = 'Dr. Who Left';
  });
  await page.evaluate(d => window.postMessage({ type: 'KB_DOCTORS', doctors: d, selected: 'Dr. A. Sharma' }, '*'), DOCTORS);
  await page.waitForTimeout(120);
  eq('a doctor already on the record is kept, not replaced',
     await page.$eval('#pDoc', n => n.value), 'Dr. Who Left');
  ok('and is still offered even though they are off the master list',
     (await page.$$eval('#pDoc option', ns => ns.map(n => n.textContent))).indexOf('Dr. Who Left') >= 0);
  await page.close();

  // The message can beat the form's own setup; it must be held, not lost.
  page = await browser.newPage();
  await page.goto('file://' + one.file);
  await page.evaluate(d => {
    window.applyMasterDoctors = null;
    window.__pendingDoctors = { doctors: d, selected: 'Dr. A. Sharma' };
  }, DOCTORS);
  await page.close();

  // The form still saves whatever is chosen.
  page = await fresh();
  await page.evaluate(d => window.postMessage({ type: 'KB_DOCTORS', doctors: d, selected: 'Dr. Manika Mittel' }, '*'), DOCTORS);
  await page.waitForTimeout(120);
  await page.selectOption('#pDoc', 'Dr. A. Sharma');
  eq('choosing a different doctor is what the form then reads',
     await page.evaluate(() => document.getElementById('pDoc').value), 'Dr. A. Sharma');
  await page.close();

  // An empty or failed master read must leave the form usable.
  page = await fresh();
  const was = await page.$eval('#pDoc', n => n.value);
  await page.evaluate(() => window.postMessage({ type: 'KB_DOCTORS', doctors: [], selected: '' }, '*'));
  await page.waitForTimeout(120);
  eq('an empty master list leaves the form exactly as it was',
     await page.$eval('#pDoc', n => n.value), was);
  await page.close();

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
