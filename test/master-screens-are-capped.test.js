// "Shorten this and all the screens in the master — I do not want to give
//  separate prompts for all."
//
// Only the single-column lists had been capped. Every other Master screen —
// Clinic Timings, Working Days, the fee schedules, the procedure library,
// the note templates — ran the full width of the browser, so the same
// Master looked like a different app from one tab to the next.
//
// There are now two named widths and ONE place that applies the outer one:
// the wrapper Master draws whichever screen is open into. That matters more
// than any individual screen, because it is what makes a screen added next
// month come out capped without anyone remembering to do it. So the rule is
// tested where it lives, with a child that would run away if it could.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

const LIST = Number((/const MASTER_LIST_WIDTH = (\d+);/.exec(html) || [])[1]);
const SCREEN = Number((/const MASTER_SCREEN_WIDTH = (\d+);/.exec(html) || [])[1]);
ok('the one-column width is named', LIST > 0, LIST);
ok('the whole-screen width is named', SCREEN > 0, SCREEN);
ok('and a table screen gets more room than a single list, not less', SCREEN > LIST, `${LIST} < ${SCREEN}`);

// The wrapper has to sit on the shared `content`, not on one screen: that is
// the difference between capping Master and capping whatever was last asked
// about.
ok('every Master screen is drawn through one capped wrapper',
   /content && React\.createElement\("div", \{ style:\{ maxWidth:MASTER_SCREEN_WIDTH, overflowX:"auto" \} \}, content\)/.test(html));

const cut = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const timings = cut('function ClinicTimingsEditor(', 'function WorkingDaysEditor(');
const working = cut('function WorkingDaysEditor(', 'function MedicineListEditor(');
for (const [what, src] of [['Clinic Timings', timings], ['Working Days', working]])
  ok(what + ' caps itself to the one-column width', src.indexOf('MASTER_LIST_WIDTH') >= 0);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  // Far wider than either cap, so anything uncapped is visibly wrong.
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<body style="margin:0;padding:24px;font-family:system-ui"><div id="root"></div></body>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const T="#0078B4", TL="#eaf4fb", BORDER="#e5e5e0", BGS="#f5f5f0";
    const inp={padding:"6px 10px",fontSize:14,border:"1px solid #e5e5e0",borderRadius:6,
               background:"#fff",color:"#1a1a1a",width:"100%",boxSizing:"border-box",fontFamily:"inherit"};
    const MASTER_LIST_WIDTH = ${LIST};
    const MASTER_SCREEN_WIDTH = ${SCREEN};
  ` });
  // The slot maths Clinic Timings draws its preview from.
  await page.addScriptTag({ content: cut('function hhmmToMin(v) {', '// The slot a booking should open on.') });
  await page.addScriptTag({ content: timings });
  await page.addScriptTag({ content: working });

  await page.evaluate((W) => {
    const e = React.createElement;
    ReactDOM.createRoot(document.getElementById('root')).render(
      e('div', null,
        // What Master itself draws: the wrapper, holding a screen that would
        // take the whole browser if nothing stopped it.
        e('div', { id: 'wrapper' },
          e('div', { id: 'capped', style: { maxWidth: W, overflowX: 'auto' } },
            e('div', { id: 'greedy', style: { width: 2000, height: 20, background: '#eee' } }))),
        e('div', { id: 'timings' }, e(ClinicTimingsEditor, {
          timings: { open: '09:00', close: '19:00', slotMinutes: 30, breaks: [] },
          onSave: () => Promise.resolve(true) })),
        e('div', { id: 'working' }, e(WorkingDaysEditor, {
          weekOff: ['Sunday'],
          holidays: [{ date: '2026-01-26', name: 'Republic Day' }],
          onSave: () => Promise.resolve(true) }))));
  }, SCREEN);
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const widest = id => Math.round(Math.max(...Array.from(
      document.querySelector('#' + id).querySelectorAll('div,table'))
      .map(n => n.getBoundingClientRect().width)));
    return {
      room: document.body.clientWidth,
      wrapper: Math.round(document.getElementById('capped').getBoundingClientRect().width),
      greedy: Math.round(document.getElementById('greedy').getBoundingClientRect().width),
      timings: widest('timings'),
      working: widest('working'),
      // A cap that is only honoured until something inside is too big to
      // fit is not a cap. The page must not scroll sideways either.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });

  ok('there was room to run away', m.room > SCREEN + 400, m.room);
  eq('the wrapper holds a screen to the whole-screen width', m.wrapper, SCREEN);
  // A screen too wide to fit scrolls inside the cap instead of stretching
  // it — which is the point: a fee schedule stays readable without the
  // whole page growing a sideways scrollbar.
  ok('a screen that asked for 2000px scrolls inside it rather than stretching it',
     m.wrapper === SCREEN && m.greedy > SCREEN, JSON.stringify([m.wrapper, m.greedy]));
  eq('Clinic Timings is no wider than a single Master list', m.timings, LIST);
  eq('Working Days likewise', m.working, LIST);
  ok('and nothing pushed the page sideways', m.overflow <= 0, m.overflow);

  // Clinic Timings is the screen this was asked about, so check it still
  // WORKS at the narrower width rather than merely fitting: the slot
  // preview is the part that could have been squeezed into nothing.
  const slots = await page.$$eval('#timings span', s => s.map(x => x.textContent).filter(t => /^\d\d:\d\d$/.test(t)));
  eq('the day still previews every slot', slots.length, 20);
  eq('starting where the clinic opens', slots[0], '09:00');
  eq('and ending on the last one that fits', slots[slots.length - 1], '18:30');
  const boxes = await page.$$eval('#timings input', b => b.map(x => Math.round(x.getBoundingClientRect().width)));
  ok('Opens, Closes and Minutes are still usable boxes, not slivers',
     boxes.length >= 3 && Math.min(...boxes) > 80, JSON.stringify(boxes));

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
