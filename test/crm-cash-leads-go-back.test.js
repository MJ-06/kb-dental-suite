// "Yes do that, move the cash patients back to dental."
//
// While the app read position 0 as "the regular board", private patients
// were landing on the clinic's CGHS board: a lead opened on the board the
// panel pays through, for a patient paying their own way. Those go back.
//
// The trap is the third answer. A lead whose patient cannot be found in the
// CRM is NOT a cash patient -- it is a lead nobody can account for, and
// moving it on the assumption that no panel means no panel takes a CGHS
// patient off the board their money comes through. Unknown is counted and
// reported, never acted on.
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
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const crm = (() => {
  const m = /const CRM_B64\s*=\n/.exec(html);
  const a = m.index, b = html.indexOf(';\n', a);
  return Buffer.from((html.slice(a, b).match(/"[^"]*"/g) || [])
    .map(x => x.slice(1, -1)).join(''), 'base64').toString('utf8');
})();

function slice(from, to) {
  const a = crm.indexOf(from), b = crm.indexOf(to, a);
  ok('found ' + from.trim().slice(0, 44), a > 0 && b > a, `${a}..${b}`);
  return crm.slice(a, b);
}
const CODE = [
  slice('  function consultPipeline(list){', '  /* The register already knows'),
  slice("  var TP_NAME = 'Treatment Progress';", '  function initPipelines(){')
].join('\n');

let seq = 0;
const sandbox = {
  Object, String, Array, JSON, st: { pipelines: [] },
  uid: () => 'n' + (++seq),
  nowISO: () => '2026-11-03T05:00:00.000Z',
  DEF_PIPELINE: { id: 'p_dental', name: 'Dental Clinic Service Pipeline', stages: [] }
};
vm.createContext(sandbox);
vm.runInContext(CODE +
  '\n;globalThis.__cash = moveCashLeads;' +
  '\n;globalThis.__panelMove = movePanelLeads;' +
  '\n;globalThis.__status = patientPanelStatus;' +
  '\n;globalThis.__lookup = panelLookup;', sandbox);

// ── the clinic's two boards, as they stand after the fold ────────────────
const DENTAL = { id: 'p_dental', name: 'Dental Clinic Service Pipeline', stages: [
  { id: 's1', name: 'Initial Contact', type: 'open' },
  { id: 's2', name: 'Consultation Scheduled', type: 'open' },
  { id: 's3', name: 'Treatment Planning', type: 'open' },
  { id: 's6', name: 'Treatment Progress', type: 'open' },
  { id: 's4', name: 'Treatment Completed', type: 'close' },
  { id: 's5', name: 'Patient Lost', type: 'close' }] };
const THEIRS = { id: 'c_own1', name: 'CGHS Panel',
  panelLeadsMovedAt: '2026-11-01T00:00:00.000Z', stages: [
  { id: 'o1', name: 'Initial Contact', type: 'open' },
  { id: 'o2', name: 'Consultation Scheduled', type: 'open' },
  { id: 'o3', name: 'Treatment Planning', type: 'open' },
  { id: 'o4', name: 'Treatment Completed', type: 'close' }] };

const CONTACTS = [
  { id: 'c_cash1', firstName: 'Anita', uhid: 'KB010', panel: '', companyId: '' },
  { id: 'c_cash2', firstName: 'Vikas', uhid: 'KB011', panel: '   ', companyId: '' },
  { id: 'c_cash3', firstName: 'Meena', uhid: 'KB012', panel: '', companyId: 'co_corp' },
  { id: 'c_cghs',  firstName: 'Deepa', uhid: 'KB013', panel: 'CGHS', companyId: 'co_cghs' },
  { id: 'c_coonly',firstName: 'Suresh', uhid: 'KB014', panel: '', companyId: 'co_cghs' }
];
const COMPANIES = [
  { id: 'co_cghs', name: 'CGHS', industry: 'Panel' },
  { id: 'co_corp', name: 'Some Employer', industry: 'Corporate' }
];
const lead = (id, pipelineId, stageId, contactId, uhid, extra) => Object.assign({
  id, title: 'Consultation — ' + id, pipelineId, stageId, contactId, uhid,
  status: 'open', notes: []
}, extra || {});

function fixture() {
  return {
    pipelines: JSON.parse(JSON.stringify([THEIRS, DENTAL])),   // theirs first, on purpose
    contacts: JSON.parse(JSON.stringify(CONTACTS)),
    companies: JSON.parse(JSON.stringify(COMPANIES)),
    leads: [
      lead('l1', 'c_own1', 'o2', 'c_cash1', 'KB010'),            // cash, by contact
      lead('l2', 'c_own1', 'o3', '', 'KB011'),                   // cash, by UHID only
      lead('l3', 'c_own1', 'o4', 'c_cash3', 'KB012', { status: 'won' }), // cash, corporate employer
      lead('l4', 'c_own1', 'o2', 'c_cghs', 'KB013'),             // CGHS -- stays
      lead('l5', 'c_own1', 'o2', 'c_coonly', 'KB014'),           // panel company -- stays
      lead('l6', 'c_own1', 'o2', 'nobody', 'KB999'),             // unknown -- stays
      lead('l7', 'c_own1', 'o2', '', ''),                        // unknown -- stays
      lead('l8', 'p_dental', 's2', 'c_cash1', 'KB010')           // already where it belongs
    ],
    followups: [
      { id: 'f1', leadId: 'l1', pipelineId: 'c_own1', status: 'open' },
      { id: 'f2', leadId: 'l4', pipelineId: 'c_own1', status: 'open' },
      { id: 'f3', leadId: 'l6', pipelineId: 'c_own1', status: 'open' }
    ]
  };
}
const run = f => sandbox.__cash(f.leads, f.contacts, f.companies, f.followups, f.pipelines);

// ── who goes back, and who does not ─────────────────────────────────────
{
  const f = fixture(), r = run(f);
  ok('it did something', r.changed);
  eq('three cash leads moved back', r.moved, 3);
  eq('off the panel board', r.from, 'CGHS Panel');
  eq('and onto the dental board', r.into, 'Dental Clinic Service Pipeline');

  const on = id => r.leads.find(l => l.id === id).pipelineId;
  eq('a cash patient known by contact goes back', on('l1'), 'p_dental');
  eq('one known only by UHID goes back', on('l2'), 'p_dental');
  eq('a closed one goes back too', on('l3'), 'p_dental');
  eq('a corporate employer is not a panel', on('l3'), 'p_dental');
  eq('the CGHS patient stays on the panel board', on('l4'), 'c_own1');
  eq('so does one filed only under a panel company', on('l5'), 'c_own1');
  eq('a lead already on the dental board is untouched', on('l8'), 'p_dental');

  // THE POINT. Unknown is not private.
  eq('a lead whose patient is not in the CRM is left alone', on('l6'), 'c_own1');
  eq('and so is one with neither a contact nor a UHID', on('l7'), 'c_own1');
  eq('they are counted instead', r.unknown, 2);
}

// ── each lands at the stage it was on ───────────────────────────────────
{
  const f = fixture(), r = run(f);
  const named = id => {
    const l = r.leads.find(x => x.id === id);
    const p = r.pipelines.find(x => x.id === l.pipelineId);
    return (p.stages.find(s => s.id === l.stageId) || {}).name;
  };
  eq('Consultation Scheduled stays Consultation Scheduled', named('l1'), 'Consultation Scheduled');
  eq('Treatment Planning stays Treatment Planning', named('l2'), 'Treatment Planning');
  eq('and a closed lead stays closed', named('l3'), 'Treatment Completed');
  for (const l of r.leads) {
    const pipe = r.pipelines.find(p => p.id === l.pipelineId);
    ok(l.id + ' names a stage its board actually has',
       !!pipe && pipe.stages.some(s => s.id === l.stageId), l.pipelineId + '/' + l.stageId);
  }
}

// ── the lead says why, and nothing else changes ─────────────────────────
{
  const f = fixture(), before = JSON.parse(JSON.stringify(f.leads)), r = run(f);
  const a = r.leads.find(l => l.id === 'l1');
  for (const k of ['id', 'title', 'contactId', 'uhid', 'status'])
    eq('l1 keeps its ' + k, a[k], before.find(l => l.id === 'l1')[k]);
  eq('a note was added', (a.notes || []).length, 1);
  ok('naming the board it went back to',
     /Dental Clinic Service Pipeline/.test(a.notes[0].text), a.notes[0].text);
  ok('and saying why', /not on a panel/.test(a.notes[0].text));
  eq('a lead that stayed is byte for byte unchanged',
     r.leads.find(l => l.id === 'l4'), before.find(l => l.id === 'l4'));
  eq('the original list was not mutated', f.leads[0].pipelineId, 'c_own1');
}

// ── follow-ups go with their lead ───────────────────────────────────────
{
  const f = fixture(), r = run(f);
  eq('one follow-up moved', r.followupsMoved, 1);
  eq('the moved lead’s follow-up points at the dental board',
     r.followups.find(x => x.id === 'f1').pipelineId, 'p_dental');
  eq('the CGHS lead’s follow-up stays', r.followups.find(x => x.id === 'f2').pipelineId, 'c_own1');
  eq('and so does an unknown lead’s', r.followups.find(x => x.id === 'f3').pipelineId, 'c_own1');
}

// ── once, and never again ───────────────────────────────────────────────
{
  const f = fixture(), first = run(f);
  const dental = first.pipelines.find(p => p.id === 'p_dental');
  ok('the dental board records the day it ran', !!dental.privateLeadsMovedAt, dental.privateLeadsMovedAt);
  // On the DENTAL board: it is the one that survives whatever the clinic
  // does with its panel boards.
  ok('and not on the panel board',
     !first.pipelines.find(p => p.id === 'c_own1').privateLeadsMovedAt);

  const second = sandbox.__cash(first.leads, f.contacts, f.companies, first.followups, first.pipelines);
  eq('a second open moves nothing', second.moved, 0);
  eq('and reports no change', second.changed, false);

  // A lead put on the panel board on purpose must STAY there.
  const putBack = first.leads.map(l =>
    l.id === 'l1' ? Object.assign({}, l, { pipelineId: 'c_own1', stageId: 'o2' }) : l);
  const third = sandbox.__cash(putBack, f.contacts, f.companies, first.followups, first.pipelines);
  eq('a lead moved onto the panel board by hand is left there',
     third.leads.find(l => l.id === 'l1').pipelineId, 'c_own1');
}
// Stamped even with nothing to move, so it never comes back to look again.
{
  const f = fixture();
  f.leads = [lead('l4', 'c_own1', 'o2', 'c_cghs', 'KB013')];
  f.followups = [];
  const r = run(f);
  eq('nothing moved', r.moved, 0);
  ok('but it is marked done',
     r.changed && !!r.pipelines.find(p => p.id === 'p_dental').privateLeadsMovedAt);
}

// ── the two migrations do not fight ─────────────────────────────────────
// One moves panel patients off the dental board; the other moves private
// patients off the panel board. Run back to back they must settle, not
// swap leads to and fro.
{
  const f = fixture();
  const a = sandbox.__panelMove(f.leads, f.contacts, f.companies, f.followups, f.pipelines);
  const b = sandbox.__cash(a.leads, f.contacts, f.companies, a.followups, a.pipelines);
  const board = {};
  b.leads.forEach(l => { board[l.id] = l.pipelineId; });
  eq('cash patients end on the dental board',
     ['l1', 'l2', 'l3', 'l8'].map(i => board[i]),
     ['p_dental', 'p_dental', 'p_dental', 'p_dental']);
  eq('panel patients end on the panel board',
     ['l4', 'l5'].map(i => board[i]), ['c_own1', 'c_own1']);
  // And a third pass moves nothing: they have settled.
  const c = sandbox.__panelMove(b.leads, f.contacts, f.companies, b.followups, b.pipelines);
  const d = sandbox.__cash(c.leads, f.contacts, f.companies, c.followups, c.pipelines);
  eq('a second pass of either moves nothing', [c.moved, d.moved], [0, 0]);
}

// ── it does nothing dangerous when the boards are not as expected ───────
eq('with no panel board nothing moves',
   sandbox.__cash([lead('l1', 'p_dental', 's2', 'c_cash1', 'KB010')],
                  CONTACTS, COMPANIES, [], [DENTAL]).changed, false);
eq('with no dental board nothing moves',
   sandbox.__cash([lead('l1', 'c_own1', 'o2', 'c_cash1', 'KB010')],
                  CONTACTS, COMPANIES, [], [THEIRS]).changed, false);
eq('no boards at all is not a crash', sandbox.__cash([], [], [], [], []).changed, false);
eq('and nor is nothing at all',
   sandbox.__cash(undefined, undefined, undefined, undefined, undefined).changed, false);

// ── panel / private / unknown on its own ────────────────────────────────
{
  const s = sandbox.__status(CONTACTS, COMPANIES);
  eq('a panel patient', s({ contactId: 'c_cghs' }), 'panel');
  eq('a panel company counts', s({ contactId: 'c_coonly' }), 'panel');
  eq('a cash patient', s({ contactId: 'c_cash1' }), 'private');
  eq('whitespace is not a panel', s({ contactId: 'c_cash2' }), 'private');
  eq('a corporate employer is not a panel', s({ contactId: 'c_cash3' }), 'private');
  eq('by UHID, case-insensitively', s({ contactId: '', uhid: 'kb013' }), 'panel');
  eq('an unknown contact', s({ contactId: 'nobody', uhid: 'KB999' }), 'unknown');
  eq('nothing to go on', s({}), 'unknown');
  eq('and nothing at all', s(null), 'unknown');
  // Two contacts disagreeing about one UHID is not an answer either.
  const s2 = sandbox.__status([
    { id: 'a', uhid: 'KB500', panel: 'CGHS' },
    { id: 'b', uhid: 'KB500', panel: '' }], COMPANIES);
  eq('a UHID two contacts disagree about', s2({ uhid: 'KB500' }), 'unknown');
  eq('but the contact itself is still known', s2({ contactId: 'a' }), 'panel');
}
// The older boolean lookup is built on it and must not have changed meaning.
{
  const is = sandbox.__lookup(CONTACTS, COMPANIES);
  ok('panel yes', is({ contactId: 'c_cghs' }));
  ok('cash no', !is({ contactId: 'c_cash1' }));
  ok('unknown no', !is({ contactId: 'nobody' }));
}

// ── wired into the open, after the other two ────────────────────────────
ok('the reverse move runs when the CRM loads', /var cash = moveCashLeads\(/.test(crm));
ok('after the duplicate board is folded away',
   crm.indexOf('var fold = foldGeneratedPanelBoard(') < crm.indexOf('var cash = moveCashLeads('));
ok('and after the panel patients are moved',
   crm.indexOf('var mv = movePanelLeads(') < crm.indexOf('var cash = moveCashLeads('));
ok('it is fed the lists the earlier repairs produced, not the raw ones',
   /moveCashLeads\(cur\.leads, contactsNow, companiesNow, cur\.followups, cur\.pipelines\)/.test(crm));
ok('its results are carried through', /cur\.leads = cash\.leads; dirty\.leads = true;/.test(crm));
ok('the clinic is told what went back', /lead\(s\) for patients paying their own way moved back to/.test(crm));
ok('and told how many could not be matched',
   /cash\.unknown \+ ' lead\(s\) on/.test(crm) &&
   /matched to a patient, so they were left alone/.test(crm));
ok('naming the board those are still sitting on', /cash\.from/.test(crm));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
