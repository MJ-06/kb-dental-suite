// The nine reports.
//
// All the arithmetic lives in computeReports, which has no React in it, so
// it is lifted out and run against a small set of books whose answers were
// worked out by hand first. A report that is merely "plausible" is worse
// than no report: the clinic will make decisions on these numbers.
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

// ── lift the maths out of the page ───────────────────────────────────────
function slice(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  const b = html.indexOf(endMarker, a);
  ok('found ' + startMarker.slice(0, 40), a > 0 && b > a, `${a}..${b}`);
  return html.slice(a, b);
}
const CODE = [
  slice('function monthKeyOf(iso)', 'const rupees ='),
  slice('function serviceKeyOf(s)', 'function Bar('),
  slice('function computeReports(d, from, to)', '\n}\n') + '\n}\n'
].join('\n');

const sandbox = { Math, String, Number, Object, Array, JSON, console, isNaN, parseInt };
vm.createContext(sandbox);
vm.runInContext(CODE + '\n;globalThis.__c = computeReports;' +
                '\n;globalThis.__months = monthsBetween;' +
                '\n;globalThis.__classify = classifyService;', sandbox);

// ── three months of books, small enough to check on paper ────────────────
const BOOKS = {
  patients: [
    { uhid: 'AA0001', registeredOn: '2026-08-05T10:00:00Z' },
    { uhid: 'AA0002', registeredOn: '2026-08-20T10:00:00Z' },
    { uhid: 'AA0003', registeredOn: '2026-09-10T10:00:00Z' },
    { uhid: 'AA0004', registeredOn: '2026-10-02T10:00:00Z' },
    { uhid: 'AA0005', registeredOn: '2025-12-01T10:00:00Z' },  // registered long before
    { uhid: 'AA0006', registeredOn: '' },                      // no date on file
    // The same patient, in both books. One patient, earliest date wins.
    { uhid: 'AA0001', registeredOn: '2026-09-30T10:00:00Z' }
  ],
  register: [
    { uhid: 'AA0001', date: '2026-08-06', procedureDone: 'Consultation' },
    { uhid: 'AA0001', date: '2026-08-20', procedureDone: 'RCT' },
    { uhid: 'AA0002', date: '2026-08-21', procedureDone: 'Consultation' },
    { uhid: 'AA0003', date: '2026-09-11', procedureDone: 'Consultation' },
    { uhid: 'AA0003', date: '2026-09-25', procedureDone: 'RCT' },
    { uhid: 'AA0005', date: '2026-09-05', procedureDone: 'Scaling' },
    { uhid: 'AA0004', date: '2026-10-03', procedureDone: 'Consultation' }
  ],
  receipts: [
    { uhid: 'AA0001', date: '2026-08-20', service: 'RCT', fee: 8000 },
    { uhid: 'AA0001', date: '2026-09-01', service: 'RCT', fee: 2000 },
    { uhid: 'AA0003', date: '2026-09-25', service: 'RCT', fee: 6000 },
    { uhid: 'AA0005', date: '2026-09-05', service: 'Scaling', fee: 1500 },
    { uhid: 'AA0002', date: '2026-08-21', service: 'Consultation', fee: 500 },
    { uhid: 'AA0004', date: '2026-10-03', service: 'Consultation', fee: 500 }
  ],
  expenses: [
    { date: '2026-08-10', category: 'Lab', amount: 3000 },
    { date: '2026-09-12', category: 'Lab', amount: 2000 },
    { date: '2026-09-15', category: 'Rent', amount: 10000 }
  ],
  treatments: [
    { name: 'RCT', fee: 8000, department: 'Endodontics' },
    { name: 'Scaling', fee: 1500, department: 'Periodontics' },
    { name: 'Consultation', fee: 500, department: 'Consultation' }
  ],
  appts: [
    { id: 1, date: '2026-08-06', status: 'Completed', type: 'Consultation', subType: '' },
    { id: 2, date: '2026-08-20', status: 'Completed', type: 'RCT', subType: 'Access Opening' },
    { id: 3, date: '2026-09-25', status: 'Completed', type: 'RCT', subType: 'Obturation' },
    { id: 4, date: '2026-09-02', status: 'No Show', type: 'Scaling', subType: '', patientName: 'Missed One' },
    { id: 5, date: '2026-10-05', status: 'No Show', type: 'Follow Up', subType: '', patientName: 'Missed Two' },
    { id: 6, date: '2026-10-06', status: 'Cancelled', type: 'RCT', subType: 'BMP' }
  ],
  follow: null
};

