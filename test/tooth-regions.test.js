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
   /onRegion,\n  \/\/ The caption under the grid/.test(html) && /onRegion \? \/\*#__PURE__\*\/React\.createElement\("div"/.test(html));
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
  await page.addScriptTag({ content:
    html.slice(html.indexOf('function ToothChart({'), html.indexOf('function ClinicHeader()')) });

  const mount = (rows, withRegions) => page.evaluate(([r, w]) => {
    window.__clicks = []; window.__regions = [];
    const root = window.__r || (window.__r = ReactDOM.createRoot(document.getElementById('root')));
    root.render(React.createElement(ToothChart, Object.assign({
      rows: r, onClick: (t) => window.__clicks.push(t)
    }, w ? { onRegion: (v) => window.__regions.push(v) } : {})));
  }, [rows, withRegions]);

  // ── a chart that was not given regions is exactly what it was ─────────
  await mount([{ tooth: '16' }], false);
  await page.waitForTimeout(200);
  eq('without regions, only the 32 teeth are there',
     (await page.$$('button')).length, 32);

  // ── with them ─────────────────────────────────────────────────────────
  await mount([{ tooth: '16' }], true);
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
  await mount([{ tooth: 'Quadrant 2' }], true);
  await page.waitForTimeout(200);
  const lit = await page.$$eval('button', b => b
    .filter(x => x.style.background === 'rgb(0, 120, 180)').map(x => x.textContent));
  eq('the region on the line is the one lit', lit, ['Q2']);
  // "Quadrant 2" must never be read as tooth 2 by parseInt.
  const teethLit = await page.$$eval('button', b => b
    .filter(x => /^\d\d$/.test(x.textContent) && x.style.background === 'rgb(0, 120, 180)').length);
  eq('and no tooth is lit by it', teethLit, 0);

  await mount([{ tooth: '16, 26' }], true);
  await page.waitForTimeout(200);
  const litTeeth = await page.$$eval('button', b => b
    .filter(x => x.style.background === 'rgb(0, 120, 180)').map(x => x.textContent));
  eq('teeth still light up as before, and no region does', litTeeth, ['16', '26']);

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
      setSaved: () => {}, touch: () => {}, String
    };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.go = ' + call + ';', ctx);
    ctx.go('Full Mouth');
    eq('a region replaces the teeth on that line ' + where, rows[0].tooth, 'Full Mouth');
    ctx.go('Full Mouth');
    eq('and clicking the same one again clears it ' + where, rows[0].tooth, '');
    ctx.go('Quadrant 4');
    eq('another region simply takes its place ' + where, rows[0].tooth, 'Quadrant 4');
    eq('and no other line is touched ' + where, rows[1].tooth, '');
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
