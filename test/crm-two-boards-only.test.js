// The clinic's actual screen, reproduced from the screenshots:
//
//   New Pipeline                    New | In Progress | Treatment Progress
//                                   | Won | Lost          -- 7 CGHS leads, all in New
//   Dental Clinic Service Pipeline  Initial Contact | Consultation Scheduled |
//                                   Treatment Planning | Treatment Progress |
//                                   Treatment Completed | Patient Lost  -- empty
//   Panel Patients (CGHS / DGEHS)   New | In Progress | Treatment Progress
//                                   | Won | Lost          -- empty
//
// "New Pipeline" is the pre-built template's board, created by hand, which
// put it at the FRONT of the list -- so the panel board this app generated
// copied ITS columns instead of the dental board's. And the fold that was
// supposed to clear up the duplicate looked for a board with CGHS or panel
// in its NAME, which "New Pipeline" is not, so it did nothing at all.
//
// Two boards, both reading like the dental one, with the leads on the right
// one. That is the whole of it.
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
  nowISO: () => '2026-11-04T05:00:00.000Z',
  DEF_PIPELINE: { id: 'p_dental', name: 'Dental Clinic Service Pipeline', stages: [] }
};
vm.createContext(sandbox);
vm.runInContext(CODE +
  '\n;globalThis.__conform = conformPanelBoard;' +
  '\n;globalThis.__one = consolidateBoards;' +
  '\n;globalThis.__stageOn = sameStageOn;' +
  '\n;globalThis.__panelMove = movePanelLeads;' +
  '\n;globalThis.__cash = moveCashLeads;', sandbox);

// ── the clinic's three boards, exactly as the screenshots show them ──────
const TEMPLATE_STAGES = [
  { id: 't1', name: 'New', type: 'open' },
  { id: 't2', name: 'In Progress', type: 'open' },
  { id: 's_tprog', name: 'Treatment Progress', type: 'open' },
  { id: 't3', name: 'Won', type: 'close' },
  { id: 't4', name: 'Lost', type: 'close' }
];
const DENTAL_STAGES = [
  { id: 's1', name: 'Initial Contact', type: 'open' },
  { id: 's2', name: 'Consultation Scheduled', type: 'open' },
  { id: 's3', name: 'Treatment Planning', type: 'open' },
  { id: 's6', name: 'Treatment Progress', type: 'open' },
  { id: 's4', name: 'Treatment Completed', type: 'close' },
  { id: 's5', name: 'Patient Lost', type: 'close' }
];
const NEWPIPE = { id: 'c_new1', name: 'New Pipeline',
                  stages: JSON.parse(JSON.stringify(TEMPLATE_STAGES)) };
const DENTAL  = { id: 'p_dental', name: 'Dental Clinic Service Pipeline',
                  stages: JSON.parse(JSON.stringify(DENTAL_STAGES)),
                  privateLeadsMovedAt: '2026-11-01T00:00:00.000Z' };
const PANEL   = { id: 'p_panel', name: 'Panel Patients (CGHS / DGEHS)',
                  panelLeadsMovedAt: '2026-11-01T00:00:00.000Z',
                  stages: JSON.parse(JSON.stringify(TEMPLATE_STAGES))
                            .map((s, i) => ({ id: 'ps' + (i + 1), name: s.name, type: s.type })) };

// The seven on screen. The names render as "ABC CGHS", which is the CRM
// appending the panel -- so the contacts carry it.
const PATIENTS = [
  ['ct1', 'ABC', 'KB101', 'CGHS'],
  ['ct2', 'Lata Sharma', 'KB102', 'CGHS'],
  ['ct3', 'Santosh', 'KB103', 'CGHS'],
  ['ct4', 'Shankar Lal', 'KB104', 'CGHS'],
  ['ct5', 'DEF', 'KB105', 'CGHS'],
  ['ct6', 'Ram Kumar', 'KB106', 'DGEHS'],
  ['ct7', 'Anita Rao', 'KB107', '']           // one paying their own way
];
const CONTACTS = PATIENTS.map(([id, firstName, uhid, panel]) =>
  ({ id, firstName, uhid, panel, companyId: panel ? 'co_' + panel.toLowerCase() : '' }));
