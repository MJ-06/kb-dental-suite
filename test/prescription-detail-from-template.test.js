// "in the prescription there has some detail to be written from the template
//  of work done and not the way you have left alone."
//
// A prescription that is a code, a name and a tooth number is a list, not a
// prescription. The detail the Wellness Centre reads is already written
// once, in Master → Clinical Configuration → Clinical Note Templates, and
// or left off. So each endorsed line is prefilled from the template that
// matches it -- and stays editable, because a template is a starting point
// and the doctor has the last word on their own sheet.
//
// The matching is run, not read. A wrong match puts one treatment's clinical
// note under another treatment's name on a sheet that goes to the panel.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

const cut = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));

// ── the matcher ─────────────────────────────────────────────────────────
{
  const ctx = { String, Array, Object };
  vm.createContext(ctx);
  vm.runInContext(cut('const CGHS_TPL_STOP = [', 'function CghsPrescription(')
    + '\nthis.pick = cghsTemplateFor; this.fill = cghsFillTokens; this.blank = cghsBlankTokens;', ctx);
  const { pick, fill, blank } = ctx;

  const TPL = [
    { situation: 'Flap Surgery', category: 'Periodontics', text: 'Flap raised under LA on {tooth}. Sutures placed.' },
    { situation: 'Scaling', category: 'Periodontics', text: 'Ultrasonic scaling done. Advised {brand} mouthwash.' },
    { situation: 'Root Canal Treatment', category: 'RCT', text: 'Access cavity prepared on {tooth}.' },
    { situation: 'Crown & Bridge', category: 'Crown & Bridge', text: 'Impression taken for {units} unit(s).' },
    { situation: 'Post & Core', category: 'Crown & Bridge', text: 'Post space prepared.' },
    { situation: 'Nothing Written Here', category: 'RCT', text: '   ' }
  ];
  const got = (p) => { const t = pick(p, TPL); return t ? t.situation : null; };

  eq('an exact name matches', got('Scaling'), 'Scaling');
  eq('the case it is written in does not matter', got('sCaLiNg'), 'Scaling');
  // The rate card says "Flap Surgery- Per Tooth"; the template is filed
  // under "Flap Surgery". This is the normal case, not the exception.
  eq('a rate-card name finds the template inside it', got('Flap Surgery- Per Tooth'), 'Flap Surgery');
  eq('punctuation between the words is ignored', got('Root  Canal / Treatment'), 'Root Canal Treatment');
  eq('a longer template name still matches a shorter procedure',
     got('Crown'), 'Crown & Bridge');
  // The one that must not go wrong: "Post & Core Crown" sharing the word
  // "crown" with "Crown & Bridge" while naming Post & Core exactly.
  eq('the closer of two candidates wins', got('Post & Core Crown'), 'Post & Core');
  eq('words that say nothing carry no match on their own', got('Per Tooth Upper Arch'), null);
  eq('a treatment with no template gets none', got('Orthodontic Retainer'), null);
  eq('a template with no text is not offered', got('Nothing Written Here'), null);
  eq('no procedure matches nothing', got(''), null);
  eq('and no templates at all is not an error', pick('Scaling', []), null);
  eq('nor is an undefined list', pick('Scaling', undefined), null);
  eq('nor an undefined procedure', pick(undefined, TPL), null);

  // ── the tokens ────────────────────────────────────────────────────────
  eq('what is known is filled in',
     fill('Flap raised on {tooth} for {units} unit(s).', { tooth: '16, 26', units: 2 }),
     'Flap raised on 16, 26 for 2 unit(s).');
  // Left showing on screen: "{brand}" is the clearest instruction there is
  // to type the brand.
  eq('what is not known is left showing, so it is obvious what to type',
     fill('Advised {brand} mouthwash.', { tooth: '16' }), 'Advised {brand} mouthwash.');
  eq('a blank value counts as not known',
     fill('On {tooth}.', { tooth: '   ' }), 'On {tooth}.');
  eq('and nothing at all is not a crash', fill(undefined, {}), '');
  eq('a token with no values given survives', fill('On {tooth}.', undefined), 'On {tooth}.');
  // But it never reaches the paper as a brace.
  eq('on paper an unfilled token is a blank to write on',
     blank('Advised {brand} mouthwash, {times} a day.'),
     'Advised __________ mouthwash, __________ a day.');
  eq('text with nothing left to fill is untouched',
     blank('Ultrasonic scaling done.'), 'Ultrasonic scaling done.');
}

