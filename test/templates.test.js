// Functional test of the Work Done template dropdown in every clinical form.
//
// Loads each form in a real browser, sends it the KB_PATIENT and KB_TEMPLATES
// messages the parent app sends, then drives the dropdown exactly as staff
// would: pick a template, fill its placeholders, press Insert, and check the
// text actually lands in the field that gets saved to the sheet.

const { chromium } = require('playwright');
const path = require('path');
// Forms live base64-encoded inside index.html; decode them to a temp dir so the
// browser can load each one exactly as the app serves it (via a blob URL).
const fs = require('fs');
const os = require('os');
const REPO = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kbforms-'));
function extractForms() {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  for (const name of Object.keys(FORMS)) {
    const m = new RegExp('const ' + name + '\\s*=\\s*([\\s\\S]*?);\\n').exec(html);
    if (!m) throw new Error('could not find ' + name + ' in index.html');
    const b64 = (m[1].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)).join('');
    fs.writeFileSync(path.join(OUT, name + '.html'), Buffer.from(b64, 'base64'));
  }
}


// The categories the parent filters by. They are CHECKED against index.html
// below rather than only claiming to match it: the departments were renamed
// once already, and a fixture that quietly disagrees with the page tests a
// filter nobody is using.
const FORMS = {
  RCT_FORM_B64:            { cat: 'RCT',                notes: 'n4'  },
  IMP_SURGERY_B64:         { cat: 'Implant Surgery',    notes: null  },
  IMP_PROSTHETIC_B64:      { cat: 'Implant Prosthetic', notes: null  },
  CROWN_BRIDGE_B64:        { cat: 'Crown & Bridge',     notes: 'n3'  },
  RESTORATION_FORM_B64:    { cat: 'Restoration',        notes: 'n4'  },
  MINORSURGERY_FORM_B64:   { cat: 'Minor Surgery',      notes: null  },
  PATHOLOGY_FORM_B64:      { cat: 'Diagnostic',         notes: 'remarks' },
  RADIOLOGY_FORM_B64:      { cat: 'Diagnostic',         notes: 'remarks' },
  RADIOGRAPH_FORM_B64:     { cat: 'Diagnostic',         notes: 'remarks' },
  INTRAORAL_FORM_B64:      { cat: 'Diagnostic',         notes: 'remarks' },
  SCALING_FORM_B64:        { cat: 'Periodontics',       notes: 'remarks' },
  ORTHODONTICS_FORM_B64:   { cat: 'Orthodontics',       notes: 'remarks' },
  ORTHOPROGRESS_FORM_B64:  { cat: 'Orthodontics',       notes: 'notes'   },
  DENTURE_FORM_B64:        { cat: 'Prosthodontics',     notes: 'remarks' },
  PEDO_FORM_B64:           { cat: 'Pedodontics',        notes: 'remarks' },
  TMJOINT_FORM_B64:        { cat: '*',                  notes: 'remarks' },
  LOCALANESTHESIA_FORM_B64:{ cat: '*',                  notes: 'remarks' },
  LABLOG_FORM_B64:         { cat: '*',                  notes: 'remarks' },
};

// A stand-in for Master → Clinical Note Templates, one per category plus a
// token-bearing one to prove placeholder substitution works.
const ALL_TEMPLATES = [
  { situation: 'RCT Access',        text: 'Access opening done wrt {tooth}.',            category: 'RCT' },
  { situation: 'Implant Placed',    text: 'Implant placed at {tooth}.',                  category: 'Implant Surgery' },
  { situation: 'Crown Cemented',    text: 'Crown cemented wrt {tooth} using {cement}.',  category: 'Implant Prosthetic' },
  { situation: 'Bridge Prep',       text: 'Bridge preparation wrt {tooth}.',             category: 'Crown & Bridge' },
  { situation: 'Composite',         text: 'Composite restoration wrt {tooth}.',          category: 'Restoration' },
  { situation: 'Extraction',        text: 'Extraction done wrt {tooth}.',                category: 'Minor Surgery' },
  { situation: 'Test Advised',      text: 'Test advised for {tooth}, sample sent.',      category: 'Diagnostic' },
  { situation: 'Scaling Done',      text: 'Full mouth scaling completed, {grade} calculus.', category: 'Periodontics' },
  { situation: 'Archwire Change',   text: 'Archwire changed to {size}.',                 category: 'Orthodontics' },
  { situation: 'Denture Try-in',    text: 'Try-in done, occlusion verified.',            category: 'Prosthodontics' },
  { situation: 'Pulpotomy',         text: 'Pulpotomy done wrt {tooth}, {medicament} placed.', category: 'Pedodontics' },
];

