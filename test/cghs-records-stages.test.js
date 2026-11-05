// "In Records, a CGHS tab where we see 3 tabs: 1. endorsements done with
//  clicks so we click what all is approved, moves to next 2 tabs
//  prescription and bill. This will be a clear demarcation."
//
// A panel case runs in three stages, days apart. The Treatment Plan writes
// the request; Records records the answer and acts on it. The rule that
// matters is the same at both later stages: a procedure the Wellness Centre
// did NOT endorse cannot be prescribed and cannot be claimed, so it must
// never reach either sheet.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the three stages, in order, under Records ───────────────────────────
// It stands BESIDE Clinical Records on the Records page, not inside it as a
// tab: a panel claim is its own run of work, not a view of the clinical
// record, and it is reached without going through one first.
ok('CGHS is listed on the Records page beside Clinical Records',
   /\{ id:"clinical_records", label:"[^"]*Clinical Records"\s*\},[\s\S]{0,400}?\{ id:"cghs",\s+label:"[^"]*CGHS"\s*\},/.test(html));
ok('it is a page of its own',
   /page === "cghs" && \/\*#__PURE__\*\/React\.createElement\("div", null,/.test(html));
ok('and it renders the CGHS stages',
   /React\.createElement\(CghsRecords, \{ key:\(globalPat&&globalPat\.uhid\)\|\|"x", globalPat:globalPat \}\)/.test(html));
ok('Records stays lit in the sidebar while you are on it',
   /page === "daily_register" \|\| page === "cghs"\)/.test(html));