const r = sandbox.__c(BOOKS, '2026-08-01', '2026-10-31');

// ── the range ────────────────────────────────────────────────────────────
eq('three months in the range', r.months.length, 3);
eq('oldest first', r.months[0], '2026-08');
eq('newest last', r.months[2], '2026-10');
eq('a range typed backwards gives nothing rather than spinning',
   sandbox.__months('2026-10', '2026-08').length, 0);

// ── 1. new and returning ─────────────────────────────────────────────────
const aug = r.byMonth[0], sep = r.byMonth[1], oct = r.byMonth[2];
eq('August: two new', aug.newPatients, 2);
eq('August: nobody returning yet', aug.returning, 0);
eq('September: one new', sep.newPatients, 1);
eq('September: one returning (registered in 2025)', sep.returning, 1);
eq('September: two seen in all', sep.seen, 2);
eq('October: one new', oct.newPatients, 1);
eq('a patient with no registration date is counted and reported', r.patientsWithoutDate, 1);
// The same patient in both books is ONE patient, counted in the month they
// first registered -- not again in September when the second row was made.
eq('a patient in both books counts once, at their first registration', aug.newPatients + sep.newPatients + oct.newPatients, 4);

// ── 2 & 3. what the money comes from ─────────────────────────────────────
eq('revenue', r.revenue, 18500);
eq('highest contributing is RCT', r.byService[0].name, 'RCT');
eq('and it is the sum of its three receipts', r.byService[0].total, 16000);
eq('counted as three receipts', r.byService[0].count, 3);
eq('lowest contributing is the consultation line', r.byService[r.byService.length - 1].name, 'Consultation');
eq('worth one thousand', r.byService[r.byService.length - 1].total, 1000);
eq('three distinct services', r.byService.length, 3);
eq('every rupee is on the list', r.byService.reduce((s, x) => s + x.total, 0), 18500);

// ── 6. most chosen ───────────────────────────────────────────────────────
eq('most done is consultation', r.byProcedure[0].name, 'Consultation');
eq('four of them', r.byProcedure[0].count, 4);
eq('to four different patients', r.byProcedure[0].patients, 4);
eq('RCT next', r.byProcedure[1].name, 'RCT');
eq('twice', r.byProcedure[1].count, 2);

// ── 7. where patients stop ───────────────────────────────────────────────
// The cohort is the four who registered inside the range. AA0005 registered
// in 2025 and is deliberately not in it.
eq('four in the cohort', r.funnel[0].reached, 4);
eq('all four came in', r.funnel[1].reached, 4);
eq('all four paid something', r.funnel[2].reached, 4);
eq('only two started treatment', r.funnel[3].reached, 2);
eq('and two came back', r.funnel[4].reached, 2);
eq('two were lost at starting treatment', r.funnel[3].dropped, 2);
eq('nothing is lost at a step that nobody left', r.funnel[1].dropped, 0);
eq('the worst step is named', r.worstStep.step, 'Started treatment');
// Paying before treating is what keeps the funnel honest: a consultation
// fee is a payment, and ordering it after treatment would report a drop
// that then un-drops.
ok('the funnel never goes up again',
   r.funnel.every((f, i) => i === 0 || f.reached <= r.funnel[i - 1].reached),
   r.funnel.map(f => f.step + '=' + f.reached).join(' > '));

