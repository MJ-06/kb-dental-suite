// "I want the Document Categories box size to be equal to the Occupation
//  box — they all should match in size (width), I mean all."
//
// Four of the Master lists were drawn at 520 and nine at whatever the page
// was wide, so Document Categories ran the full width of the screen while
// Occupation sat in a column a third of that. The same kind of list,
// looking like two different screens.
//
// Both now come from one named width. This is MEASURED, not read: a width
// is the one thing you cannot check by looking at a diff, and the two
// screens are built by two different components that nothing forces to
// agree.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── one width, named once ───────────────────────────────────────────────
const W = (/const MASTER_LIST_WIDTH = (\d+);/.exec(html) || [])[1];
ok('there is one width for the Master lists', !!W, W);
ok('and nothing sets its own any more',
   !/maxWidth:520/.test(html.slice(html.indexOf('function EntryListEditor('),
                                   html.indexOf('function SimpleListEditor('))), W);
// Both components have to use it, or naming it changes nothing.
for (const [name, from, to] of [
  ['the newer lists', 'function EntryListEditor(', '// When the day runs, and how long a slot is.'],
  ['the older lists', 'function SimpleListEditor(', '\nfunction ']
]) ok(name + ' use it', html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)))
      .indexOf('MASTER_LIST_WIDTH') >= 0);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  // Wide on purpose: a list that does not cap itself is only visible as
  // wrong when there is room for it to run away.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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
    const MASTER_LIST_WIDTH = ${W};
  ` });
  const cut = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  await page.addScriptTag({ content: cut('function EntryListEditor(', '// When the day runs, and how long a slot is.') });
  await page.addScriptTag({ content: cut('function SimpleListEditor(', '\nfunction ') });

  await page.evaluate(() => {
    const e = React.createElement;
    ReactDOM.createRoot(document.getElementById('root')).render(
      e('div', null,
        e('div', { id: 'newer' }, e(EntryListEditor, {
          title: 'Occupation', noun: 'occupations', blurb: 'b',
          items: ['Business', 'Government Service'], onAdd(){}, onRemove(){}, onEdit(){} })),
        e('div', { id: 'older' }, e(SimpleListEditor, {
          items: ['X-Ray / RVG', 'OPG'], placeholder: 'New document category...',
          onAdd(){}, onRemove(){}, onEdit(){} }))));
  });
  await page.waitForTimeout(250);

  const m = await page.evaluate(() => {
    const px = n => n ? Math.round(n.getBoundingClientRect().width) : null;
    const q = (root, sel) => px(document.querySelector('#' + root).querySelector(sel));
    const widest = root => Math.round(Math.max(...Array.from(
      document.querySelector('#' + root).querySelectorAll('div,table'))
      .map(n => n.getBoundingClientRect().width)));
    return {
      newerBox: q('newer', 'input'), olderBox: q('older', 'input'),
      newerWidest: widest('newer'), olderWidest: widest('older'),
      newerBtn: q('newer', 'button'), olderBtn: q('older', 'button'),
      room: document.body.clientWidth
    };
  });

  // The page is far wider than the lists, so nothing is capped by accident.
  ok('there was room to run away', m.room > Number(W) + 400, m.room);
  eq('the entry box is the same width on both', m.olderBox, m.newerBox);
  eq('and so is the Add button', m.olderBtn, m.newerBtn);
  eq('neither list is wider than the one width', [m.newerWidest, m.olderWidest], [Number(W), Number(W)]);
  ok('and both actually reach it, rather than being narrower',
     m.newerWidest === Number(W) && m.olderWidest === Number(W), JSON.stringify(m));

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