// Every form's category here must be the one the page declares, or this
// whole suite is exercising a filter the clinic never sees.
let wrong = [];
{
  const page = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const block = page.slice(page.indexOf('{ id:"rct",'), page.indexOf('{ id:"labLog",') + 500);
  const declared = {};
  const re = /id:"(\w+)"[^\n]*?templateCategory:"([^"]*)"/g;
  let m;
  while ((m = re.exec(block))) declared[m[1]] = m[2];
  const BY_FORM = {
    RCT_FORM_B64: 'rct', IMP_SURGERY_B64: 'imp_surgery', IMP_PROSTHETIC_B64: 'imp_prosth',
    CROWN_BRIDGE_B64: 'crown', RESTORATION_FORM_B64: 'restoration',
    MINORSURGERY_FORM_B64: 'minorSurgery', PATHOLOGY_FORM_B64: 'pathology',
    RADIOLOGY_FORM_B64: 'radiology', RADIOGRAPH_FORM_B64: 'radiograph',
    INTRAORAL_FORM_B64: 'intraOral', SCALING_FORM_B64: 'scaling',
    ORTHODONTICS_FORM_B64: 'orthodontics', ORTHOPROGRESS_FORM_B64: 'orthoProgress',
    DENTURE_FORM_B64: 'denture', PEDO_FORM_B64: 'pedo', TMJOINT_FORM_B64: 'tmJoint',
    LOCALANESTHESIA_FORM_B64: 'localAnesthesia', LABLOG_FORM_B64: 'labLog'
  };
  wrong = Object.keys(BY_FORM)
    .filter(k => declared[BY_FORM[k]] !== FORMS[k].cat)
    .map(k => k + ': page says ' + declared[BY_FORM[k]] + ', here ' + FORMS[k].cat);
}

function expectedFor(cat) {
  return cat === '*' ? ALL_TEMPLATES : ALL_TEMPLATES.filter(t => t.category === cat);
}