// ── the screen ──────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div></body>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });

  await page.addScriptTag({ content: `
    const T="#0078B4", BORDER="#e5e5e0", TODAY="06/11/2026";
    const inp={padding:"6px 10px",fontSize:14,border:"1px solid #e5e5e0",borderRadius:6,
               background:"#fff",color:"#1a1a1a",boxSizing:"border-box",fontFamily:"inherit"};
    const usePadMargins = () => ({});
    const cghsEsc = (v) => String(v === undefined || v === null ? "" : v)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const cghsPadCss = () => "";
    const calcAge = () => "54";
    const fmtDMY = (d) => d ? String(d).split("-").reverse().join("/") : "";
    const toISODate = () => "2026-11-06";
    const signatureLine = () => "Dr. Someone";
    const CghsLines = () => null;
    window.__printed = null;
    const cghsPrint = (h) => { window.__printed = h; };
    window.__templates = [];
    const api = (action) => Promise.resolve(action === "getClinicalNoteTemplates"
      ? { success: true, templates: window.__templates } : { success: false });
  ` });
  await page.addScriptTag({ content: cut('// ── Stage 2: the prescription ─', 'function CghsBill(') });

  const LINES = [
    { code: 'DP007', qty: 2, amt: 0, priced: true, rate: 0,
      r: { procedure: 'Flap Surgery- Per Tooth', tooth: '16, 26' }, card: null },
    { code: 'DP001', qty: 1, amt: 0, priced: true, rate: 0,
      r: { procedure: 'Scaling', tooth: 'Full Mouth' }, card: null },
    { code: 'DX900', qty: 1, amt: 0, priced: true, rate: 0,
      r: { procedure: 'Orthodontic Retainer', tooth: '' }, card: null }
  ];
  const TPL = [
    { situation: 'Flap Surgery', text: 'Flap raised under LA on {tooth}. Sutures placed, review in 7 days.' },
    { situation: 'Scaling', text: 'Ultrasonic scaling and polishing done. Advised {brand} mouthwash.' }
  ];

  const mount = async (templates) => {
    await page.evaluate(({ lines, templates }) => {
      window.__templates = templates;
      window.__printed = null;
      const root = document.getElementById('root');
      ReactDOM.render(null, root);
      ReactDOM.render(React.createElement(CghsPrescription, {
        key: String(Math.random()),
        pat: { uhid: 'AL1010', name: 'Santosh Kumar', dob: '1972-04-03' },
        lines: lines
      }), root);
    }, { lines: LINES, templates });
    await page.waitForTimeout(120);
  };
  const boxes = () => page.$$eval('textarea', els => els.map(e => e.value));
  const text = () => page.$eval('#root', el => el.innerText.replace(/\s+/g, ' ').trim());

  await mount(TPL);
  let vals = await boxes();
  eq('there is a box for every endorsed line', vals.length, 3);
  eq('the matching template fills the first, with the teeth in it', vals[0],
     'Flap raised under LA on 16, 26. Sutures placed, review in 7 days.');
  ok('the second is filled too, with what it cannot know left showing',
     /Ultrasonic scaling and polishing done\. Advised \{brand\} mouthwash\./.test(vals[1]), vals[1]);
  eq('a line with no template is left empty to type into', vals[2], '');
  ok('and the screen says how many matched', /2 of 3 matched/.test(await text()), await text());

  // Edited by hand, and the edit is what prints.
  // Typed the way a person types it. Assigning .value and firing an event
  // updates the DOM and not React's state, so the box would read back as
  // edited while the print still used the suggestion -- which is exactly
  // the difference this check exists to catch.
  await page.locator('textarea').nth(2).fill('Upper Hawley retainer delivered. Reviewed fit.');
  await page.waitForTimeout(80);
  vals = await boxes();
  eq('a box can be typed into', vals[2], 'Upper Hawley retainer delivered. Reviewed fit.');
  eq('and the others are untouched', vals[0],
     'Flap raised under LA on 16, 26. Sutures placed, review in 7 days.');

  await page.click('button');
  await page.waitForTimeout(80);
  const printed = await page.evaluate(() => window.__printed);
  ok('the sheet prints', /Treatment Advised/.test(printed || ''), String(printed).slice(0, 120));
  ok('the detail is on it, under its own line',
     /Flap raised under LA on 16, 26\. Sutures placed, review in 7 days\./.test(printed), '');
  ok('the typed detail is on it', /Upper Hawley retainer delivered/.test(printed), '');
  // The one thing that must never reach the panel.
  ok('no token reaches the paper in braces', !/\{[a-z]+\}/i.test(printed), '');
  ok('it becomes a blank to write on instead', /Advised __________ mouthwash/.test(printed), '');
  ok('every endorsed line is still on the sheet',
     /Flap Surgery- Per Tooth/.test(printed) && /Scaling/.test(printed)
     && /Orthodontic Retainer/.test(printed), '');
  ok('and so are the tooth numbers and units',
     /16, 26/.test(printed) && /Full Mouth/.test(printed), '');

  // No templates at all: it says where to add them, and still works.
  await mount([]);
  // The pointer has to name where they ARE. It said Master -> Notes until
  // that category was folded into Clinical Configuration.
  ok('with no templates it says where they live',
     /Master . Clinical Configuration . Clinical Note Templates/.test(await text()), await text());
  eq('and there is still a box per line', (await boxes()).length, 3);

  eq('nothing threw', errors, []);
  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => {
    if (c.ok) pass++;
    else {
      fail++;
      console.log('  FAIL  ' + c.name +
        (c.want !== undefined ? '\n          got ' + JSON.stringify(c.got) + ', wanted ' + JSON.stringify(c.want)
         : c.got ? '\n          ' + c.got : ''));
    }
  });
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  the harness itself: ' + (e && e.stack || e)); process.exit(1); });
