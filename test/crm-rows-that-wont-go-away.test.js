// "People without panel also in panel list."  Three times.
//
// The filter was right every time. The COUNT was right every time -- it
// said 5 of 2503 while five CGHS rows and three Individuals sat on screen.
// A count and a list that disagree cannot both come from one array, and
// they did come from one array. So the extra rows were never in the list:
// they were left behind in the page.
//
// React keeps its remaining children in a Map keyed by `key`. Two records
// with the same id give two rows the same key, the second fiber overwrites
// the first in that Map, and the first -- no longer in it -- is never
// queued for deletion. Its DOM node stays. It belongs to no list, so no
// filter can ever remove it.
//
// And the ids collided because uid() was Date.now() plus three random
// characters: during an import of 2,503 contacts, dozens are created inside
// the same millisecond, leaving about 46,656 possibilities to tell them
// apart. Collisions were not unlikely, they were expected.
//
// This is RUN, in a browser, with React off the disk. The mechanism is
// reproduced first -- a test that cannot fail on the old code is worth
// nothing -- and then the fix is shown to stop it.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

const crm = (() => {
  const m = /const CRM_B64\s*=\n/.exec(html);
  const a = m.index, b = html.indexOf(';\n', a);
  return Buffer.from((html.slice(a, b).match(/"[^"]*"/g) || [])
    .map(x => x.slice(1, -1)).join(''), 'base64').toString('utf8');
})();

// The real rk() and uid(), lifted out of the shipped CRM.
const SRC = (() => {
  const a = crm.indexOf('  var uidN = 0;');
  const b = crm.indexOf('  /* Who is using this screen.', a);
  ok('uid() and rk() were found in the CRM', a > 0 && b > a, `${a}..${b}`);
  return crm.slice(a, b);
})();

const REACT = ['node_modules/react/umd/react.production.min.js',
               'node_modules/react-dom/umd/react-dom.production.min.js']
  .map(f => fs.readFileSync(path.join(REPO, f), 'utf8'));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const src of REACT) await page.addScriptTag({ content: src });
  await page.addScriptTag({ content: SRC });

  // The clinic's contacts, with the duplicate ids an import produces.
  const run = keyMode => page.evaluate(mode => {
    const e = React.createElement;
    // Three with no panel share ids with three on CGHS -- exactly what
    // uid() collisions look like in a 2,503 row import.
    // Order matters, and it is the order a real list has. React walks the
    // leading run of the two lists positionally and only falls back to a
    // Map once a key mismatches -- so the duplicate has to sit in the part
    // reconciled by that Map, which in a 2,503 row list filtered down to
    // five is all of it. Hence the row that is filtered out standing
    // immediately BEFORE the twin that survives.
    const people = [
      { id: 'f0', name: 'Someone Else', panel: '' },      // breaks the leading run
      { id: 'dup1', name: 'Umesh Jain', panel: '' },
      { id: 'dup1', name: 'Deepa Tyagi', panel: 'CGHS' },
      { id: 'dup2', name: 'Saaransh Kharbanda', panel: '' },
      { id: 'dup2', name: 'ABC', panel: 'CGHS' },
      { id: 'dup3', name: 'Numa Samar', panel: '' },
      { id: 'dup3', name: 'Lata Sharma', panel: 'CGHS' },
      { id: 'u7', name: 'Santosh', panel: 'CGHS' },
      { id: 'u8', name: 'Shankar Lal', panel: 'CGHS' }
    ];
    const keyFor = r => (mode === 'id') ? r.id : rk(r);
    function List(props) {
      const rows = people.filter(p => !props.want || p.panel === props.want);
      return e('table', null, e('tbody', null,
        rows.map(r => e('tr', { key: keyFor(r) },
          e('td', { className: 'nm' }, r.name),
          e('td', { className: 'pn' }, r.panel || 'Individual')))));
    }
    const root = ReactDOM.createRoot(document.getElementById('root'));
    return new Promise(resolve => {
      // First the whole list, the way the screen opens...
      root.render(e(List, { want: '' }));
      setTimeout(() => {
        // ...then the clinic picks CGHS.
        root.render(e(List, { want: 'CGHS' }));
        setTimeout(() => {
          const names = Array.from(document.querySelectorAll('td.nm')).map(n => n.textContent);
          const panels = Array.from(document.querySelectorAll('td.pn')).map(n => n.textContent);
          resolve({ names, panels, rows: names.length,
                    strays: panels.filter(p => p === 'Individual').length });
        }, 60);
      }, 60);
    });
  }, keyMode);

  // ── the mechanism, reproduced ─────────────────────────────────────────
  const broken = await run('id');
  eq('keyed by id, the list shows more rows than it has', broken.rows, 8);
  eq('and three of them are people with no panel', broken.strays, 3);
  ok('they are the three the clinic kept seeing',
     ['Umesh Jain', 'Saaransh Kharbanda', 'Numa Samar'].every(n => broken.names.indexOf(n) >= 0),
     broken.names.join(', '));

  // ── and stopped ───────────────────────────────────────────────────────
  await page.evaluate(() => { document.getElementById('root').innerHTML = ''; });
  const fixed = await run('rk');
  eq('keyed by the record, the list shows exactly its five', fixed.rows, 5);
  eq('and not one person without a panel', fixed.strays, 0);
  ok('the five are the CGHS patients',
     ['Deepa Tyagi', 'ABC', 'Lata Sharma', 'Santosh', 'Shankar Lal']
       .every(n => fixed.names.indexOf(n) >= 0), fixed.names.join(', '));

  // ── rk() itself ───────────────────────────────────────────────────────
  const rkFacts = await page.evaluate(() => {
    const a = { id: 'same' }, b = { id: 'same' }, c = { id: '' };
    return {
      stable: rk(a) === rk(a),                       // same object, same key
      distinct: rk(a) !== rk(b),                     // same id, different records
      noId: !!rk(c) && rk(c) !== rk({ id: '' }),     // no id at all still works
      safe: rk(null) !== undefined && rk(undefined) !== undefined,
      manyUnique: (() => {
        const seen = new Set();
        for (let i = 0; i < 5000; i++) seen.add(rk({ id: 'x' }));
        return seen.size === 5000;
      })()
    };
  });
  ok('a record keeps the same key across renders', rkFacts.stable);
  ok('two records with one id get different keys', rkFacts.distinct);
  ok('a record with no id still gets one', rkFacts.noId);
  ok('and nothing at all does not throw', rkFacts.safe);
  ok('five thousand records, five thousand keys', rkFacts.manyUnique);

  // ── uid() cannot collide any more ─────────────────────────────────────
  // The old one was Date.now() plus three random characters. This makes
  // 2,503 ids as fast as an import does and insists every one is distinct.
  const uids = await page.evaluate(() => {
    const seen = {}, out = [];
    for (let i = 0; i < 2503; i++) { const u = uid(); out.push(u); seen[u] = (seen[u] || 0) + 1; }
    return { total: out.length, unique: Object.keys(seen).length,
             sample: out.slice(0, 2) };
  });
  eq('2,503 ids made back to back are 2,503 different ids', uids.unique, uids.total);
  ok('and they still look like ids', /^c[0-9a-z]+$/.test(uids.sample[0]), uids.sample.join(' '));

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