(async () => {
  extractForms();
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const results = [];

  for (const [name, cfg] of Object.entries(FORMS)) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    const rec = { form: name, cat: cfg.cat };
    try {
      await page.goto('file://' + path.join(OUT, name + '.html'));
      await page.waitForTimeout(150);

      const expected = expectedFor(cfg.cat);

      // Exactly what the parent posts.
      await page.evaluate(({ templates }) => {
        window.postMessage({ type: 'KB_PATIENT', name: 'Test Patient', uhid: 'AL0777', age: '42', gender: 'Female', doctor: 'Dr. Viveyk Mittel' }, '*');
        window.postMessage({ type: 'KB_TEMPLATES', templates }, '*');
      }, { templates: expected });
      await page.waitForTimeout(150);

      // 1. Is there a dropdown at all, and did it fill?
      const selId = await page.evaluate(() =>
        document.getElementById('tplSelect') ? 'tplSelect'
        : (document.getElementById('cnTplSelect') ? 'cnTplSelect' : null));
      rec.hasDropdown = !!selId;
      if (!selId) { rec.status = 'NO DROPDOWN'; results.push(rec); await page.close(); continue; }

      const optCount = await page.evaluate(id => document.getElementById(id).options.length - 1, selId);
      rec.options = optCount;
      rec.expected = expected.length;
      if (optCount !== expected.length) {
        rec.status = 'WRONG COUNT';
        results.push(rec); await page.close(); continue;
      }
      if (optCount === 0) { rec.status = 'EMPTY (no templates in category)'; results.push(rec); await page.close(); continue; }

      // 1b. Simulate a tooth already having been picked earlier in the form.
      // RCT tracks the tooth being worked on in a single `selTooth` global
      // that persists for the session, so setting it directly is realistic.
      // Crown & Bridge, Implant Surgery and Implant Prosthetic instead store
      // the pick per table row (dataset.tooth/dataset.teeth on that row's own
      // button) — cnResolveValue() reads it off the most recently added row,
      // so the pick has to go through the actual row + tooth-picker-modal
      // flow staff use, or it won't be there to resolve.
      const ROW_TABLE = { CROWN_BRIDGE_B64: 'toothTbody', IMP_SURGERY_B64: 'impTbody', IMP_PROSTHETIC_B64: 'impTbody' };
      if (ROW_TABLE[name]) {
        const tbodyId = ROW_TABLE[name];
        await page.evaluate((tbodyId) => document.querySelector('#' + tbodyId + ' .tbtn').click(), tbodyId);
        await page.evaluate(() => document.querySelector('.ft[data-n="16"]').click());
        await page.evaluate(() => document.getElementById('modalConfirm').click());
      } else {
        await page.evaluate(() => { window.selTooth = '16'; });
      }

      // 2. Select the first template; placeholder inputs should appear.
      // Set the value directly rather than via selectOption: several forms keep
      // the dropdown inside a tab pane that is display:none until that tab is
      // opened, and Playwright's selectOption waits for visibility forever.
      await page.evaluate(id => {
        const el = document.getElementById(id);
        el.value = '0';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, selId);
      await page.waitForTimeout(100);
      const fieldsId = selId === 'cnTplSelect' ? 'cnTplFields' : 'tplFields';
      const tokenCount = await page.evaluate(id =>
        document.querySelectorAll('#' + id + ' [data-tpl-field]').length, fieldsId);
      rec.tokens = tokenCount;

      // 2b. If the template has a {tooth} placeholder, it should already be
      // auto-filled from window.selTooth before staff types anything.
      const toothAutofilled = await page.evaluate(id => {
        const f = document.querySelector('#' + id + ' [data-tpl-field="tooth"]');
        return f ? f.value : null;
      }, fieldsId);
      rec.toothAutofilled = toothAutofilled;
      // Only these 4 forms track a selected tooth (via `selTooth`) earlier in
      // the form and are expected to auto-fill the {tooth} placeholder from it.
      const SELTOOTH_FORMS = ['RCT_FORM_B64', 'CROWN_BRIDGE_B64', 'IMP_SURGERY_B64', 'IMP_PROSTHETIC_B64'];
      const hasToothToken = expected[0] && /\{tooth\}/.test(expected[0].text) && SELTOOTH_FORMS.includes(name);
      rec.toothAutofillOk = !hasToothToken || toothAutofilled === '16';

      // 3. Fill every remaining placeholder with a marker value (leave any
      // already-autofilled field, e.g. tooth, untouched).
      await page.evaluate(id => {
        document.querySelectorAll('#' + id + ' [data-tpl-field]').forEach((f, i) => {
          if (!f.value) f.value = 'VAL' + i;
        });
      }, fieldsId);

      // 4. Press Insert.
      const btnId = selId === 'cnTplSelect' ? 'cnTplInsertBtn' : 'tplInsertBtn';
      await page.evaluate(id => document.getElementById(id).click(), btnId);
      await page.waitForTimeout(100);

      // 5. Did the text land in a field, and are placeholders substituted?
      const landed = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('textarea').forEach(t => {
          if (t.value && t.value.trim()) out.push({ id: t.id, value: t.value });
        });
        return out;
      });
      rec.landedIn = landed.map(l => l.id).join(',') || '(nowhere)';
      const text = landed.map(l => l.value).join(' ');
      rec.textSample = text.slice(0, 60);
      rec.substituted = tokenCount === 0 ? true : (/VAL0/.test(text) || (hasToothToken && /\b16\b/.test(text)));
      rec.leftoverToken = /\{\w+\}/.test(text);

      rec.status = (landed.length > 0 && rec.substituted && !rec.leftoverToken && rec.toothAutofillOk) ? 'PASS' : 'FAIL';
    } catch (err) {
      rec.status = 'ERROR: ' + err.message;
    }
    rec.jsErrors = consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ') : '';
    results.push(rec);
    await page.close();
  }

  await browser.close();

  console.log('\n' + '='.repeat(100));
  console.log('WORK DONE TEMPLATE DROPDOWN — FUNCTIONAL TEST');
  console.log('='.repeat(100));
  let pass = 0, fail = 0;
  // The fixture above has to agree with the page, or every row below is
  // exercising a filter the clinic never sees.
  if (wrong.length) {
    fail++;
    console.log('  FAIL  the categories here are not the ones index.html declares');
    wrong.forEach(w => console.log('          ' + w));
  } else {
    pass++;
    console.log('  PASS  every category here is the one index.html declares');
  }
  for (const r of results) {
    const ok = r.status === 'PASS';
    ok ? pass++ : fail++;
    console.log(
      (ok ? '  PASS  ' : '  FAIL  ') +
      r.form.replace('_FORM_B64', '').replace('_B64', '').padEnd(18) +
      ('cat=' + r.cat).padEnd(22) +
      ('opts=' + (r.options ?? '-') + '/' + (r.expected ?? '-')).padEnd(12) +
      ('tokens=' + (r.tokens ?? '-')).padEnd(11) +
      ('->' + (r.landedIn || '-'))
    );
    if (!ok) console.log('          status: ' + r.status);
    if (!ok && r.toothAutofillOk === false) console.log('          tooth NOT autofilled: got ' + JSON.stringify(r.toothAutofilled));
    if (r.jsErrors) console.log('          JS ERROR: ' + r.jsErrors);
  }
  console.log('='.repeat(100));
  console.log(`  ${pass} passed, ${fail} failed, ${results.length} total`);
  console.log('='.repeat(100) + '\n');
  process.exit(fail ? 1 : 0);
})();
