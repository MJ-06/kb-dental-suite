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
   /i !== at \? r : \{\s*\.\.\.r, cghsCode: code,/.test(html));
// A line started on the endorsement has no name until a code is picked, so
// picking one names it -- otherwise it would print as a blank treatment.
ok('picking a code on the card names the line',
   /procedure: card \? String\(card\.procedure \|\| ""\) : r\.procedure/.test(html));
ok('and typing a treatment the card names once finds its code',
   /const found = autoCode\(name\);/.test(html) &&
   /found \? \{ \.\.\.r, procedure: name, cghsCode: found \} : \{ \.\.\.r, procedure: name \}/.test(html));
ok('a line can be started on the endorsement itself',
   /selected: true, endAdded: true/.test(html));
ok('and such a line reaches the sheet without Document 1',
   /x\.r\.selected && \(x\.r\.procedure \|\| x\.r\.endAdded\)/.test(html));

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
  // The tooth grid is the app's own, not a stand-in: the complaint was
  // that it was missing, so the real one has to be on this screen.
  await page.addScriptTag({ content:
    html.slice(html.indexOf('const TOOTH_REGIONS = ['), html.indexOf('\n', html.indexOf('const LOWER_T = ['))) });
  await page.addScriptTag({ content:
    html.slice(html.indexOf('function ToothChart({'), html.indexOf('function ClinicHeader()')) });
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
  // What was reported: "in endorsement selection why is the tooth grid gone
  // from where i will select the tooth number, where is the print tab, I
  // feel the system is incomplete and practically non-workable."
  //
  // Both came from one decision: the screen refused to draw at all unless
  // the patient's registration carried a panel, and a patient registered
  // before those fields existed carries none. That left a single line of
  // text — no table, no teeth, no Print. So the case that matters most
  // here is the patient with NO panel on record.
  // $eval waits for its selector; $$eval does not, so a mount has to settle
  // before anything reads the DOM or a case silently measures the last one.
  const mount = async (props) => { await mountNow(props); await page.waitForTimeout(120); };
  const mountNow = (props) => page.evaluate((p) => {
    window.__set = []; window.__field = []; window.__tooth = []; window.__panel = [];
    window.__added = 0; window.__removed = [];
    window.__card = []; window.__holder = []; window.__savedPanel = 0; window.__proc = [];
    const e = React.createElement;
    const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
    // A fresh key each time: rendering the same component into the same
    // root keeps its state, so without this every later case would still be
    // holding the rows of the one before it.
    window.__n = (window.__n || 0) + 1;
    root.render(e(window.Harness, Object.assign({ key: window.__n }, p)));
  }, props);

  // A harness that holds the row state, so an edit can be seen to land.
  await page.addScriptTag({ content: `
    window.Harness = function (props) {
      const [rows, setRows] = React.useState(props.rows);
      const [active, setActive] = React.useState(null);
      const edit = (at, f, v) => setRows(rs => rs.map(x => x.at === at ? { ...x, r: { ...x.r, [f]: v } } : x));
      return React.createElement(EndorsementView, Object.assign({}, props, {
        rows: rows, active: active, setActive: setActive,
        setCode: (at, code) => window.__set.push([at, code]),
        onPanel: (p) => window.__panel.push(p),
        setRowField: (at, f, v) => { window.__field.push([at, f, v]); edit(at, f, v); },
        onTooth: (t) => {
          window.__tooth.push(t);
          setRows(rs => rs.map(x => {
            if (x.at !== active) return x;
            const have = String(x.r.tooth || "").split(",").map(s => s.trim()).filter(Boolean);
            const w = String(t);
            const next = have.indexOf(w) >= 0 ? have.filter(s => s !== w) : have.concat(w);
            return { ...x, r: { ...x.r, tooth: next.join(", ") } };
          }));
        },
        onCard: (v) => window.__card.push(v),
        onHolder: (v) => window.__holder.push(v),
        onSavePanel: () => { window.__savedPanel++; },
        setProcedure: (at, v) => { window.__proc.push([at, v]);
          setRows(rs => rs.map(x => x.at === at ? { ...x, r: { ...x.r, procedure: v } } : x)); },
        onAdd: () => { window.__added++; },
        onRemove: (at) => { window.__removed.push(at); },
        onSave(){}, onPreview(){}, onPrint(){}, saving: false, saved: false }));
    };
  ` });

  const RATES = [
    { code: 'DP030', procedure: 'RCT Single Rooted', rate: '1000' },
    { code: 'DP035', procedure: 'Crown - Metal', rate: '800' }
  ];
  const PAT = { name: 'Asha Rao', uhid: 'KB1', cardId: 'C-77', panelCategory: 'Pensioner' };
  // The card details now come in as their own props, because they are typed
  // on this screen rather than only read from the record.
  // Every case below is the RECORDS stage of this document: the one with
  // the ticks, where what came back endorsed is recorded. The Treatment
  // Plan stage, which writes the request and has no ticks, is checked on
  // its own at the end.
  const CARD = { showApproved: true, card: 'C-77', holder: 'Pensioner',
                 panelSaving: false, panelSaved: false };
  const mkRows = () => ([
    { at: 0, r: { tooth: '16', procedure: 'RCT Single Rooted', qty: 1 }, code: 'DP030',
      card: RATES[0], rate: 1000, qty: 1, priced: true, amt: 1000 },
    { at: 1, r: { tooth: '', procedure: 'Crown - Metal', qty: 2 }, code: 'DP035',
      card: RATES[1], rate: 800, qty: 2, priced: true, amt: 1600 }
  ]);

  // ── the patient with no panel on record ───────────────────────────────
  await mount({ ...CARD, pat: PAT, panel: '', recordedPanel: '', panels: ['CGHS', 'DGEHS'],
                rates: [], ratesMsg: '', rows: mkRows(), total: 2600, missing: 0, approvedCount: 0, approvedTotal: 0 });
  const noPanel = await page.textContent('#root');
  eq('a patient with no panel still gets the sheet, not a dead end',
     (await page.$$('tbody tr')).length, 2);
  eq('the tooth grid is there even then', (await page.$$('button[title^="#"]')).length, 32);
  eq('and Print is there and usable',
     await page.$$eval('button', b => b.filter(x => /Print Endorsement/.test(x.textContent)).map(x => x.disabled)),
     [false]);
  ok('it says the panel is missing and can be chosen here',
     /none on their registration/.test(noPanel), noPanel.slice(0, 220));

  // The picker must offer the panels master, so the fix is on this screen.
  eq('the panel picker offers every panel the clinic has',
     await page.$eval('#root select', s => Array.from(s.options).map(o => o.value)), ['', 'CGHS', 'DGEHS']);
  await page.selectOption('#root select', 'CGHS');
  eq('choosing one is handed up', await page.evaluate(() => window.__panel), ['CGHS']);

  // A panel recorded on the patient but missing from the master must still
  // be offered, or it would vanish from its own sheet.
  await mount({ ...CARD, pat: PAT, panel: 'BSES', recordedPanel: 'BSES', panels: ['CGHS'],
                rates: [], ratesMsg: '', rows: mkRows(), total: 0, missing: 0, approvedCount: 0, approvedTotal: 0 });
  eq('a panel not in the master is still offered',
     await page.$eval('#root select', s => Array.from(s.options).map(o => o.value)), ['', 'BSES', 'CGHS']);
  eq('and is the one selected', await page.$eval('#root select', s => s.value), 'BSES');

  // ── the working screen ────────────────────────────────────────────────
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'],
                rates: RATES, ratesMsg: '', rows: mkRows(), total: 2600, missing: 0, approvedCount: 0, approvedTotal: 0 });
  const text = await page.textContent('#root');
  eq('the card details are boxes you can type into, not a line of text',
     await page.$$eval('#root > div > div:first-child input, #root > div > div:first-child select',
       f => f.map(x => [x.tagName.toLowerCase(), x.value])),
     [['select', 'CGHS'], ['select', 'Pensioner'], ['input', 'C-77']]);
  // The point of typing them here is that they stay: a card entered at the
  // chair and lost at the next refresh is worse than one never entered.
  await page.fill('#root > div > div:first-child input', 'C-99');
  eq('a card ID typed here is handed up', (await page.evaluate(() => window.__card)).slice(-1), ['C-99']);
  await page.selectOption('#root > div > div:first-child select >> nth=1', 'Serving');
  eq('and so is the card holder', await page.evaluate(() => window.__holder), ['Serving']);
  await page.click('text=Save to patient');
  eq('and they are saved onto the patient', await page.evaluate(() => window.__savedPanel), 1);
  eq('the columns are in the printed order, with the rate and amount alongside',
     await page.$$eval('thead th', t => t.map(x => x.textContent)),
     ['Endorsed', 'Code', 'Treatment Advised', 'Tooth Number', 'Units', 'Rate', 'Amount', '']);
  eq('each row is priced at the panel rate times its quantity',
     await page.$$eval('tbody tr td:nth-child(7)', t => t.map(x => x.textContent)),
     ['₹1,000', '₹1,600']);
  // The RATE is held: the card is the claim and a rate edited over it would
  // be a wrong one. The treatment is not, because typing it is one of the
  // two ways round a line gets filled in.
  eq('a code on the card fills the treatment and rate, and holds the rate',
     await page.$$eval('tbody tr:nth-child(1) input:not([type=checkbox])', i =>
       i.map(x => [x.value, x.readOnly])),
     [['DP030', false], ['RCT Single Rooted', false], ['16', false], ['1', false], ['1000', true]]);
  // Nothing shouts at you once the screen is in order: a notice that is
  // always there stops being read.
  ok('with a panel, a rate card and every code picked, there is no notice at all',
     !/⚠|have no code yet|could not be read|which panel/.test(
       await page.$$eval('#root > div', d => d.map(x => x.textContent).slice(1, 2).join(''))),
     text.slice(0, 200));

  // ── what came back endorsed ─────────────────────────────
  // The sheet goes out as a request; what comes back is a decision, line by
  // line. Only endorsed lines may be prescribed and only they may be billed,
  // so this tick is what both of those will read.
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'],
                rates: RATES, ratesMsg: '', rows: mkRows(), total: 2600, missing: 0,
                approvedCount: 0, approvedTotal: 0 });
  eq('every line has a tick for coming back endorsed',
     (await page.$$('tbody tr input[type=checkbox]')).length, 2);
  eq('and none is ticked to begin with',
     await page.$$eval('tbody tr input[type=checkbox]', c => c.map(x => x.checked)), [false, false]);
  await page.check('tbody tr:nth-child(2) input[type=checkbox]');
  eq('ticking one reaches the plan, for the right line',
     (await page.evaluate(() => window.__field)).slice(-1), [[1, 'endApproved', true]]);
  await page.uncheck('tbody tr:nth-child(2) input[type=checkbox]');
  eq('and un-ticking it says so',
     (await page.evaluate(() => window.__field)).slice(-1), [[1, 'endApproved', false]]);

  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'],
                rates: RATES, ratesMsg: '',
                rows: mkRows().map((r, i) => i === 0 ? { ...r, r: { ...r.r, endApproved: true } } : r),
                total: 2600, missing: 0, approvedCount: 1, approvedTotal: 1000 });
  eq('a line that came back endorsed shows as ticked',
     await page.$$eval('tbody tr input[type=checkbox]', c => c.map(x => x.checked)), [true, false]);
  const endText = await page.textContent('#root');
  ok('the screen says how many were endorsed', /1 of 2 endorsed/.test(endText), endText.slice(-200));
  ok('and what they come to, apart from the total asked for',
     /Endorsed:\s*\u20b91,000/.test(endText) && /\u20b92,600/.test(endText), endText.slice(-200));

  // The printed sheet IS the request. A request that ticks its own answers
  // is not one, so the tick stays on screen.
  // ── the two boxes fill each other in ──────────────────────────────────
  // "Is it possible to enter the treatment and accordingly the code comes —
  //  I mean either ways it should work."
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'],
                rates: RATES, ratesMsg: '', rows: mkRows(), total: 2600, missing: 0, approvedCount: 0, approvedTotal: 0 });
  eq('the treatment box suggests every treatment on the card',
     await page.$$eval('datalist#kb-panel-treatments option', o => o.map(x => x.value)),
     ['RCT Single Rooted', 'Crown - Metal']);
  await page.fill('tbody tr:nth-child(1) td:nth-child(3) input', 'Crown - Metal');
  eq('typing a treatment reaches the plan, which finds its code',
     (await page.evaluate(() => window.__proc)).slice(-1), [[0, 'Crown - Metal']]);
  ok('the treatment box is never locked, so either box can be the first one',
     await page.$eval('tbody tr:nth-child(1) td:nth-child(3) input', i => i.readOnly) === false);
  // The source that does the matching, run directly: a name the card carries
  // once finds its code, a name it carries twice is left alone.
  const two = await page.evaluate(() => {
    const { autoCode } = window.__match([
      { code: 'DP030', procedure: 'RCT Single Rooted', rate: '1000' },
      { code: 'DP040', procedure: 'Scaling', rate: '300' },
      { code: 'DP041', procedure: 'Scaling', rate: '400' }
    ]);
    return [autoCode('RCT Single Rooted'), autoCode('Scaling')];
  });
  eq('a treatment the card names once finds its code; one it names twice does not',
     two, ['DP030', '']);

  // ── the tooth grid ────────────────────────────────────────────────────
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'],
                rates: RATES, ratesMsg: '', rows: mkRows(), total: 2600, missing: 0, approvedCount: 0, approvedTotal: 0 });
  ok('the grid starts by saying it needs a row',
     /Click a line above, then click its teeth/.test(await page.textContent('#root')));
  // Above the table, the way Document 1 is laid out.
  ok('the grid sits above the table, as it does on the treatment plan',
     await page.evaluate(() => {
       const grid = document.querySelector('button[title="#18"]');
       const table = document.querySelector('table');
       return !!(grid && table) &&
         (grid.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
     }));
  // The grid is shared with Document 1, where clicking fills the next empty
  // row. Here it toggles teeth on one chosen row, so it must not keep
  // promising the other thing.
  ok('and the grid does not repeat Document 1\'s promise',
     !/fill next empty row/.test(await page.textContent('#root')),
     await page.textContent('#root'));
  // Clicking a tooth with no row chosen must do nothing rather than guess:
  // a tooth on the wrong line of a claim is worse than one not yet set.
  await page.click('button[title="#26"]');
  eq('a tooth clicked with no row chosen is ignored',
     await page.evaluate(() => window.__tooth), []);

  await page.click('tbody tr:nth-child(2) td:nth-child(3)');
  ok('choosing a row says which procedure the teeth are for',
     /Teeth for Crown - Metal/.test(await page.textContent('#root')));
  eq('and the row can be taken off the sheet',
     await (async () => { await page.click('tbody tr:nth-child(1) td:last-child button');
       return page.evaluate(() => window.__removed); })(), [0]);
  ok('and says what clicking a tooth will do',
     /click it again to take it off/.test(await page.textContent('#root')));
  await page.click('button[title="#26"]');
  await page.click('button[title="#16"]');
  eq('clicking teeth puts them on that row',
     await page.$eval('tbody tr:nth-child(2) td:nth-child(4) input', i => i.value), '26, 16');
  await page.click('button[title="#26"]');
  eq('and clicking one again takes it off',
     await page.$eval('tbody tr:nth-child(2) td:nth-child(4) input', i => i.value), '16');
  eq("the first row's tooth was never touched",
     await page.$eval('tbody tr:nth-child(1) td:nth-child(4) input', i => i.value), '16');

  // ── typing instead of clicking ────────────────────────────────────────
  await page.fill('tbody tr:nth-child(1) td:nth-child(4) input', '16, 26');
  eq('a tooth can be typed as well as clicked',
     (await page.evaluate(() => window.__field)).slice(-1), [[0, 'tooth', '16, 26']]);
  await page.fill('tbody tr:nth-child(1) td:nth-child(5) input', '3');
  eq('and the number of units is editable here',
     (await page.evaluate(() => window.__field)).slice(-1), [[0, 'qty', '3']]);
  await page.fill('tbody tr:nth-child(1) td:nth-child(5) input', '2x');
  eq('units take digits only',
     await page.$eval('tbody tr:nth-child(1) td:nth-child(5) input', i => i.value), '2');

  // ── nothing ticked on Document 1 ──────────────────────────────────────
  // The case that caused the report: Document 1 is empty for this patient,
  // so the endorsement used to show nothing at all. It must still be a
  // working screen -- a grid, a way to add a line, and a say in what to do.
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'],
                rates: RATES, ratesMsg: '', rows: [], total: 0, missing: 0, approvedCount: 0, approvedTotal: 0 });
  const empty = await page.textContent('#root');
  ok('an empty plan still draws the sheet and says how to fill it',
     /Nothing on the endorsement yet/.test(empty), empty.slice(0, 220));
  eq('the tooth grid is there with no lines at all',
     (await page.$$('button[title^="#"]')).length, 32);
  ok('and the grid says to add a treatment first',
     /Add a treatment above, then click its teeth/.test(empty));
  await page.click('text=+ Add a treatment');
  eq('adding a treatment is one click, with no Document 1 involved',
     await page.evaluate(() => window.__added), 1);
  eq('Print is off only while the sheet would be empty',
     await page.$$eval('button', b => b.filter(x => /Print|Preview/.test(x.textContent)).map(x => x.disabled)),
     [true, true]);

  // ── no rate card at all ───────────────────────────────────────────────
  // The clinic that has not pasted its CGHS card in yet, or a code the card
  // does not carry. This is the state the screen used to dead-end in, with
  // a dropdown reading "no rate card" and no way past it.
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'], rates: [], ratesMsg: '',
    rows: [{ at: 0, r: { tooth: '16', procedure: 'Composite Restoration', qty: 2, cghsRate: '450' },
             code: 'DP114', card: null, rate: 450, qty: 2, priced: true, amt: 900 }],
    total: 900, missing: 0, approvedCount: 0, approvedTotal: 0 });
  eq('with no rate card, the code, treatment and rate are all typed',
     await page.$$eval('tbody tr:nth-child(1) input:not([type=checkbox])', i => i.map(x => [x.value, x.readOnly])),
     [['DP114', false], ['Composite Restoration', false], ['16', false], ['2', false], ['450', false]]);
  eq('and the line is priced from what was typed',
     await page.$eval('tbody tr:nth-child(1) td:nth-child(7)', t => t.textContent), '₹900');
  await page.fill('tbody tr:nth-child(1) td:nth-child(6) input', '500');
  eq('typing a rate reaches the plan',
     (await page.evaluate(() => window.__field)).slice(-1), [[0, 'cghsRate', '500']]);
  await page.fill('tbody tr:nth-child(1) td:nth-child(6) input', '12a.5');
  eq('a rate takes digits and a point, nothing else',
     await page.$eval('tbody tr:nth-child(1) td:nth-child(6) input', i => i.value), '12.5');
  await page.fill('tbody tr:nth-child(1) td:nth-child(2) input', 'DP999');
  eq('and the code is typed straight in, with no dropdown to get stuck in',
     (await page.evaluate(() => window.__set)).slice(-1), [[0, 'DP999']]);
  eq('the rate card is offered as suggestions, not as the only way',
     await page.$$eval('datalist#kb-panel-codes option', o => o.length), 0);

  // ── a line with no rate at all ────────────────────────────────────────
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'], rates: [], ratesMsg: '',
    rows: [{ at: 0, r: { tooth: '16', procedure: 'Something', qty: 1 }, code: 'DP900',
             card: null, rate: 0, qty: 1, priced: false, amt: 0 }], total: 0, missing: 0, approvedCount: 0, approvedTotal: 0 });
  eq('a line with no rate shows a dash rather than a wrong zero',
     await page.$eval('tbody tr:nth-child(1) td:nth-child(7)', t => t.textContent), '\u2014');

  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'],
                rates: RATES, ratesMsg: '', rows: mkRows(), total: 2600, missing: 0, approvedCount: 0, approvedTotal: 0 });
  eq('with a card, every code on it is suggested',
     await page.$$eval('datalist#kb-panel-codes option', o => o.map(x => x.value)),
     ['DP030', 'DP035']);

  // ── a rate card that could not be read ────────────────────────────────
  await mount({ ...CARD, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS', panels: ['CGHS'], rates: [],
                ratesMsg: 'The CGHS rate card could not be read, so no codes or rates can be filled in. Try reloading the patient.',
                rows: mkRows(), total: 0, missing: 0, approvedCount: 0, approvedTotal: 0 });
  ok('a rate card that failed to load is reported',
     /could not be read/.test(await page.textContent('#root')));
  eq('but the sheet can still be printed',
     await page.$$eval('button', b => b.filter(x => /Print Endorsement/.test(x.textContent)).map(x => x.disabled)),
     [false]);

  // ── the printed sheet ─────────────────────────────────────────────────
  // "The column sequence required for print should be: Code, Treatment
  //  Advised, Tooth Number, no. of units." The screen keeps its rate and
  // amount columns, because that is how a code is chosen; the sheet that
  // goes to the Wellness Centre is the clinic's order, so it is built here
  // and read back rather than trusted to a diff.
  const doc = await (async () => {
    const p2 = await browser.newPage();
    await p2.setContent('<div></div>');
    await p2.addScriptTag({ content: pick('const PCSS = ', 'function toothG(rows) {') });
    // The age is worked out from the date of birth, not stored, so the real
    // helper has to be here or the sheet would quietly print a blank.
    await p2.addScriptTag({ content: pick('function calcAge(dob, today) {', 'function togArr(') });
    await p2.addScriptTag({ content: `
      window.LOGO_B64 = "";
      const TODAY = "03-11-2026";
      const signatureLine = d => "Dr. A | Date: " + d;
      window.CLINIC = { padTop:"44", padRight:"15", padBottom:"15", padLeft:"52", padFlip:false };
      const patPanel = "CGHS";
      const pat = { name:"Asha Rao", uhid:"KB1" };
      // What the endorsement actually prints from: the patient topped up
      // with the panel details, wherever they were found.
      const panelPat = { name:"Asha Rao", uhid:"KB1", cardId:"C-77", panelCategory:"Pensioner",
                         dob:"05/07/1968" };
      const endRows = [
        { r:{ tooth:"16", procedure:"RCT Single Rooted", qty:1 }, code:"DP030",
          card:{ code:"DP030", procedure:"Root Canal Treatment - Single Rooted", rate:"1000" },
          rate:1000, qty:1, amt:1000 },
        { r:{ tooth:"36", procedure:"Composite Restoration", qty:3 }, code:"",
          card:null, rate:0, qty:3, amt:0 }
      ];
      const endTotal = 1000;
    ` });
    await p2.addScriptTag({ content: pick('  function buildEndHTML() {', '  const docHTML = which =>') });
    const out = await p2.evaluate(() => buildEndHTML());
    await p2.setContent(out);
    const got = await p2.evaluate(() => ({
      heads: Array.from(document.querySelectorAll('thead th')).map(t => t.textContent),
      rows: Array.from(document.querySelectorAll('tbody tr')).map(r =>
        Array.from(r.querySelectorAll('td')).map(t => t.textContent)),
      text: document.body.textContent
    }));
    await p2.close();
    return { ...got, html: out };
  })();

  eq('the printed columns are in the order the clinic asked for',
     doc.heads, ['Code', 'Treatment Advised', 'Tooth Number', 'No. of Units']);
  // What was advised wins over the card's own wording: the card names the
  // code, the clinic names the treatment.
  eq('and a row reads in that same order',
     doc.rows[0], ['DP030', 'RCT Single Rooted', '16', '1']);
  eq('a row with no code still prints, with the plan\'s own wording',
     doc.rows[1], ['\u2014', 'Composite Restoration', '36', '3']);
  ok('the beneficiary\'s card details are on the sheet',
     /C-77/.test(doc.text) && /Pensioner/.test(doc.text));
  // What the clinic asked to be taken OFF the sheet. It prints on the
  // prescription pad, which is short, and the Wellness Centre prices the
  // claim from the codes against its own card.
  ok('no total is printed', !/Total/i.test(doc.text), doc.text.slice(-250));
  ok('no beneficiary signature', !/Beneficiary Signature/i.test(doc.text));
  ok('and nothing about the competent authority',
     !/Wellness Centre \/ Competent Authority/i.test(doc.text) &&
     !/Endorsement \/ Permission No/i.test(doc.text) && !/CMO/.test(doc.text));
  ok('the doctor still signs it', /Signature of the Doctor/i.test(doc.text));
  // Worked out from the date of birth the register already holds, so it
  // cannot go stale the way a typed-in age would.
  ok('the beneficiary\'s age is on the sheet',
     /Age\s*58(?!\d)/i.test(doc.text), doc.text.slice(0, 220));

  // It prints onto pre-printed stationery, so it must not draw a letterhead
  // of its own, and it must keep clear of what is already on the paper.
  ok('it draws no letterhead over the pad\'s own',
     !/C\. ?A\. ?R\. ?E\. ?S/.test(doc.html) && !/DILSHAD GARDEN/i.test(doc.html),
     doc.html.slice(0, 200));
  ok('it reserves the pad margins the prescription uses',
     /@page\{size:A4 portrait;margin:44mm 15mm 15mm 52mm;\}/.test(doc.html),
     (/@page[^}]*\}/.exec(doc.html) || [])[0]);

  // ── the other stage of the same document ──────────────────
  // On the Treatment Plan the endorsement is the REQUEST: what is being
  // asked for. It must not carry the ticks, because there are no answers
  // yet, and a request that ticks its own answers is not one. The request
  // is also what gets printed, so the buttons stay with it.
  await mount({ ...CARD, showApproved: false, pat: PAT, panel: 'CGHS', recordedPanel: 'CGHS',
                panels: ['CGHS'], rates: RATES, ratesMsg: '',
                rows: mkRows().map((r, i) => i === 0 ? { ...r, r: { ...r.r, endApproved: true } } : r),
                total: 2600, missing: 0, approvedCount: 1, approvedTotal: 1000 });
  eq('the request stage has no tick, even on a line already endorsed',
     (await page.$$('tbody tr input[type=checkbox]')).length, 0);
  eq('and its columns start at the code',
     await page.$$eval('thead th', t => t.map(x => x.textContent)),
     ['Code', 'Treatment Advised', 'Tooth Number', 'Units', 'Rate', 'Amount', '']);
  ok('it does not count endorsements it cannot show',
     !/endorsed/i.test(await page.textContent('#root')));
  eq('it keeps Preview and Print, because the request is sent from there',
     await page.$$eval('button', b => b.filter(x => /Print Endorsement|Preview Endorsement/.test(x.textContent)).length),
     2);

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