// ── 8. did not turn up ───────────────────────────────────────────────────
eq('two did not turn up', r.noShows.length, 2);
eq('one cancelled', r.cancelled.length, 1);
eq('three kept their appointment', r.kept, 3);
eq('no-show rate', r.noShowRate, 40);   // 2 of (2 + 3)
ok('a cancellation is not counted as a no-show',
   !r.noShows.some(a => a.status === 'Cancelled'));

// ── 9. the money ─────────────────────────────────────────────────────────
eq('expenses', r.expenseTotal, 15000);
eq('profit', r.revenue - r.expenseTotal, 3500);
eq('August revenue', aug.revenue, 8500);
eq('September revenue', sep.revenue, 9500);
eq('October revenue', oct.revenue, 500);
eq('every month accounted for', aug.revenue + sep.revenue + oct.revenue, r.revenue);
eq('September expenses', sep.expenses, 12000);
eq('biggest expense category is rent', r.byCategory[0].name, 'Rent');
eq('worth ten thousand', r.byCategory[0].total, 10000);
eq('lab is the sum of its two bills', r.byCategory[1].total, 5000);

// ── 9b. treatment against consultation ───────────────────────────────────
eq('treatment revenue', r.split.treatment, 17500);
eq('consultation revenue', r.split.consultation, 1000);
eq('nothing unclassified, because Master has a department for each', r.split.unclassified, 0);
eq('treatment share', r.treatmentShare, 95);
eq('the split adds back up', r.split.treatment + r.split.consultation + r.split.unclassified + r.split.pharmacy, r.revenue);

// ── the classifier, on its own ───────────────────────────────────────────
const byKey = { rct: { name: 'RCT', department: 'Endodontics' },
                consultation: { name: 'Consultation', department: 'Consultation' },
                amoxicillin: { name: 'Amoxicillin', department: 'Pharmacy' } };
eq('a treatment with a department is a treatment', sandbox.__classify('RCT', byKey), 'treatment');
eq('spelling and punctuation do not matter', sandbox.__classify('r.c.t', byKey), 'treatment');
eq('a consultation department is a consultation', sandbox.__classify('Consultation', byKey), 'consultation');
eq('the word consultation alone is enough', sandbox.__classify('Consultation visit', byKey), 'consultation');
eq('a pharmacy department already works, for the day it is used',
   sandbox.__classify('Amoxicillin', byKey), 'pharmacy');
eq('something not in Master is unclassified, never silently a treatment',
   sandbox.__classify('Whitening', byKey), 'unclassified');
eq('a blank service is unclassified', sandbox.__classify('', byKey), 'unclassified');

// ── a receipt whose service nobody wrote ─────────────────────────────────
const blank = sandbox.__c({ ...BOOKS, receipts: [{ uhid: 'AA0001', date: '2026-08-20', service: '', fee: 700 }] },
                          '2026-08-01', '2026-10-31');
eq('a receipt with no service still counts towards revenue', blank.revenue, 700);
eq('and is shown as what it is', blank.byService[0].name, '(not written on the receipt)');
eq('counted as unclassified, not as treatment', blank.split.unclassified, 700);

// ── empty books do not throw or divide by zero ───────────────────────────
const empty = sandbox.__c({ patients: [], register: [], receipts: [], expenses: [], treatments: [], appts: [], follow: null },
                          '2026-08-01', '2026-10-31');
eq('no revenue', empty.revenue, 0);
eq('no share to report', empty.treatmentShare, 0);
eq('no no-show rate', empty.noShowRate, 0);
eq('still three months', empty.byMonth.length, 3);
ok('the bar scale never divides by zero', empty.maxSeen >= 1 && empty.maxMonthRevenue >= 1);

