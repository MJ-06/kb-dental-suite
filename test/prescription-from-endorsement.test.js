// "Automatic prescription formed as per endorsement, with the date part
//  being editable ... so that the prescription is formed only for that."
//
// After the Wellness Centre endorses some of the proposed treatments, the
// patient is prescribed those and only those. The one thing that must never
// happen here is a procedure the Centre did NOT endorse reaching the sheet:
// it cannot be claimed, and the patient would be told they are having it.
//
// So the filter is tested from the source, and the sheet is built and read
// back rather than inspected as a diff.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── it lives in the patient's own Prescription section ──────────────────
// Not a second CGHS-only screen: a panel patient's prescription is still
// that patient's prescription, and two doors on one room is how the
// Procedures / Notes / Fees screens went wrong before.
const RX = html.slice(html.indexOf('function Prescription({ globalPat }) {'),
                      html.indexOf('// ── Finance — Receipts/Payments'));
ok('it is part of the Prescription section', RX.length > 500, RX.length);
ok('it reads the plan this patient already has',
   /api\("getTreatmentPlan", \{ uhid: globalPat\.uhid \}\)/.test(RX));
ok('only endorsed lines are taken',
   /rows\.filter\(r => r && r\.selected && r\.endApproved && \(r\.procedure \|\| r\.cghsCode\)\)/.test(RX));
ok('the date is the clinic’s to set', /setRxDate\(e\.target\.value\)/.test(RX));
ok('and the sheet prints the date that was set, not today',
   /const when = fmtDMY\(rxDate\) \|\| TODAY;/.test(RX));
ok('it prints on the pad, with the margins the form was given',
   /const m = padMargins \|\| \{ top:"44mm", right:"15mm", bottom:"15mm", left:"52mm", flip:false \};/.test(RX));
ok('and draws no letterhead over the pad’s own',
   RX.indexOf('C. A. R. E. S.') < 0 && !/pH\(window\.LOGO_B64/.test(RX));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="x"></div>');
  const cut = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  // fmtDMY formats in the clinic's own time zone, so that has to come too or
  // it falls through and hands the ISO string back unchanged.
  await page.addScriptTag({ content: cut('const CLINIC_TZ', '\n') + '\n' +
    cut('function fmtDMY(input) {', 'const UPPER_T = [') });
  await page.addScriptTag({ content: cut('function calcAge(dob, today) {', 'function togArr(') });

  // buildRxHTML, lifted out of the component and given what it closes over.
  const src = cut('  const buildRxHTML = () => {', '  const printRx = () => {');
  await page.addScriptTag({ content: `
    const signatureLine = (d) => "Dr. A | Date: " + d;
    window.make = (globalPat, rxEnd, rxDate, padMargins) => {
      ${src}
      return buildRxHTML();
    };
  ` });

  const out = await page.evaluate(() => window.make(
    { name: 'Santosh', uhid: 'AL1010', dob: '05/07/1968' },
    [{ cghsCode: 'DP007', procedure: 'Flap Surgery- Per Tooth', tooth: '16', qty: 1 },
     { cghsCode: 'DP014', procedure: 'Scaling', tooth: '26, 27', qty: 2 }],
    '2026-11-10',
    { top: '44mm', right: '15mm', bottom: '15mm', left: '52mm', flip: false }));

  await page.setContent(out);
  const got = await page.evaluate(() => ({
    heads: Array.from(document.querySelectorAll('thead th')).map(t => t.textContent),
    rows: Array.from(document.querySelectorAll('tbody tr')).map(r =>
      Array.from(r.querySelectorAll('td')).map(t => t.textContent)),
    text: document.body.textContent
  }));

  eq('the sheet lists Sn, code, treatment, tooth and units',
     got.heads, ['Sn', 'Code', 'Treatment Advised', 'Tooth Number', 'No. of Units']);
  eq('every endorsed line is on it, numbered', got.rows,
     [['1', 'DP007', 'Flap Surgery- Per Tooth', '16', '1'],
      ['2', 'DP014', 'Scaling', '26, 27', '2']]);
  ok('it is a prescription, not another endorsement request',
     /Prescription/i.test(got.text) && !/Request for Endorsement/i.test(got.text), got.text.slice(0, 120));
  ok('the patient and their age are on it',
     /Santosh/.test(got.text) && /AL1010/.test(got.text) && /Age\s*58(?!\d)/i.test(got.text),
     got.text.slice(0, 200));
  ok('the date printed is the one that was set, not today',
     /10\/11\/2026/.test(got.text), got.text.slice(0, 220));
  ok('the doctor signs it', /Signature of the Doctor/i.test(got.text));
  // It goes on pre-printed stationery, so it must keep clear of what is
  // already on the paper and add no letterhead of its own.
  ok('it reserves the pad margins',
     /@page\{size:A4 portrait;margin:44mm 15mm 15mm 52mm;\}/.test(out),
     (/@page[^}]*\}/.exec(out) || [])[0]);
  ok('and prints no letterhead', !/DILSHAD GARDEN/i.test(out) && !/C\. ?A\. ?R\. ?E\. ?S/.test(out));

  // A pad that is taken the other way round turns both sheets, or the
  // prescription and the endorsement come out of it differently.
  const flipped = await page.evaluate(() => window.make(
    { name: 'Santosh', uhid: 'AL1010', dob: '05/07/1968' },
    [{ cghsCode: 'DP007', procedure: 'Flap', tooth: '16', qty: 1 }],
    '2026-11-10',
    { top: '44mm', right: '15mm', bottom: '15mm', left: '52mm', flip: true }));
  ok('an upside-down pad swaps the reserved space and turns the page',
     /margin:15mm 52mm 44mm 15mm;/.test(flipped) && /rotate\(180deg\)/.test(flipped),
     (/@page[^}]*\}/.exec(flipped) || [])[0]);

  // An empty date must not print "Invalid Date" across a clinical sheet.
  const nodate = await page.evaluate(() => window.make(
    { name: 'Santosh', uhid: 'AL1010', dob: '' }, [], '',
    { top: '44mm', right: '15mm', bottom: '15mm', left: '52mm', flip: false }));
  ok('a blank date falls back to today rather than printing nonsense',
     !/Invalid|NaN|undefined/.test(nodate), (/Date<\/div><div class="val">([^<]*)/.exec(nodate) || [])[1]);
  ok('and a patient with no date of birth prints no age rather than a wrong one',
     !/Invalid|NaN/.test(nodate));

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