const COMPANIES = [
  { id: 'co_cghs', name: 'CGHS', industry: 'Panel' },
  { id: 'co_dgehs', name: 'DGEHS', industry: 'Panel' }
];

function fixture() {
  return {
    // New Pipeline FIRST, because a board made by hand goes to the front.
    pipelines: JSON.parse(JSON.stringify([NEWPIPE, DENTAL, PANEL])),
    contacts: JSON.parse(JSON.stringify(CONTACTS)),
    companies: JSON.parse(JSON.stringify(COMPANIES)),
    leads: PATIENTS.map(([id, name], i) => ({
      id: 'L' + (i + 1), title: 'Consultation — ' + name,
      pipelineId: 'c_new1', stageId: 't1', contactId: id, uhid: PATIENTS[i][2],
      status: 'open', notes: [], source: 'Patient register'
    })),
    followups: [{ id: 'F1', leadId: 'L1', pipelineId: 'c_new1', status: 'open' }]
  };
}

// ══ the whole sequence, as it runs on open ══════════════════════════════
function openTheCRM(f) {
  let P = f.pipelines, L = f.leads, FU = f.followups;
  const told = [];
  const shape = sandbox.__conform(L, P);
  if (shape.changed) { P = shape.pipelines; L = shape.leads; told.push('reshaped'); }
  const one = sandbox.__one(L, f.contacts, f.companies, FU, P);
  if (one.changed) { P = one.pipelines; L = one.leads; FU = one.followups; told.push('consolidated'); }
  const mv = sandbox.__panelMove(L, f.contacts, f.companies, FU, P);
  if (mv.changed) { P = mv.pipelines; L = mv.leads; FU = mv.followups; }
  const cash = sandbox.__cash(L, f.contacts, f.companies, FU, P);
  if (cash.changed) { P = cash.pipelines; L = cash.leads; FU = cash.followups; }
  return { pipelines: P, leads: L, followups: FU, told, shape, one, mv, cash };
}

{
  const f = fixture(), r = openTheCRM(f);

  // ── two boards, and the right two ─────────────────────────────────────
  eq('two boards are left', r.pipelines.length, 2);
  eq('and they are the two the clinic asked for',
     r.pipelines.map(p => p.name).sort(),
     ['Dental Clinic Service Pipeline', 'Panel Patients (CGHS / DGEHS)']);
  eq('"New Pipeline" is gone', r.pipelines.filter(p => p.name === 'New Pipeline').length, 0);
  eq('and it was reported as removed', r.one.removed, ['New Pipeline']);
  eq('with nothing left behind that had to be kept', r.one.kept, []);

  // ── both read like the dental board ───────────────────────────────────
  const names = p => p.stages.map(s => s.name);
  const dental = r.pipelines.find(p => p.id === 'p_dental');
  const panel = r.pipelines.find(p => p.id === 'p_panel');
  eq('the dental board is untouched', names(dental), DENTAL_STAGES.map(s => s.name));
  eq('and the panel board now reads the same', names(panel), names(dental));
  eq('with the same open and closing stages',
     panel.stages.map(s => s.type), dental.stages.map(s => s.type));
  eq('no stage id is shared between the two boards',
     panel.stages.map(s => s.id).filter(i => dental.stages.some(d => d.id === i)), []);
  ok('"New / In Progress / Won / Lost" is gone from it',
     !names(panel).some(n => ['New', 'In Progress', 'Won', 'Lost'].indexOf(n) >= 0), names(panel));

  // ── all seven leads survived, on the right board ──────────────────────
  eq('every lead is still there', r.leads.length, 7);
  const on = id => r.leads.find(l => l.id === id).pipelineId;
  for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])
    eq(id + ' (a panel patient) is on the panel board', on(id), 'p_panel');
  eq('L7 (paying their own way) is on the dental board', on('L7'), 'p_dental');
  eq('six went to the panel board', r.one.toPanel, 6);
  eq('and one to the dental board', r.one.toDental, 1);

  // No lead may name a stage its board does not have: it vanishes off the
  // Kanban and the clinic simply never sees that patient again.
  for (const l of r.leads) {
    const pipe = r.pipelines.find(p => p.id === l.pipelineId);
    ok(l.id + '’s board still exists', !!pipe, l.pipelineId);
    if (pipe) ok(l.id + ' names a stage that board has',
                 pipe.stages.some(s => s.id === l.stageId), l.pipelineId + '/' + l.stageId);
  }
  const named = id => {
    const l = r.leads.find(x => x.id === id);
    const p = r.pipelines.find(x => x.id === l.pipelineId);
    return (p.stages.find(s => s.id === l.stageId) || {}).name;
  };
  eq('a lead in "New" lands in the first column', named('L1'), 'Initial Contact');
  eq('and so does the one that went to the dental board', named('L7'), 'Initial Contact');

  eq('the follow-up went with its lead',
     r.followups.find(x => x.id === 'F1').pipelineId, 'p_panel');

  const note = r.leads.find(l => l.id === 'L1').notes;
  ok('the lead says where it came from', /New Pipeline/.test(note[0].text), note && note[0]);
  ok('and where it went', /Panel Patients/.test(note[0].text));
}

