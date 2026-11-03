// "Now I want to add Endorsement (CGHS) on the Treatment Plan sheet."
//
// A panel patient's treatment plan goes to their Wellness Centre to be
// endorsed before the work starts, and it is endorsed against the PANEL's
// rate card — the panel's code and the panel's rate — never against what
// the clinic charges a private patient. Document 3 is what the beneficiary
// carries there.
//
// The thing that can quietly ruin this is the code. The clinic's procedure
// names do not carry panel codes, so each row has to be matched to one, and
// a wrong code is a rejected claim. So the matching is driven here, not
// read: it must match only what is unambiguous, must never overrule a code
// chosen by hand, and must leave the rest visibly blank.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── wiring, in the source ───────────────────────────────────────────────
ok('there is a third document on the Treatment Plan',
   /\["endorsement", "Document 3 — Endorsement \(CGHS\)"\]/.test(html));
ok('it prints and previews through the same switch as the other two',
   /which === "endorsement" \? buildEndHTML\(\)/.test(html));
ok('the rates come from the panel rate card, not the plan fees',
   /api\("getPanelRates", \{ panel: patPanel \}\)/.test(html));
ok('the chosen code is carried on the plan row, so it is saved with the plan',
   /i === at \? \{ \.\.\.r, cghsCode: code \} : r/.test(html));