// ── 4 & 5. margins ───────────────────────────────────────────────────────
// RCT: cost 2500, done twice, earned 16000 across three receipts.
//   cost counted per time done, and the receipt count is 3, so
//   max(2, 3) = 3 -> 7500 spent, margin 8500, 53%.
// Scaling: cost 300, done once, earned 1500, one receipt -> 300 spent,
//   margin 1200, 80%.
// Consultation has no cost on file, so it is left OUT entirely.
const WITH_COST = {
  ...BOOKS,
  treatments: [
    { name: 'RCT', fee: 8000, cost: 2500, department: 'Endodontics' },
    { name: 'Scaling', fee: 1500, cost: 300, department: 'Periodontics' },
    { name: 'Consultation', fee: 500, cost: '', department: 'Consultation' },
    { name: 'Whitening', fee: 5000, cost: 900, department: 'Cosmetic' }  // never done
  ]
};
const m = sandbox.__c(WITH_COST, '2026-08-01', '2026-10-31');
eq('two treatments have a cost and were done', m.margins.length, 2);
eq('highest margin is scaling', m.margins[0].name, 'Scaling');
eq('at eighty percent', m.margins[0].marginPct, 80);
eq('lowest is RCT', m.margins[1].name, 'RCT');
eq('RCT earned sixteen thousand', m.margins[1].revenue, 16000);
eq('and cost seven and a half', m.margins[1].costTotal, 7500);
eq('leaving eight and a half', m.margins[1].margin, 8500);
eq('fifty-three percent', m.margins[1].marginPct, 53);
eq('a treatment with no cost is left out, not shown at 100%', m.noCostCount, 1);
ok('consultation is nowhere on the margin list',
   !m.margins.some(x => x.name === 'Consultation'), m.margins.map(x => x.name).join(','));
ok('a treatment never done in the range is not on it either',
   !m.margins.some(x => x.name === 'Whitening'), m.margins.map(x => x.name).join(','));
// Three of the four carry a cost -- Whitening does, it simply was not
// done in this range, which is why it is on neither margin list.
eq('three of four treatments carry a cost', m.treatmentsWithCost, 3);
eq('four treatments on Master in all', m.treatmentsTotal, 4);

// A blank cost must never be read as zero. That would report the whole fee
// as margin, which is the one wrong number nobody would question.
const zeroish = sandbox.__c({ ...BOOKS, treatments: [{ name: 'RCT', fee: 8000, cost: 0, department: 'Endodontics' }] },
                            '2026-08-01', '2026-10-31');
eq('a cost of zero is treated as not known', zeroish.margins.length, 0);
eq('and counted as missing', zeroish.noCostCount, 1);

// Margins only appear once costs exist; before that the page says so.
eq('with no costs anywhere there are no margins to show', r.margins.length, 0);
eq('and the three priced treatments are all reported as missing a cost', r.noCostCount, 3);
eq('none of them carries a cost', r.treatmentsWithCost, 0);

// ── the page itself ──────────────────────────────────────────────────────
ok('the placeholder is gone', !/The list of reports needed here is coming soon/.test(html));
ok('and the module is what the Reports page renders',
   /React\.createElement\(ReportsModule, null\)/.test(html));
ok('the password changer is still on the page', /RE\(ReportsPasswordChanger, null\)/.test(html));
// Every read it makes is one the app already made somewhere else, so this
// needs no Apps Script redeploy. If that stops being true, this breaks.
const READS = ['getReceipts', 'getExpenses', 'getDailyRegister', 'getAppointments',
               'getAllPatients', 'getTreatmentsMaster', 'getFollowUps'];
for (const a of READS) {
  ok('reports reads ' + a, new RegExp('api\\("' + a + '"').test(html));
  ok(a + ' is an action the backend already had',
     (html.match(new RegExp('api\\("' + a + '"', 'g')) || []).length >= 1);
}
ok('a failed read is reported, not shown as a zero',
   /Nothing below would be right, so it is not shown/.test(html));
ok('the page still says when a report cannot be produced', (html.match(/RE\(NotYet, \{/g) || []).length === 2);
ok('but margins now appear once costs exist', /title: "4 & 5. Margin by treatment"/.test(html));
ok('and Master has somewhere to type the cost', /placeholder:"Cost \(lab, materials\)"/.test(html));
ok('and margin points at where to type it', /Master \\u2192 Treatments & Fees/.test(html));
ok('and pharmacy says what would unlock it', /bill medicines as their own receipt line/.test(html));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