// ── opening it again changes nothing ────────────────────────────────────
{
  const f = fixture(), first = openTheCRM(f);
  const second = openTheCRM({ pipelines: first.pipelines, leads: first.leads,
                              followups: first.followups,
                              contacts: f.contacts, companies: f.companies });
  eq('a second open leaves two boards', second.pipelines.length, 2);
  eq('and moves nothing', [second.one.toPanel, second.one.toDental], [0, 0]);
  eq('and reshapes nothing', second.shape.changed, false);
  eq('every lead is still on the board it was on',
     second.leads.map(l => l.pipelineId), first.leads.map(l => l.pipelineId));
  eq('and on the same stage', second.leads.map(l => l.stageId), first.leads.map(l => l.stageId));
}

// ── a board that cannot be emptied is KEPT ──────────────────────────────
// Only a board with nothing left on it is deleted. There is no situation in
// which a lead is dropped to tidy up a list of boards.
{
  const f = fixture();
  f.pipelines = [NEWPIPE, DENTAL].map(p => JSON.parse(JSON.stringify(p)));   // no panel board
  const r = sandbox.__one(f.leads, f.contacts, f.companies, f.followups, f.pipelines);
  eq('with nowhere for panel patients to go they still move somewhere',
     r.leads.every(l => l.pipelineId === 'p_dental'), true);
  eq('and the emptied board is removed', r.removed, ['New Pipeline']);
}
{
  // A lead whose board cannot be resolved at all keeps its board alive.
  const pipes = [JSON.parse(JSON.stringify(NEWPIPE))];       // the ONLY board
  const r = sandbox.__one([{ id: 'x', pipelineId: 'c_new1', stageId: 't1', notes: [] }],
                          [], [], [], pipes);
  eq('a board that is the only board is never removed', r.removed, []);
  eq('and its lead stays on it', r.leads[0].pipelineId, 'c_new1');
}

// ── the dental and panel boards are never consolidated away ─────────────
{
  const f = fixture(), r = sandbox.__one(f.leads, f.contacts, f.companies, f.followups, f.pipelines);
  ok('the dental board survives', r.pipelines.some(p => p.id === 'p_dental'));
  ok('the panel board survives', r.pipelines.some(p => p.id === 'p_panel'));
  ok('the dental board carries the stamp',
     !!r.pipelines.find(p => p.id === 'p_dental').boardsConsolidatedAt);
  // Once. A board created tomorrow is the clinic's business, not this
  // migration's.
  const again = sandbox.__one(r.leads, f.contacts, f.companies, r.followups,
    r.pipelines.concat([{ id: 'later', name: 'Orthodontics', stages: DENTAL_STAGES }]));
  eq('a board made afterwards is left alone', again.changed, false);
  ok('and is still there', again.pipelines.some(p => p.id === 'later'));
}

