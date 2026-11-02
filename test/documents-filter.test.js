// "Even if we search x-ray it shows prescription on screen. Ideally what we
// choose on the dropdown, only that document should be seen."
//
// The dropdown on that screen is the UPLOAD category -- it says where a new
// file goes. The list ignored it entirely, so picking X-Ray / RVG changed
// nothing and every category stayed on screen.
//
// A second control does the looking. Keeping them apart matters: sharing one
// reads well until you pick "All documents" to see everything and then have
// no category left to file an upload under.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

const a = html.indexOf('  const grouped = {};\n  docs.forEach(d => { const c = d.category || "Other";');
const b = html.indexOf('  return React.createElement("div", null,\n    React.createElement(ClinicHeader, null),\n    React.createElement("div", { style:{ fontSize:18, fontWeight:700, marginBottom:4 } }, "\u{1F4CE} Documents")', a);
ok('the grouping and filtering were found', a > 0 && b > a, `${a}..${b}`);
const FILTER_SRC = html.slice(a, b);

// The filtering is plain arithmetic over the document list, so it is run
// rather than read.
async function filterWith(page, docs, categories, chosen) {
  return page.evaluate(({ src, docs, categories, chosen }) => {
    const ALL_DOCS = 'All documents';
    const fn = new Function('docs', 'docCategories', 'filterCat', 'ALL_DOCS',
      src + `
      return { filterOptions, showingAll, visibleCats, hiddenCount,
               counts: filterOptions.map(c => [c, countIn(c)]) };`);
    return fn(docs, categories, chosen, ALL_DOCS);
  }, { src: FILTER_SRC, docs, categories, chosen });
}

const DOCS = [
  { id: 1, category: 'X-Ray / RVG', fileName: 'iopa-21.jpg' },
  { id: 2, category: 'X-Ray / RVG', fileName: 'opg.jpg' },
  { id: 3, category: 'Prescriptions', fileName: 'Rx-oct.pdf' },
  { id: 4, category: 'Reports', fileName: 'blood.pdf' },
  // Filed under a heading that is no longer on the clinic's list.
  { id: 5, category: 'Old Scans', fileName: 'legacy.jpg' }
];
const CATEGORIES = ['X-Ray / RVG', 'Prescriptions', 'Reports', 'Other'];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.setContent('<div id="root"></div>');

  // ── the complaint, directly ────────────────────────────────────────────
  {
    const r = await filterWith(page, DOCS, CATEGORIES, 'X-Ray / RVG');
    eq('choosing X-Ray shows only X-Ray', r.visibleCats.join(','), 'X-Ray / RVG');
    ok('prescriptions are not on screen', !r.visibleCats.includes('Prescriptions'), r.visibleCats);
    eq('and it says how many it is holding back', r.hiddenCount, 3);
    eq('not showing all', r.showingAll, false);
  }

  // ── All documents still shows everything, under its own heading ────────
  {
    const r = await filterWith(page, DOCS, CATEGORIES, 'All documents');
    eq('every category that has documents is shown', r.visibleCats.length, 4);
    eq('in alphabetical order', r.visibleCats.join(','), 'Old Scans,Prescriptions,Reports,X-Ray / RVG');
    eq('nothing is hidden', r.hiddenCount, 0);
    eq('showing all', r.showingAll, true);
  }

  // ── a category with nothing in it ──────────────────────────────────────
  {
    const r = await filterWith(page, DOCS, CATEGORIES, 'Other');
    eq('an empty category shows no groups', r.visibleCats.length, 0);
    eq('and all five are held back', r.hiddenCount, 5);
  }

  // ── the choices on offer ───────────────────────────────────────────────
  {
    const r = await filterWith(page, DOCS, CATEGORIES, 'All documents');
    eq('All documents comes first', r.filterOptions[0], 'All documents');
    ok('every clinic category is offered, even an empty one',
       CATEGORIES.every(c => r.filterOptions.includes(c)), r.filterOptions);
    // A document filed under a heading since removed from Master must not
    // become unreachable.
    ok('and a category no longer on the clinic list is still reachable',
       r.filterOptions.includes('Old Scans'), r.filterOptions);
    const counts = Object.fromEntries(r.counts);
    eq('the count beside All is every document', counts['All documents'], 5);
    eq('X-Ray counts two', counts['X-Ray / RVG'], 2);
    eq('an empty category counts zero rather than being hidden', counts['Other'], 0);
  }

  // ── a patient with nothing at all ──────────────────────────────────────
  {
    const r = await filterWith(page, [], CATEGORIES, 'All documents');
    eq('no groups', r.visibleCats.length, 0);
    eq('nothing hidden', r.hiddenCount, 0);
    eq('the categories are still offered for choosing', r.filterOptions.length, CATEGORIES.length + 1);
  }

  // A document with no category at all is filed, not dropped.
  {
    const r = await filterWith(page, [{ id: 9, fileName: 'stray.pdf' }], CATEGORIES, 'All documents');
    eq('an uncategorised document lands under Other', r.visibleCats.join(','), 'Other');
  }

  ok('nothing threw', errors.length === 0, errors.join(' | '));
  await browser.close();

  // ── the screen ─────────────────────────────────────────────────────────
  ok('the list is driven by the filter, not by every group',
     /!loading && visibleCats\.map\(cat =>/.test(html));
  ok('the filter is a separate control from the upload category',
     /value:filterCat, onChange:e=>setFilterCat/.test(html) && /value:category, onChange:e=>setCategory/.test(html));
  ok('the upload one says what it is for', /"File this under:"/.test(html));
  ok('and the filter says what it is for', /"Show:"/.test(html));
  ok('counts are shown beside each choice', /c \+ " \(" \+ countIn\(c\) \+ "\)"/.test(html));
  ok('there is one click back to everything', /"Show all"/.test(html));
  // A filter matching nothing must not read as the documents having vanished.
  ok('an empty filter says what is being held back',
     /Nothing filed under/.test(html) && /choose/.test(html));
  ok('and a filtered view says how many more there are',
     /more hidden by this filter/.test(html));
  // The earlier fix must survive: a read that failed is still not "none".
  ok('a failed read is still told apart from an empty folder',
     /!loading && !docsError && docs\.length === 0/.test(html));

  const failed = checks.filter(c => !c.ok);
  for (const c of failed) {
    console.log('  FAIL  ' + c.name);
    if (c.want !== undefined) console.log('        wanted ' + JSON.stringify(c.want));
    if (c.got !== undefined) console.log('        got    ' + JSON.stringify(c.got));
  }
  console.log('  ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
