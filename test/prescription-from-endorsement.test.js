// "Automatic prescription formed as per endorsement, with the date part
//  being editable ... so that the prescription is formed only for that."
//
// Stage 2 of the CGHS tab in Records. After the Wellness Centre endorses
// part of a plan, the patient is prescribed those treatments and only
// those. The one thing that must never happen is a procedure the Centre did
// NOT endorse reaching the sheet: it cannot be claimed, and the patient
// would be told they are having it.
//
// The gate itself is checked in cghs-records-stages; this builds the sheet
// and reads it back.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

const RX = html.slice(html.indexOf('function CghsPrescription({ pat, lines }) {'),
                      html.indexOf('function CghsBill('));
ok('the prescription stage was found', RX.length > 400, RX.length);
ok('the date is the clinic’s to set', /onChange: e => setDate\(e\.target\.value\)/.test(RX));
ok('and the sheet prints the date that was set, not today',
   /const when = fmtDMY\(date\) \|\| TODAY;/.test(RX));
ok('it prints on the pad', /cghsPadCss\(pad\)/.test(RX));
ok('and draws no letterhead over the pad’s own',
   RX.indexOf('C. A. R. E. S.') < 0 && !/pH\(window\.LOGO_B64/.test(RX));
// It is no longer bolted onto the medicines form. That form's box prints
// under "Treatments Done", and these are treatments ADVISED, not done.
ok('it does not go through the medicines form’s procedures box',
   !/KB_TODAYS_PROCEDURES/.test(RX));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div></body>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const T="#0078B4", BORDER="#e5e5e0", BGS="#f5f5f0";
    const inp={padding:"6px 10px",fontSize:14,border:"1px solid #e5e5e0",borderRadius:6,
               background:"#fff",color:"#1a1a1a",width:"100%",boxSizing:"border-box",fontFamily:"inherit"};
    const api = () => Promise.resolve({ success:false });
    const signatureLine = (d) => "Dr. A | Date: " + d;
  ` });
  const cut = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
  await page.addScriptTag({ content: cut('const CLINIC_TZ', '\n') + '\n' +
    cut('function fmtDMY(input) {', 'const UPPER_T = [') });
  await page.addScriptTag({ content: cut('function calcAge(dob, today) {', 'function togArr(') });
  await page.addScriptTag({ content: cut('function toISODate(d) {', '\nfunction ') });
  await page.addScriptTag({ content:
    cut('// The pad is pre-printed stationery, so both sheets below', 'function EndorsementView(') });

  const LINES = [
    { at: 0, code: 'DP007', r: { procedure: 'Flap Surgery- Per Tooth', tooth: '16', qty: 1 },
      card: { rate: '450' }, rate: 450, qty: 1, priced: true, amt: 450 },
    { at: 1, code: 'DP014', r: { procedure: 'Scaling', tooth: '26, 27', qty: 2 },
      card: null, rate: 0, qty: 2, priced: false, amt: 0 }
  ];

  const render = (pat, lines) => page.evaluate(([p, l]) => {
    const root = window.__r || (window.__r = ReactDOM.createRoot(document.getElementById('root')));
    root.render(React.createElement(CghsPrescription, { pat: p, lines: l }));
  }, [pat, lines]);
  const printed = () => page.evaluate(() => {
    let captured = '';
    const real = window.open;
    window.open = () => ({ document: { write: h => { captured = h; }, close() {} }, print() {} });
    document.querySelectorAll('button').forEach(b => { if (/Print Prescription/.test(b.textContent)) b.click(); });
    window.open = real;
    return captured;
  });

  await render({ name: 'Santosh', uhid: 'AL1010', dob: '05/07/1968' }, LINES);
  await page.waitForTimeout(250);
  // The date defaults to today and is editable: an endorsement comes back
  // days after it went out, and the sheet is written for the day the
  // patient is in the chair.
  await page.evaluate(() => {
    const el = document.querySelector('input[type=date]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '2026-11-10');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const out = await printed();
  ok('it prints', out.length > 400, out.length);

  const view = await browser.newPage();
  await view.setContent(out);
  const got = await view.evaluate(() => ({
    heads: Array.from(document.querySelectorAll('thead th')).map(t => t.textContent),
    rows: Array.from(document.querySelectorAll('tbody tr')).map(r =>
      Array.from(r.querySelectorAll('td')).map(t => t.textContent)),
    text: document.body.textContent
  }));
  await view.close();
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
  // No money on it: a prescription says what is advised, the bill says what
  // it costs, and the two go to different people.
  ok('no rate or amount is on a prescription',
     !/Rate|Amount|₹/.test(got.text), got.text.slice(0, 220));
  ok('it reserves the pad margins',
     /@page\{size:A4 portrait;margin:44mm 15mm 15mm 52mm;\}/.test(out),
     (/@page[^}]*\}/.exec(out) || [])[0]);

  // A patient with no date of birth, and a date box cleared, must not print
  // "Invalid Date" or "NaN" across a clinical sheet.
  await render({ name: 'Santosh', uhid: 'AL1010', dob: '' }, LINES);
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const el = document.querySelector('input[type=date]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const bare = await printed();
  ok('a blank date falls back to today rather than printing nonsense',
     !/Invalid|NaN|undefined/.test(bare), bare.slice(bare.indexOf('Date'), bare.indexOf('Date') + 120));

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
