// The printed day sheet.
//
// Two things were wrong with it. It showed the appointment's REASON and not
// the step of it -- "RCT", where the surgery needs "RCT / Obturation" to know
// what to lay out -- although the step is already chosen on the booking form
// and already shown on screen. And it could only be printed: there was no
// file to send anybody.
//
// The sheet is now built once and used three ways (printed, saved as a PDF,
// sent to WhatsApp), so the three cannot drift apart. That builder is lifted
// out of the page and RUN here against made-up appointments.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : '')); }
};
const eq = (name, got, want) => ok(name, got === want, `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// ── the builder, lifted out and run ──────────────────────────────────────
const FROM = html.indexOf('  const buildScheduleHTML = () => {');
const TO = html.indexOf('  const scheduleFileName = ', FROM);
ok('the day sheet builder was found', FROM > 0 && TO > FROM, `${FROM}..${TO}`);
const BUILDER = html.slice(FROM, TO);

// reasonWithStep is the app's own, not a copy: a second implementation here
// would pass this test while the clinic saw something else.
const RW_FROM = html.indexOf('function reasonWithStep(type, subType) {');
const RW_TO = html.indexOf('\n}', RW_FROM) + 2;
const REASON_WITH_STEP = html.slice(RW_FROM, RW_TO);

function buildWith(appts, selDate) {
  const sandbox = {
    String, Object, Array, JSON, Math, console,
    appts,
    selDate: selDate || '2026-10-28',
    CLINIC: { name: 'K.B. Dental Clinic' },
    fmtDMY: iso => String(iso).slice(0, 10).split('-').reverse().join('/')
  };
  vm.createContext(sandbox);
  vm.runInContext(REASON_WITH_STEP + '\n' + BUILDER + '\n;globalThis.__out = buildScheduleHTML();', sandbox);
  return sandbox.__out;
}

// The day from the screenshot, with a step on the RCT.
const DAY = [
  { time: '10:00', chair: 'Chair 1', patientName: 'Gargi Didi', uhid: 'AA0714', type: 'Implant Prosthesis', subType: '', doctor: 'Dr. Manika Mittel', status: 'Completed' },
  { time: '11:30', chair: 'Chair 1', patientName: 'Preeti Mittal', uhid: 'AL1003', type: 'RCT', subType: 'Obturation', doctor: 'Dr. Manika Mittel', status: 'Completed' },
  { time: '14:30', chair: 'Chair 1', patientName: 'Kamal Chawla', uhid: 'AH0507', type: 'Crown & Bridge', subType: 'Cementation', doctor: 'Dr. Manika Mittel', status: 'Scheduled' },
  { time: '09:00', chair: 'Chair 2', patientName: 'Cancelled Person', uhid: 'AA0001', type: 'RCT', subType: 'BMP', doctor: 'Dr. Manika Mittel', status: 'Cancelled' }
];

const out = buildWith(DAY);

// ── 1. the step is on the sheet ──────────────────────────────────────────
ok('an appointment with a step shows the reason AND the step',
   out.includes('RCT · Obturation'), out.match(/<td>[^<]*RCT[^<]*<\/td>/g));
ok('and so does another one', out.includes('Crown &amp; Bridge · Cementation'));
ok('a reason with no step still shows just the reason',
   out.includes('<td>Implant Prosthesis</td>'));
ok('the column is headed Reason, not Type', out.includes('<th>Reason</th>'));
ok('and there is no Type heading left', !out.includes('<th>Type</th>'));

// ── 2. what belongs on it, and what does not ─────────────────────────────
ok('a cancelled appointment is still kept off the sheet',
   !out.includes('Cancelled Person'), 'a cancelled slot is not work to prepare for');
ok('the rows are in time order',
   out.indexOf('10:00') < out.indexOf('11:30') && out.indexOf('11:30') < out.indexOf('14:30'));
ok('the clinic is named at the top', out.includes('K.B. Dental Clinic'));
ok('and the date is on it', out.includes('28/10/2026'));

// ── 3. a name is text, not markup ────────────────────────────────────────
const nasty = buildWith([{ time: '10:00', chair: 'Chair 1', uhid: 'AA0002',
  patientName: 'O\'Brien & <script>alert(1)</script>', type: 'RCT', subType: 'BMP',
  doctor: 'Dr. X', status: 'Scheduled' }]);
ok('a name with an ampersand survives as text', nasty.includes('O\'Brien &amp; '), nasty);
ok('and markup typed into a name cannot reach the page',
   !nasty.includes('<script>alert(1)</script>'), nasty);

// ── 4. an empty day says so rather than printing a broken table ──────────
const empty = buildWith([]);
ok('an empty day says there are no appointments', empty.includes('No appointments'));

// ── 5. one sheet, three ways out ─────────────────────────────────────────
ok('printing uses the shared builder', /const printSchedule = \(\) => \{[\s\S]{0,200}buildScheduleHTML\(\)/.test(html));
ok('the PDF uses it too', /downloadSchedulePDF[\s\S]{0,300}buildScheduleHTML\(\)/.test(html));
ok('and so does WhatsApp', /shareScheduleWhatsApp[\s\S]{0,400}buildScheduleHTML\(\)/.test(html));
ok('the PDF and the WhatsApp copy are the same document',
   (html.match(/renderHTMLToPDFBlob\(buildScheduleHTML\(\), SCHEDULE_PDF_OPTS\)/g) || []).length === 2);
ok('WhatsApp goes through the app\'s existing share, not a second one',
   /sharePDFToWhatsApp\(\s*await renderHTMLToPDFBlob\(buildScheduleHTML\(\)/.test(html));
ok('the file is named for the day it covers',
   /"Schedule_" \+ selDate \+ "\.pdf"/.test(html));
ok('both buttons are on the toolbar',
   /onClick:downloadSchedulePDF/.test(html) && /onClick:shareScheduleWhatsApp/.test(html));
ok('and they say they are working, so nobody presses twice',
   /schedBusy \? "Working/.test(html));

// ── 6. a long day is not quietly cut off ─────────────────────────────────
ok('the day sheet asks for a paginated PDF',
   /SCHEDULE_PDF_OPTS = \{ orientation: "portrait", format: "a4", width: 794, multipage: true \}/.test(html));

// The renderer, run for real against a stub canvas and a stub jsPDF. The
// page count is the thing that matters -- a busy day losing its afternoon
// would look exactly like a working PDF -- so it is counted, not read.
const R_FROM = html.indexOf('async function renderHTMLToPDFBlob(html, opts) {');
const R_TO = html.indexOf('\n}', html.indexOf('return pdf.output("blob");',
             html.indexOf('pdf.addImage(strip.toDataURL', R_FROM))) + 2;
ok('the renderer was found', R_FROM > 0 && R_TO > R_FROM, `${R_FROM}..${R_TO}`);

async function renderPages(bodyHeightPx, canvasHeightPx, opts) {
  const added = [];
  const pages = [];
  const canvasStub = (w, h) => ({
    width: w, height: h,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/png;base64,AA'
  });
  const sandbox = {
    Math, String, Number, Promise, setTimeout, JSON, Object, console,
    html2canvas: async () => canvasStub(1588, canvasHeightPx),
    document: {
      createElement: tag => tag === 'canvas'
        ? canvasStub(0, 0)
        : {
            style: { cssText: '', height: '' },
            onload: null,
            set srcdoc(v) { setTimeout(() => this.onload && this.onload(), 0); },
            contentDocument: { body: { scrollHeight: bodyHeightPx } }
          },
      body: { appendChild() {}, removeChild() {} }
    },
    window: {
      jspdf: {
        jsPDF: class {
          constructor() {
            // A4 portrait in mm.
            this.internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
            pages.push(1);
          }
          addImage(...a) { added.push(a); }
          addPage() { pages.push(1); }
          output() { return 'BLOB'; }
        }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(R_FROM, R_TO) + '\n;globalThis.__render = renderHTMLToPDFBlob;', sandbox);
  const blob = await sandbox.__render('<html></html>', opts);
  return { blob, pages: pages.length, images: added.length };
}

(async () => {
  // A4 at 1588px wide: a page is 1588 * 297/210 ≈ 2246px tall.
  const short = await renderPages(600, 1500, { orientation: 'portrait', format: 'a4', multipage: true });
  eq('a sheet that fits is one page', short.pages, 1);
  eq('drawn once', short.images, 1);

  // A page is 1588 * 297/210 = 2245px at this width, so three of them exactly.
  const long = await renderPages(4000, 2245 * 3, { orientation: 'portrait', format: 'a4', multipage: true });
  eq('a sheet three pages deep gives three pages', long.pages, 3);
  eq('each one drawn', long.images, 3);
  eq('and a blob comes back', long.blob, 'BLOB');

  // A few pixels past the bottom get a page of their own. That is a nearly
  // empty last sheet, which is untidy -- and the alternative is dropping
  // whatever is in those pixels, which on a day sheet is somebody's
  // appointment. Untidy wins.
  const sliver = await renderPages(4000, 2245 * 3 + 60, { orientation: 'portrait', format: 'a4', multipage: true });
  eq('and sixty pixels more are not thrown away', sliver.pages, 4);

  // A receipt must take exactly the path it always took: one page, centred,
  // cropped if it somehow overflows. Changing that would change every
  // receipt the clinic has ever printed.
  const receipt = await renderPages(500, 4000, { orientation: 'landscape', format: 'a5' });
  eq('a receipt is still one page even when tall', receipt.pages, 1);
  eq('and drawn once', receipt.images, 1);

  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