ok('and it is no longer a tab inside Clinical Records',
   !/\{id:"cghs",label:/.test(html) && !/section === "cghs"/.test(html));
ok('there are three stages, numbered in the order they happen',
   /\{ id: "endorsement", label: "1 \\u00b7 Endorsement" \}[\s\S]{0,200}?\{ id: "bill", label: "3 \\u00b7 Bill" \}/.test(html)
   || /id: "endorsement"[\s\S]{0,200}?id: "prescription"[\s\S]{0,120}?id: "bill"/.test(html));
// The two later stages take `approved`, never `endRows`: that is the gate.
ok('the prescription is handed only the endorsed lines',
   /CghsPrescription, \{ pat: globalPat, lines: e\.approved \}/.test(html));
ok('and so is the bill',
   /CghsBill, \{ pat: globalPat, panel: e\.panel, card: e\.card,\s*holder: e\.holder, lines: e\.approved \}/.test(html));
ok('with nothing ticked, neither stage is drawn at all',
   /stage === "prescription" && \(e\.approved\.length/.test(html) &&
   /stage === "bill" && \(e\.approved\.length/.test(html));
// Records keeps its own copy of the plan: the two screens are opened at
// different times, and a shared live state would let whichever was open
// last decide what is saved.
ok('Records loads the plan itself', /api\("getTreatmentPlan", \{ uhid \}\)/.test(html));
ok('and hands the estimate back untouched when it saves',
   /rows, estimate: estimate \|\| \{\}/.test(html));
ok('it refuses to save a plan it never managed to read',
   /if \(loadErr \|\| !loaded\) \{/.test(html));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
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
    window.CLINIC = { name: "K.B. Dental Clinic" };
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
    { at: 1, code: 'DP014', r: { procedure: 'Scaling & Polishing', tooth: 'Full mouth', qty: 2 },
      card: { rate: '345' }, rate: 345, qty: 2, priced: true, amt: 690 }
  ];
  const PAT = { name: 'Santosh', uhid: 'AL1010', dob: '05/07/1968', gender: 'Male',
                address: '78-C Pocket A' };

  // ── rupees in words, which a clerk reads against the figure ───────────
  const words = await page.evaluate(() => [0, 1, 11, 19, 20, 95, 100, 345, 795, 8111, 100000, 1234567]
    .map(n => window.rupeesInWords ? window.rupeesInWords(n) : rupeesInWords(n)));
  eq('the amount in words follows the Indian system, and agrees with the figure', words, [
    'Rupees Zero Only.', 'Rupees One Only.', 'Rupees Eleven Only.', 'Rupees Nineteen Only.',
    'Rupees Twenty Only.', 'Rupees Ninety Five Only.', 'Rupees One Hundred Only.',
    'Rupees Three Hundred Forty Five Only.', 'Rupees Seven Hundred Ninety Five Only.',
    'Rupees Eight Thousand One Hundred Eleven Only.', 'Rupees One Lakh Only.',
    'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Only.']);

  // ── the bill, as the clinic's own format ──────────────────────────────
  const grab = (comp, props) => page.evaluate(([c, p]) => {
    let captured = '';
    const real = window.open;
    window.open = () => ({ document: { write: h => { captured = h; }, close() {} }, print() {} });
    const root = window.__r || (window.__r = ReactDOM.createRoot(document.getElementById('root')));
    root.render(React.createElement(c === 'bill' ? CghsBill : CghsPrescription, p));
    return new Promise(res => setTimeout(() => {
      document.querySelectorAll('button').forEach(b => { if (/^🖨/.test(b.textContent)) b.click(); });
      window.open = real;
      res(captured);
    }, 250));
  }, [comp, props]);

  const bill = await grab('bill', { pat: PAT, panel: 'CGHS', card: '20542260',
                                    holder: 'Pensioner', lines: LINES });
  ok('a bill will not print without its number', bill === '', bill.slice(0, 80));

  // The number comes from the server. With no backend answering, the box is
  // still typeable: a backend that has not been redeployed must not stop a
  // clinic billing -- it just means the clinic keeps the series itself.
  ok('there is a button to take the next number from the server',
     (await page.$$eval('button', b => b.filter(x => /Issue bill number/.test(x.textContent)).length)) === 1);
  await page.evaluate(() => {
    const el = document.querySelector('input[placeholder="not issued yet"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '2026110001');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const billed = await page.evaluate(() => {
    let captured = '';
    const real = window.open;
    window.open = () => ({ document: { write: h => { captured = h; }, close() {} }, print() {} });
    document.querySelectorAll('button').forEach(b => { if (/Print Bill/.test(b.textContent)) b.click(); });
    window.open = real;
    return captured;
  });
  ok('with a number, it prints', billed.length > 400, billed.length);

  await page.setContent(billed);
  const b = await page.evaluate(() => ({
    heads: Array.from(document.querySelectorAll('thead th')).map(t => t.textContent),
    rows: Array.from(document.querySelectorAll('tbody tr')).map(r =>
      Array.from(r.querySelectorAll('td')).map(t => t.textContent)),
    text: document.body.textContent
  }));
  eq('the columns are the clinic’s bill, in its order', b.heads,
     ['Sn', 'Tooth No', 'Code', 'Description', 'Unit', 'Rate (In Rs.)', 'Amount (In Rs.)']);
  eq('a line reads across in that order', b.rows[0],
     ['1', '16', 'DP007', 'Flap Surgery- Per Tooth', '1', '450', '450']);
  ok('the bill number and date are on it', /2026110001/.test(b.text), b.text.slice(0, 160));
  // Registration No is the CGHS card, not the clinic's own UHID.
  ok('Registration No carries the card, not the UHID',
     /Registration No\s*:\s*20542260/.test(b.text) && !/AL1010/.test(b.text), b.text.slice(0, 220));
  ok('age and gender print together', /Age\/Gender\s*:\s*58\/M/.test(b.text), b.text.slice(0, 220));
  ok('the panel category reads as the panel and the holder',
     /CGHS PENSIONER/.test(b.text), b.text.slice(0, 220));
  ok('the total and its words agree',
     /1,140/.test(b.text) && /Rupees One Thousand One Hundred Forty Only/.test(b.text),
     b.text.slice(-200));
  ok('both signatures are on it',
     /Patient Signature/i.test(b.text) && /Authorised Signatory/i.test(b.text));
  ok('and it draws no letterhead over the pad’s own',
     !/DILSHAD GARDEN/i.test(billed) && /@page\{size:A4 portrait;margin:44mm 15mm 15mm 52mm;\}/.test(billed),
     (/@page[^}]*\}/.exec(billed) || [])[0]);

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
