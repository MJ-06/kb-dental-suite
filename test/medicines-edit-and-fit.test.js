// "Shorten this also and add an edit button." — the Drugs screen in
// Master > Prescriptions.
//
// It ran the full width of the page while every other Master list sat at
// MASTER_LIST_WIDTH, and a medicine could only be Removed: a dosage typed
// as "500 mg" instead of "500mg" meant deleting the row and adding it back.
//
// Both halves are checked by DRIVING the screen, not by reading the source:
// an Edit button that renders but saves nothing is exactly the failure this
// is meant to catch.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

const W = Number((/const MASTER_LIST_WIDTH = (\d+);/.exec(html) || [])[1]);
ok('the shared Master width is there to match', W > 0, W);

const A = html.indexOf('function MedicineListEditor({');
const B = html.indexOf('// Implant brand + the sizes that brand is stocked in', A);
ok('the Drugs screen was found', A > 0 && B > A, `${A}..${B}`);
const SRC = html.slice(A, B);

ok('it takes an onEdit, like the other list screens',
   /function MedicineListEditor\(\{ items, onAdd, onRemove, onEdit \}\)/.test(SRC));
ok('and the screen that mounts it passes one',
   /medicines: \(\) => React\.createElement\(MedicineListEditor, \{[\s\S]{0,300}?onEdit:\(i,v\)=>saveMedicines\(medicines\.map\(/.test(html));
ok('it uses the one shared width', SRC.indexOf('MASTER_LIST_WIDTH') >= 0);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  // Wide on purpose: a screen that does not cap itself only looks wrong
  // when there is room for it to run away.
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  page.on('dialog', d => d.accept());
  await page.setContent('<body style="margin:0;padding:24px;font-family:system-ui"><div id="root"></div></body>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const T="#0078B4", BORDER="#e5e5e0", BGS="#f5f5f0";
    const inp={padding:"6px 10px",fontSize:14,border:"1px solid #e5e5e0",borderRadius:6,
               background:"#fff",color:"#1a1a1a",width:"100%",boxSizing:"border-box",fontFamily:"inherit"};
    const MASTER_LIST_WIDTH = ${W};
  ` });
  await page.addScriptTag({ content: SRC });

  // A sheet hands back whatever was typed into it, so one row arrives as a
  // number — the trap that used to make Save do nothing at all.
  await page.evaluate(() => {
    const e = React.createElement;
    window.__saved = [];
    const Harness = () => {
      const [items, setItems] = React.useState([
        { name: 'Amoxicillin', dosage: '500mg', frequency: '1-0-1' },
        { name: 'Cefakind CV', dosage: '500 mg', frequency: 'two times a day' },
        { name: 'Pan 40', dosage: 40, frequency: '' }
      ]);
      return e(MedicineListEditor, {
        items,
        onAdd: v => setItems(x => [...x, v]),
        onRemove: i => { window.__saved.push(['remove', i]); setItems(x => x.filter((_, j) => j !== i)); },
        onEdit: (i, v) => { window.__saved.push(['edit', i, v]); setItems(x => x.map((y, j) => j === i ? v : y)); }
      });
    };
    ReactDOM.createRoot(document.getElementById('root')).render(e(Harness));
  });
  await page.waitForTimeout(250);

  // ── it fits ───────────────────────────────────────────────────────────
  const m = await page.evaluate(() => ({
    widest: Math.round(Math.max(...Array.from(document.querySelectorAll('#root div, #root table'))
      .map(n => n.getBoundingClientRect().width))),
    room: document.body.clientWidth,
    rows: document.querySelectorAll('tbody tr').length
  }));
  ok('there was room to run away', m.room > W + 400, m.room);
  eq('the Drugs screen is no wider than every other Master list', m.widest, W);
  eq('all three medicines are listed', m.rows, 3);

  // ── there is an Edit, and it is on every row ──────────────────────────
  const labels = await page.$$eval('tbody tr td:last-child button', b => b.map(x => x.textContent));
  eq('every row offers Edit and Remove', labels,
     ['Edit', 'Remove', 'Edit', 'Remove', 'Edit', 'Remove']);

  // ── and it actually saves ─────────────────────────────────────────────
  // Row 2's dosage is "500 mg" and should become "500mg": the real reason
  // this button was asked for.
  const rowBtn = (row, label) => `tbody tr:nth-child(${row}) td:last-child button:text-is("${label}")`;
  await page.click(rowBtn(2, 'Edit'));
  await page.waitForTimeout(100);
  const boxes = await page.$$('tbody tr:nth-child(2) input');
  eq('editing opens name, dosage and frequency', boxes.length, 3);
  eq('pre-filled with what the row holds',
     await page.$$eval('tbody tr:nth-child(2) input', b => b.map(x => x.value)),
     ['Cefakind CV', '500 mg', 'two times a day']);

  await boxes[1].fill('500mg');
  await boxes[2].fill('1-0-1');
  await page.click(rowBtn(2, 'Save'));
  await page.waitForTimeout(150);

  eq('the change was handed up once, for the right row',
     await page.evaluate(() => window.__saved),
     [['edit', 1, { name: 'Cefakind CV', dosage: '500mg', frequency: '1-0-1' }]]);
  const shown = await page.$$eval('tbody tr', r => r.map(x =>
    Array.from(x.querySelectorAll('td')).slice(0, 3).map(t => t.textContent)));
  eq('and the row now reads the corrected dosage', shown[1], ['Cefakind CV', '500mg', '1-0-1']);

  // ── Cancel leaves the row alone ───────────────────────────────────────
  await page.click(rowBtn(1, 'Edit'));
  await page.waitForTimeout(100);
  await (await page.$$('tbody tr:nth-child(1) input'))[0].fill('Something else');
  await page.click(rowBtn(1, 'Cancel'));
  await page.waitForTimeout(100);
  eq('Cancel throws the draft away',
     await page.$eval('tbody tr:nth-child(1) td', t => t.textContent), 'Amoxicillin');
  eq('and saved nothing extra', (await page.evaluate(() => window.__saved)).length, 1);

  // ── a row that came back as a number still saves ──────────────────────
  // "Pan 40" has a dosage of 40, not "40": .trim() on a number throws
  // inside the click handler and Save silently does nothing.
  await page.click(rowBtn(3, 'Edit'));
  await page.waitForTimeout(100);
  eq('a number from the sheet opens as text',
     await page.$$eval('tbody tr:nth-child(3) input', b => b.map(x => x.value)),
     ['Pan 40', '40', '']);
  await (await page.$$('tbody tr:nth-child(3) input'))[1].fill('40mg');
  await page.click(rowBtn(3, 'Save'));
  await page.waitForTimeout(150);
  eq('and saves like any other row',
     (await page.evaluate(() => window.__saved))[1],
     ['edit', 2, { name: 'Pan 40', dosage: '40mg', frequency: '' }]);

  // ── an empty name cannot be saved over a good one ─────────────────────
  await page.click(rowBtn(1, 'Edit'));
  await page.waitForTimeout(100);
  await (await page.$$('tbody tr:nth-child(1) input'))[0].fill('   ');
  ok('Save is off while the name is blank',
     await page.$eval(rowBtn(1, 'Save'), b => b.disabled) === true);
  await page.click(rowBtn(1, 'Cancel'));
  await page.waitForTimeout(100);

  // ── searching still finds rows, and Edit still hits the right one ─────
  await page.fill('#root > div > input', 'pan');
  await page.waitForTimeout(150);
  eq('search narrows the list', (await page.$$('tbody tr')).length, 1);
  await page.click(rowBtn(1, 'Edit'));
  await page.waitForTimeout(100);
  eq('and Edit opens the searched row, not the first one in the list',
     (await page.$$eval('tbody tr:nth-child(1) input', b => b.map(x => x.value)))[0], 'Pan 40');

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
