// "In the tooth grid there are some treatments where we require to select
//  either full arch, full mouth or quadrant (1st, 2nd, 3rd, 4th)."
//
// Some work is not done on a tooth. Scaling is a full mouth, a flap is a
// quadrant, a denture is an arch — and a panel bills them that way: one
// unit for the region, not sixteen teeth. So a region is written into the
// tooth box as itself, in the words the claim is read in.
//
// The rule that matters is that a line is EITHER particular teeth OR a
// region, never both: "16, Full Mouth" is not something a claim can say.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the regions are named once, and every chart gets them ───────────────
ok('the regions are named in one place', /const TOOTH_REGIONS = \[/.test(html));
ok('the chart only offers them when asked to',
   /onRegion \? \/\*#__PURE__\*\/React\.createElement\("div"/.test(html));
ok('and only offers a range when asked to',
   /onRange \? \[\/\*#__PURE__\*\/React\.createElement\("button"/.test(html));
for (const [what, pat] of [
  ['the Care Plan chart', /rows: p4\.rows,\n    onClick: clickTooth,\n    onRegion: clickRegion/],
  ['the Treatment Plan chart', /rows: planRows,\n    onClick: clickTooth,\n    onRegion: clickRegion/],
  ['the endorsement chart', /onRegion: \(v\) => \{ if \(activeRow\) onRegion\(v\); \}/]
]) ok(what + ' offers them', pat.test(html));
// Both stages of the endorsement, because it is one document.
ok('the Treatment Plan stage handles a region', /const endClickRegion = \(v\) => \{/.test(html));
ok('and the Records stage does too', /const onRegion = \(v\) => \{\n    if \(active === null/.test(html));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div></body>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `const T="#0078B4", BORDER="#e5e5e0", BGS="#f5f5f0";` });
  await page.addScriptTag({ content:
    html.slice(html.indexOf('const TOOTH_REGIONS = ['),
               html.indexOf('\n', html.indexOf('const LOWER_T = ['))) });
  // The span rule lives beside the arches, not in the chart, because the
  // Crown & Bridge form follows the same one.
  await page.addScriptTag({ content:
    html.slice(html.indexOf('function archSpan(a, b) {'), html.indexOf('function ToothChart({')) });
  await page.addScriptTag({ content:
    html.slice(html.indexOf('function ToothChart({'), html.indexOf('function ClinicHeader()')) });

  const mount = (rows, withRegions, withRange) => page.evaluate(([r, w, g]) => {
    window.__clicks = []; window.__regions = []; window.__ranges = [];
    const root = window.__r || (window.__r = ReactDOM.createRoot(document.getElementById('root')));
    // A fresh key each time: the chart remembers whether its range picker
    // is armed, and without this one case would start inside the last one.
    window.__n = (window.__n || 0) + 1;
    root.render(React.createElement(ToothChart, Object.assign({
      key: window.__n, rows: r, onClick: (t) => window.__clicks.push(t)
    }, w ? { onRegion: (v) => window.__regions.push(v) } : {},
       g ? { onRange: (span) => window.__ranges.push(span) } : {})));
  }, [rows, withRegions, withRange]);

  // ── a chart that was not given regions is exactly what it was ─────────
  await mount([{ tooth: '16' }], false, false);
  await page.waitForTimeout(200);
  eq('without regions, only the 32 teeth are there',
     (await page.$$('button')).length, 32);

  // ── with them ─────────────────────────────────────────────────────────
  await mount([{ tooth: '16' }], true, false);
  await page.waitForTimeout(200);
  const labels = await page.$$eval('button', b => b.map(x => x.textContent).filter(t => !/^\d\d$/.test(t)));
  eq('the regions offered are full mouth, both arches and four quadrants',
     labels, ['Full Mouth', 'Upper Arch', 'Lower Arch', 'Q1', 'Q2', 'Q3', 'Q4']);
  // The quadrants say which is which: 1st, 2nd, 3rd, 4th mean nothing on
  // their own to somebody who has not met FDI numbering.
  const tips = await page.$$eval('button', b => b.filter(x => /^Q\d$/.test(x.textContent)).map(x => x.title));
  eq('and each quadrant says which part of the mouth it is', tips, [
    'Quadrant 1 — upper right (18–11)', 'Quadrant 2 — upper left (21–28)',
    'Quadrant 3 — lower left (31–38)', 'Quadrant 4 — lower right (41–48)']);

  await page.click('button:text-is("Q3")');
  eq('clicking one hands up the words a claim is read in',
     await page.evaluate(() => window.__regions), ['Quadrant 3']);
  await page.click('button:text-is("Full Mouth")');
  eq('and so does another', await page.evaluate(() => window.__regions), ['Quadrant 3', 'Full Mouth']);
  eq('a region is not mistaken for a tooth', await page.evaluate(() => window.__clicks), []);

  // ── a region already on the line reads as chosen ──────────────────────
  await mount([{ tooth: 'Quadrant 2' }], true, false);
  await page.waitForTimeout(200);
  const lit = await page.$$eval('button', b => b
    .filter(x => x.style.background === 'rgb(0, 120, 180)').map(x => x.textContent));
  eq('the region on the line is the one lit', lit, ['Q2']);
  // "Quadrant 2" must never be read as tooth 2 by parseInt.
  const teethLit = await page.$$eval('button', b => b
    .filter(x => /^\d\d$/.test(x.textContent) && x.style.background === 'rgb(0, 120, 180)').length);
  eq('and no tooth is lit by it', teethLit, 0);

  await mount([{ tooth: '16, 26' }], true, false);
  await page.waitForTimeout(200);
  const litTeeth = await page.$$eval('button', b => b
    .filter(x => x.style.background === 'rgb(0, 120, 180)').map(x => x.textContent));
  eq('teeth still light up as before, and no region does', litTeeth, ['16', '26']);

  // ── a bridge is a run of teeth ────────────────────────
  // "For bridge it needs a selection of tooth range as in crown and bridge
  //  form." The run has to follow the ARCH, not the numbers: FDI goes
  // 48..41 | 31..38, so 43 to 33 is six teeth across the midline, not the
  // eleven that filtering numerically would give.
  await mount([{ tooth: '' }], true, true);
  await page.waitForTimeout(200);
  ok('there is a Range button', (await page.$$('button:text-is("Range")')).length === 1);
  await page.click('button:text-is("Range")');
  ok('arming it says what to do next',
     /Click one end of the span, then the other/.test(await page.textContent('#root')));
  await page.click('button[title="#43"]');
  ok('after the first end it asks for the other',
     /Now click the other end/.test(await page.textContent('#root')));
  eq('and that first click is not taken as a tooth',
     await page.evaluate(() => window.__clicks), []);
  await page.click('button[title="#33"]');
  eq('the span follows the arch across the midline',
     await page.evaluate(() => window.__ranges), [[43, 42, 41, 31, 32, 33]]);
  ok('and the picker disarms itself afterwards',
     (await page.$$('button:text-is("Range")')).length === 1);
  await page.click('button[title="#16"]');
  eq('so the next click is an ordinary tooth again',
     await page.evaluate(() => window.__clicks), [16]);

  // Upper to lower spans no real prosthesis, and is usually a mis-click.
  await mount([{ tooth: '' }], true, true);
  await page.waitForTimeout(200);
  await page.click('button:text-is("Range")');
  await page.click('button[title="#16"]');
  await page.click('button[title="#46"]');
  eq('a span from one jaw to the other is refused',
     await page.evaluate(() => window.__ranges), []);
  ok('and says why',
     /same arch/.test(await page.textContent('#root')), await page.textContent('#root'));

  // A span picked the other way round is the same span.
  await mount([{ tooth: '' }], true, true);
  await page.waitForTimeout(200);
  await page.click('button:text-is("Range")');
  await page.click('button[title="#33"]');
  await page.click('button[title="#43"]');
  eq('picking the ends in either order gives the same teeth',
     await page.evaluate(() => window.__ranges), [[43, 42, 41, 31, 32, 33]]);

  // A chart not given onRange is unchanged.
  await mount([{ tooth: '' }], true, false);
  await page.waitForTimeout(200);
  ok('a chart with no range asked for does not offer one',
     (await page.$$('button:text-is("Range")')).length === 0);

  ok('nothing threw', errors.length === 0, errors.join(' // '));
  await browser.close();

  // ── either teeth or a region, never both ──────────────────────────────
  // Run the two endorsement handlers directly: they are the ones that have
  // to replace rather than append, and clear when the same one is clicked.
  const vm = require('vm');
  const pick = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  for (const [where, src, call] of [
    ['on the Treatment Plan',
     pick('  const endClickRegion = (v) => {', '  const endRows = tpRows'),
     'endClickRegion'],
    ['in Records',
     pick('  const onRegion = (v) => {\n    if (active === null', '  const onAdd = () => {'),
     'onRegion']
  ]) {
    let rows = [{ tooth: '16, 26' }, { tooth: '' }];
    const ctx = {
      endActive: 0, active: 0,
      setTpRows: (f) => { rows = f(rows); }, setRows: (f) => { rows = f(rows); },
      setSaved: () => {}, touch: () => {}, String, Number
    };
    vm.createContext(ctx);
    // Picking a region sets the units as well as the teeth, and the real
    // unitsFromTeeth is used rather than a stand-in: a region is one unit,
    // and that is the rule being relied on here.
    vm.runInContext(pick('const TOOTH_REGIONS = [', 'const LOWER_T =')
      + '\n' + src + '\nthis.go = ' + call + ';', ctx);
    ctx.go('Full Mouth');
    eq('a region replaces the teeth on that line ' + where, rows[0].tooth, 'Full Mouth');
    ctx.go('Full Mouth');
    eq('and clicking the same one again clears it ' + where, rows[0].tooth, '');
    ctx.go('Quadrant 4');
    eq('another region simply takes its place ' + where, rows[0].tooth, 'Quadrant 4');
    eq('and no other line is touched ' + where, rows[1].tooth, '');
    // A quadrant is one unit, not eight. The panel pays for the quadrant.
    eq('a region is one unit ' + where, rows[0].qty, 1);
  }

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