const A = html.indexOf('function EndorsementView({');
const B = html.indexOf('\n// DASHBOARD', A);
ok('the screen was found', A > 0 && B > A, `${A}..${B}`);
const VIEW = html.slice(A, B);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<body style="margin:0;padding:24px;font-family:system-ui"><div id="root"></div></body>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const T="#0078B4", BORDER="#e5e5e0", BGS="#f5f5f0";
    const inp={padding:"6px 10px",fontSize:14,border:"1px solid #e5e5e0",borderRadius:6,
               background:"#fff",color:"#1a1a1a",width:"100%",boxSizing:"border-box",fontFamily:"inherit"};
    function SaveBtn({ onClick, saving, saved }) {
      return React.createElement("button", { onClick, aria-label: "save" }, saved ? "Saved" : "Save");
    }
  `.replace('aria-label: "save"', '"aria-label": "save"') });
  await page.addScriptTag({ content: VIEW });

  // The real matching lives in the component that owns the plan, so it is
  // sliced out and run here too rather than being re-implemented.
  const pick = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  await page.addScriptTag({ content:
    'window.__match = (panelRates) => {' +
    pick('  const normName = (v) =>', '  const endRows = tpRows') +
    ' return { autoCode, codeFor, rateByCode }; };' });

  // ── matching, on a card that holds the trap ───────────────────────────
  // Two rows named the same with different codes is exactly what a CGHS
  // card looks like, and exactly what must not be guessed at.
  const m = await page.evaluate(() => {
    const rates = [
      { code: 'DP030', procedure: 'Root Canal Treatment - Single Rooted', rate: '1000' },
      { code: 'DP031', procedure: 'Root Canal Treatment - Multi Rooted', rate: '1500' },
      { code: 'DP001', procedure: 'Consultation', rate: '150' },
      { code: 'DP002', procedure: 'Consultation', rate: '200' }
    ];
    const { autoCode, codeFor } = window.__match(rates);
    return {
      exact: autoCode('Root Canal Treatment - Single Rooted'),
      spacing: autoCode('root canal treatment   single rooted'),
      ambiguous: autoCode('Consultation'),
      unknown: autoCode('Zirconia Crown'),
      blank: autoCode(''),
      matched: codeFor({ procedure: 'Root Canal Treatment - Multi Rooted' }),
      byHand: codeFor({ procedure: 'Root Canal Treatment - Multi Rooted', cghsCode: 'DP030' }),
      clearedByHand: codeFor({ procedure: 'Root Canal Treatment - Multi Rooted', cghsCode: '' })
    };
  });
  eq('a name on the card once is matched', m.exact, 'DP030');
  eq('punctuation and spacing do not stop it', m.spacing, 'DP030');
  eq('a name on the card twice is NOT guessed at', m.ambiguous, '');
  eq('a name not on the card is left blank', m.unknown, '');
  eq('and a row with no procedure matches nothing', m.blank, '');
  eq('an unset row falls back to the match', m.matched, 'DP031');
  eq('a code chosen by hand beats the match', m.byHand, 'DP030');
  eq('and one cleared by hand stays cleared, rather than being re-matched',
     m.clearedByHand, '');

  // ── the screen ────────────────────────────────────────────────────────
  const mount = (props) => page.evaluate((p) => {
    window.__set = [];
    const e = React.createElement;
    const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
    root.render(e(EndorsementView, Object.assign({
      setCode: (at, code) => window.__set.push([at, code]),
      onSave(){}, onPreview(){}, onPrint(){}, saving: false, saved: false
    }, p)));
  }, props);

  const RATES = [
    { code: 'DP030', procedure: 'RCT Single Rooted', rate: '1000' },
    { code: 'DP035', procedure: 'Crown - Metal', rate: '800' }
  ];

  // A patient with no panel has nothing to endorse, and saying so is the
  // whole job of that state: an empty table would read as broken.
  await mount({ pat: { name: 'Asha Rao', uhid: 'KB1' }, panel: '', rates: [], ratesMsg: '',
                rows: [], total: 0, missing: 0 });
  const noPanel = await page.textContent('#root');
  ok('a patient with no panel is told why there is nothing here',
     /not recorded against a panel/.test(noPanel), noPanel.slice(0, 90));
  ok('and is told where the panel is set', /registration/.test(noPanel));

  // Nothing ticked on Document 1.
  await mount({ pat: { name: 'Asha Rao', uhid: 'KB1', 'Card ID': 'C-77', 'Panel Category': 'Pensioner' },
                panel: 'CGHS', rates: RATES, ratesMsg: '', rows: [], total: 0, missing: 0 });
  ok('an empty plan says to tick the procedures first',
     /Tick the procedures on the treatment plan/.test(await page.textContent('#root')));

  // The real thing: two priced rows and one with no code yet.
  const rows = [
    { at: 0, r: { tooth: '16', procedure: 'RCT Single Rooted', qty: 1 }, code: 'DP030',
      card: RATES[0], rate: 1000, qty: 1, amt: 1000 },
    { at: 1, r: { tooth: '26', procedure: 'Crown - Metal', qty: 2 }, code: 'DP035',
      card: RATES[1], rate: 800, qty: 2, amt: 1600 },
    { at: 2, r: { tooth: '36', procedure: 'Something the card does not list', qty: 1 }, code: '',
      card: null, rate: 0, qty: 1, amt: 0 }
  ];
  await mount({ pat: { name: 'Asha Rao', uhid: 'KB1', 'Card ID': 'C-77', 'Panel Category': 'Pensioner' },
                panel: 'CGHS', rates: RATES, ratesMsg: '', rows, total: 2600, missing: 1 });

  const text = await page.textContent('#root');
  ok('the card details the Wellness Centre checks are on screen',
     /C-77/.test(text) && /Pensioner/.test(text), text.slice(0, 160));
  ok('it says the rates are the panel\'s, not the clinic\'s',
     /not the clinic's own fees/.test(text));
  ok('a row with no code is called out rather than printing quietly',
     /1 of 3 procedure\(s\) have no CGHS code/.test(text), text.slice(0, 400));
  const amounts = await page.$$eval('tbody tr td:last-child', t => t.map(x => x.textContent));
  eq('each row is priced at the panel rate times its quantity',
     amounts, ['₹1,000', '₹1,600', 'no rate']);
  ok('and the total is the panel total', /₹2,600/.test(text), text.slice(-200));

  // The picker must show the code the row actually holds.
  const selected = await page.$$eval('tbody tr select', s => s.map(x => x.value));
  eq('every picker shows the row\'s own code', selected, ['DP030', 'DP035', '']);
  const firstOpts = await page.$$eval('tbody tr:nth-child(1) select option', o => o.map(x => x.value));
  eq('the picker offers the blank and the whole card', firstOpts, ['', 'DP030', 'DP035']);

  // A code that is no longer on the saved card must still show as itself,
  // not silently fall back to whatever option happens to come first.
  await mount({ pat: { name: 'Asha Rao', uhid: 'KB1' }, panel: 'CGHS', rates: RATES, ratesMsg: '',
    rows: [{ at: 0, r: { tooth: '16', procedure: 'Old procedure', qty: 1 }, code: 'DP999',
             card: null, rate: 0, qty: 1, amt: 0 }], total: 0, missing: 0 });
  eq('a code no longer on the card still shows as itself',
     await page.$eval('tbody tr select', s => s.value), 'DP999');

  // Choosing a code reaches the plan, addressed by position.
  await mount({ pat: { name: 'Asha Rao', uhid: 'KB1' }, panel: 'CGHS', rates: RATES, ratesMsg: '',
                rows, total: 2600, missing: 1 });
  await page.selectOption('tbody tr:nth-child(3) select', 'DP035');
  eq('choosing a code hands the plan the row position and the code',
     await page.evaluate(() => window.__set), [[2, 'DP035']]);

  // Printing an endorsement with no procedures on it is not useful.
  await mount({ pat: { name: 'Asha Rao', uhid: 'KB1' }, panel: 'CGHS', rates: RATES, ratesMsg: '',
                rows: [], total: 0, missing: 0 });
  const offWhenEmpty = await page.$$eval('button', b => b.filter(x => /Print|Preview/.test(x.textContent)).map(x => x.disabled));
  eq('Print and Preview are off while there is nothing to endorse', offWhenEmpty, [true, true]);

  // A rate card that could not be read must say so: a sheet where every
  // rate is blank is worse than no sheet.
  await mount({ pat: { name: 'Asha Rao', uhid: 'KB1' }, panel: 'CGHS', rates: [],
                ratesMsg: 'The CGHS rate card could not be read, so no codes or rates can be filled in. Try reloading the patient.',
                rows: [], total: 0, missing: 0 });
  ok('a rate card that failed to load is reported',
     /could not be read/.test(await page.textContent('#root')));

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
