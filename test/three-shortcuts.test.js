// Three more from the desk.
//
//  1. A name on the day sheet was not clickable, so the desk went back to
//     Patient Search and typed a UHID that was already on the screen.
//  2. Looking up what has already been done took three screens: Records,
//     then Treatment Progress, then the Procedure Done tab.
//  3. A prescription existed only on the paper the patient walked out with.
//     Nobody could look up what was given last time without asking them.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const GS = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── 2. one click to the procedures already done ─────────────────────────
ok('Procedures Done is offered from the active patient box',
   /\{ id:"procedures",\s+label:"🗂 Procedures Done"\s+\}/.test(HTML));
ok('and from the Records page',
   HTML.slice(HTML.indexOf('const RECORDS_MENU_ITEMS'),
              HTML.indexOf('function RecordsPicker')).indexOf('"procedures"') >= 0);
ok('it opens Treatment Progress already on the right tab',
   /else if \(id === "procedures"\) \{ setProgressInitialTab\("procedure"\); setPage\("progress"\); \}/.test(HTML));
ok('which is the tab the procedures live on',
   /useState\(initialTab \|\| "procedure"\)/.test(HTML));
// Every picker routes through the same navigation, or one of them silently
// would not know what "procedures" means.
ok('every picker uses the one navigator',
   (HTML.match(/onNavigate: navigateFromSearch/g) || []).length >= 3,
   (HTML.match(/onNavigate: navigateFromSearch/g) || []).length);
ok('and none of them has its own idea of where to go',
   !/onNavigate: *\(id\) *=>/.test(HTML) && !/onNavigate: *setPage\b(?![\s\S]{0,40}FollowUps)/.test(
     HTML.slice(HTML.indexOf('page === "folder_picker"'), HTML.indexOf('page === "crm"'))));

// ── 1. the day sheet opens the patient ──────────────────────────────────
ok('the day sheet is given a way to open a patient',
   /function Daysheet\(\{ globalPat, setGlobalPat, openPatientAt \}\)/.test(HTML));