// ── a closing stage lands on a closing stage ────────────────────────────
// "Won" is the first of two closing stages; it must become "Treatment
// Completed", not whatever happens to be fourth. A won lead must not
// reopen itself by changing boards.
{
  const from = { stages: TEMPLATE_STAGES };
  const to = { stages: DENTAL_STAGES };
  const nameOf = id => (DENTAL_STAGES.find(s => s.id === id) || {}).name;
  eq('New becomes the first open stage', nameOf(sandbox.__stageOn('t1', from, to)), 'Initial Contact');
  eq('In Progress becomes the second', nameOf(sandbox.__stageOn('t2', from, to)), 'Consultation Scheduled');
  eq('Treatment Progress matches by name',
     nameOf(sandbox.__stageOn('s_tprog', from, to)), 'Treatment Progress');
  eq('Won becomes Treatment Completed', nameOf(sandbox.__stageOn('t3', from, to)), 'Treatment Completed');
  eq('Lost becomes Patient Lost', nameOf(sandbox.__stageOn('t4', from, to)), 'Patient Lost');
  // And back the other way: more closing stages than the target has.
  const narrow = { stages: [{ id: 'z1', name: 'Open', type: 'open' }, { id: 'z2', name: 'Done', type: 'close' }] };
  const got = sandbox.__stageOn('s5', { stages: DENTAL_STAGES }, narrow);
  eq('a second closing stage with only one to go to still closes', got, 'z2');
}

// ── reshaping carries the leads that are already on the board ───────────
{
  const pipes = JSON.parse(JSON.stringify([NEWPIPE, DENTAL, PANEL]));
  const sitting = [
    { id: 'a', pipelineId: 'p_panel', stageId: 'ps1', notes: [] },   // New
    { id: 'b', pipelineId: 'p_panel', stageId: 'ps4', notes: [] },   // Won
    { id: 'c', pipelineId: 'p_dental', stageId: 's2', notes: [] }
  ];
  const r = sandbox.__conform(sitting, pipes);
  ok('the board was reshaped', r.changed);
  const panel = r.pipelines.find(p => p.id === 'p_panel');
  const nm = id => (panel.stages.find(s => s.id === id) || {}).name;
  eq('a lead in New moves to the first column', nm(r.leads[0].stageId), 'Initial Contact');
  eq('a won lead stays won', nm(r.leads[1].stageId), 'Treatment Completed');
  eq('a lead on another board is untouched', r.leads[2].stageId, 's2');
  eq('reshaping twice does nothing', sandbox.__conform(r.leads, r.pipelines).changed, false);
  // A board that already matches is not churned.
  const matching = JSON.parse(JSON.stringify([DENTAL,
    { id: 'p_panel', name: 'Panel Patients (CGHS / DGEHS)', stages: DENTAL_STAGES }]));
  eq('a board that already matches is left alone', sandbox.__conform([], matching).changed, false);
}
eq('no boards at all is not a crash', sandbox.__conform([], []).changed, false);
eq('and nor is nothing at all', sandbox.__one(undefined, undefined, undefined, undefined, undefined).changed, false);

// ── wired into the open, in the order it has to happen ──────────────────
ok('the reshape runs when the CRM loads', /var shape = conformPanelBoard\(/.test(crm));
ok('the consolidation too', /var one = consolidateBoards\(/.test(crm));
ok('the columns are fixed before anything is moved onto them',
   crm.indexOf('var shape = conformPanelBoard(') < crm.indexOf('var one = consolidateBoards('));
ok('and both before the panel and cash moves',
   crm.indexOf('var one = consolidateBoards(') < crm.indexOf('var mv = movePanelLeads(') &&
   crm.indexOf('var one = consolidateBoards(') < crm.indexOf('var cash = moveCashLeads('));
ok('they are fed the lists the earlier steps produced',
   /consolidateBoards\(cur\.leads, contactsNow, companiesNow, cur\.followups, cur\.pipelines\)/.test(crm));
ok('their results are carried through',
   /cur\.leads = one\.leads; dirty\.leads = true;/.test(crm) &&
   /cur\.leads = shape\.leads; dirty\.leads = true;/.test(crm));
ok('the clinic is told which board was removed', /has been removed/.test(crm) || /been removed/.test(crm));
ok('and told if one could not be emptied', /could not be \'\s*\n?\s*\+ \'emptied|could not be /.test(crm));
ok('the view moves off a board that disappears',
   /patch\.selPipeline = consultPipeline\(cur\.pipelines\)\.id;/.test(crm));
// Still one write per list for the whole open.
eq('nothing writes a list twice on one open', (crm.match(/crmSaveOne\(/g) || []).length, 3);

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