ok('and is handed one', /openPatientAt: openPatientAt/.test(HTML));
ok('opening a patient from a list does not go via Patient Search',
   /const openPatientAt = \(patient, dest\) => \{[\s\S]*?setGlobalPat\(patient\);[\s\S]*?navigateFromSearch\(dest \|\| "clinical_records"\);/.test(HTML));
ok('a row with no UHID is not made clickable, since there is nobody to open',
   /\(a\.uhid && openPatientAt\)/.test(HTML));
ok('the name opens the folder',
   /openPatientAt\(\{ uhid:a\.uhid, name:a\.patientName\|\|"", mobile:a\.mobile\|\|"" \}, "clinical_records"\)/.test(HTML));
ok('and there is a second click straight to what has been done',
   /openPatientAt\(\{ uhid:a\.uhid, name:a\.patientName\|\|"", mobile:a\.mobile\|\|"" \}, "procedures"\)/.test(HTML));

// ── 3. the prescription keeps a copy ────────────────────────────────────
const a = HTML.indexOf('const PRESCRIPTION_FORM_B64 =');
const PRESC = Buffer.from((HTML.slice(a, HTML.indexOf(';\n', a)).match(/"([^"]*)"/g) || [])
  .map(s => s.slice(1, -1)).join(''), 'base64').toString('utf8');

ok('printing also keeps a copy', /keepACopy\(\);/.test(PRESC));
ok('filed under the patient, as a prescription',
   /docName: 'Prescription', category: 'Prescriptions'/.test(PRESC));
ok('keeping it never delays the printing the patient is waiting for',
   PRESC.indexOf('setTimeout(function(){ w.print(); }, 600);') <
   PRESC.indexOf('keepACopy();'));
ok('a form with no UHID says it was not kept rather than failing quietly',
   /Printed, but not kept/.test(PRESC));
ok('and a rejected save says so too', /Printed, but NOT kept/.test(PRESC));
ok('as does no answer at all', /no answer about keeping a copy/.test(PRESC));
ok('the host turns it into a PDF in the patient\'s documents',
   /d\.type === "KB_SAVE_PDF" && d\.html && d\.uhid/.test(HTML) &&
   /apiPost\("createDocumentPDF"/.test(HTML));
ok('sent as a body, since a printed document will not fit in a query string',
   /apiPost\("createDocumentPDF", \{/.test(HTML));
ok('and that endpoint files it where the Documents tab will find it',
   /Also index it alongside uploaded documents/.test(GS));
ok('which is session-protected, because it is patient data',
   /"getPatientDocumentContent", "createDocumentPDF"/.test(GS));

(async () => {
  // The two versions of the case paper, built for real.
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  const file = path.join(require('os').tmpdir(), 'presc-' + Date.now() + '.html');
  fs.writeFileSync(file, PRESC);
  await page.goto('file://' + file);
  await page.waitForTimeout(250);

  const built = await page.evaluate(() => {
    document.getElementById('pName').value = 'Asha Verma';
    document.getElementById('pId').value = 'KB0001';
    document.getElementById('pAge').value = '41';
    window.KB_CLINIC = { name: 'K.B. Dental Clinic', address: 'R-74B Dilshad Garden', phone: '7866939786' };
    return { print: buildCasePaperHTML(false), pdf: buildCasePaperHTML(true) };
  });

  ok('the printed copy reserves the pad\'s margins', /margin:44mm 15mm 15mm 52mm/.test(built.print), built.print.slice(0, 120));
  // The rule is in the stylesheet either way; what matters is that the
// printed copy does not DRAW one over the pad's own.
ok('and draws no letterhead, because the pad already has one',
     built.print.indexOf('<div class="kb-hdr">') < 0);
  ok('the kept copy uses ordinary margins instead',
     /margin:14mm 14mm 14mm 14mm/.test(built.pdf), built.pdf.slice(0, 120));
  ok('and puts the clinic on it, or it is a page of white space',
     /K\.B\. Dental Clinic/.test(built.pdf) && /R-74B Dilshad Garden/.test(built.pdf));
  ok('both carry the same patient', /Asha Verma/.test(built.print) && /Asha Verma/.test(built.pdf));
  ok('and the same UHID', /KB0001/.test(built.print) && /KB0001/.test(built.pdf));
  ok('both are the same document otherwise',
     built.print.indexOf('Treatments Done') > 0 && built.pdf.indexOf('Treatments Done') > 0 &&
     built.print.indexOf('Prescriptions') > 0 && built.pdf.indexOf('Prescriptions') > 0);

  // What the form actually sends up.
  const sent = await page.evaluate(() => new Promise(resolve => {
    window.parent = { postMessage: (m) => resolve(m) };
    Object.defineProperty(window, 'parent', { value: { postMessage: (m) => resolve(m) }, writable: true });
    keepACopy();
  }));
  eq('it asks for the document to be kept', sent.type, 'KB_SAVE_PDF');
  eq('against the right patient', sent.uhid, 'KB0001');
  eq('with their name', sent.patientName, 'Asha Verma');
  ok('and sends the kept version, not the one meant for the pad',
     /margin:14mm/.test(sent.html), sent.html.slice(0, 100));
  ok('nothing threw', errors.length === 0, errors.join(' | '));

  fs.unlinkSync(file);
  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => {
    if (c.ok) { pass++; console.log('  PASS  ' + c.name); }
    else {
      fail++;
      console.log('  FAIL  ' + c.name +
        (c.want !== undefined ? '\n          got ' + JSON.stringify(c.got) + ', want ' + JSON.stringify(c.want)
                              : c.got ? '\n          ' + JSON.stringify(c.got) : ''));
    }
  });
  console.log('==============================================================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
