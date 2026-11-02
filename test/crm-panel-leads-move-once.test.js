// "Yes, move the existing CGHS patients to the panel board."
//
// Splitting the boards only decided where NEW leads land. The leads opened
// before the split -- every panel patient the clinic has already seen -- were
// still sitting on the regular board, which is exactly the mixing the split
// was meant to end.
//
// So they are moved across. Once, and never again: a lead moved back by
// hand is a decision, not a mistake to correct. A panel patient paying cash
// for something the panel does not cover belongs on the regular board, and
// a migration that ran on every load would drag them over every morning.
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
ok('the CRM was decoded', crm.length > 200000, crm.length);

// ── lift the move out and run it ─────────────────────────────────────────
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
  nowISO: () => '2026-11-02T04:00:00.000Z',
  DEF_PIPELINE: { id: 'p_dental', stages: [] }
};
vm.createContext(sandbox);
vm.runInContext(CODE +
  '\n;globalThis.__move = movePanelLeads;' +
  '\n;globalThis.__upgrade = upgradePipelines;' +
  '\n;globalThis.__lookup = panelLookup;' +
  '\n;globalThis.__stageOn = sameStageOn;' +
  '\n;globalThis.__isPanel = isPanelBoard;', sandbox);

// ── the clinic as it stands: one board, panel and private leads mixed ────
const REGULAR = {
  id: 'p_dental', name: 'Dental Clinic Service Pipeline',
  stages: [
    { id: 's1', name: 'Initial Contact', type: 'open' },
    { id: 's2', name: 'Consultation Scheduled', type: 'open' },
    { id: 's3', name: 'Treatment Planning', type: 'open' },
    { id: 's_tprog', name: 'Treatment Progress', type: 'open' },
    { id: 's4', name: 'Treatment Completed', type: 'close' },
    { id: 's5', name: 'Patient Lost', type: 'close' }
  ]
};
const CONTACTS = [
  { id: 'c_cghs', firstName: 'Deepa', uhid: 'KB001', panel: 'CGHS', companyId: 'co_cghs' },
  { id: 'c_dgehs', firstName: 'Ram', uhid: 'KB002', panel: 'DGEHS', companyId: 'co_dgehs' },
  { id: 'c_cash', firstName: 'Anita', uhid: 'KB003', panel: '', companyId: '' },
  { id: 'c_blank', firstName: 'Vikas', uhid: 'KB004', panel: '   ', companyId: '' },
  // Panel text cleared by hand, still filed under the panel company.
  { id: 'c_coonly', firstName: 'Suresh', uhid: 'KB005', panel: '', companyId: 'co_cghs' },
  // No contact row at all for KB006 -- the lead carries only a UHID.
];
const COMPANIES = [
  { id: 'co_cghs', name: 'CGHS', industry: 'Panel' },
  { id: 'co_dgehs', name: 'DGEHS', industry: 'panel' },   // case differs on purpose
  { id: 'co_corp', name: 'Some Employer', industry: 'Corporate' }
];
const lead = (id, contactId, uhid, stageId, extra) => Object.assign({
  id, title: 'Consultation — ' + id, pipelineId: 'p_dental', stageId,
  contactId, uhid, status: 'open', notes: []
}, extra || {});

function fixture() {
  const pipelines = sandbox.__upgrade([JSON.parse(JSON.stringify(REGULAR))]).pipelines;
  return {
    pipelines,
    leads: [
      lead('l1', 'c_cghs', 'KB001', 's2'),
      lead('l2', 'c_dgehs', 'KB002', 's3'),
      lead('l3', 'c_cash', 'KB003', 's2'),
      lead('l4', 'c_blank', 'KB004', 's1'),
      lead('l5', 'c_coonly', 'KB005', 's_tprog'),
      lead('l6', '', 'KB001', 's4'),              // same panel patient, closed, no contactId
      lead('l7', 'c_cghs', 'KB001', 's1', { pipelineId: 'p_other' })  // another board
    ],
    contacts: JSON.parse(JSON.stringify(CONTACTS)),
    companies: JSON.parse(JSON.stringify(COMPANIES)),
    followups: [
      { id: 'f1', leadId: 'l1', pipelineId: 'p_dental', fuType: 'Call', status: 'open' },
      { id: 'f2', leadId: 'l3', pipelineId: 'p_dental', fuType: 'Call', status: 'open' },
      { id: 'f3', leadId: 'l9', pipelineId: 'p_dental', fuType: 'Call', status: 'open' }
    ]
  };
}
const run = f => sandbox.__move(f.leads, f.contacts, f.companies, f.followups, f.pipelines);

// ── who moves, and who does not ──────────────────────────────────────────
{
  const f = fixture(), r = run(f);
  ok('something was changed', r.changed);
  eq('four panel leads moved', r.moved, 4);
  const board = id => r.leads.find(l => l.id === id).pipelineId;
  eq('the CGHS patient’s lead is on the panel board', board('l1'), 'p_panel');
  eq('so is the DGEHS one', board('l2'), 'p_panel');
  eq('so is the one known only by their panel company', board('l5'), 'p_panel');
  eq('and so is the closed lead matched by UHID alone', board('l6'), 'p_panel');
  eq('the cash patient stays where they are', board('l3'), 'p_dental');
  eq('whitespace is not a panel', board('l4'), 'p_dental');
  eq('a lead on some other board is not touched', board('l7'), 'p_other');
  eq('and keeps the stage it had there',
     r.leads.find(l => l.id === 'l7').stageId, 's1');
}

// ── each lands at the stage it was already on ────────────────────────────
{
  const f = fixture(), r = run(f);
  const panel = r.pipelines.find(p => p.id === 'p_panel');
  const nameOf = (pipe, id) => (pipe.stages.find(s => s.id === id) || {}).name;
  const landed = id => nameOf(panel, r.leads.find(l => l.id === id).stageId);
  eq('Consultation Scheduled stays Consultation Scheduled', landed('l1'), 'Consultation Scheduled');
  eq('Treatment Planning stays Treatment Planning', landed('l2'), 'Treatment Planning');
  eq('Treatment Progress stays Treatment Progress', landed('l5'), 'Treatment Progress');
  eq('and a closed lead stays closed', landed('l6'), 'Treatment Completed');
  // A stage id the board it is on does not have means the lead vanishes
  // off the kanban entirely.
  for (const l of r.leads) {
    const pipe = r.pipelines.find(p => p.id === l.pipelineId);
    if (!pipe) continue;
    ok(l.id + ' names a stage its board actually has',
       pipe.stages.some(s => s.id === l.stageId), l.pipelineId + '/' + l.stageId);
  }
}

// ── nothing else about the lead is disturbed ─────────────────────────────
{
  const f = fixture(), before = JSON.parse(JSON.stringify(f.leads)), r = run(f);
  const b = before.find(l => l.id === 'l1'), a = r.leads.find(l => l.id === 'l1');
  for (const k of ['id', 'title', 'contactId', 'uhid', 'status']) eq('l1 keeps its ' + k, a[k], b[k]);
  eq('the original list was not mutated',
     f.leads.find(l => l.id === 'l1').pipelineId, 'p_dental');
  eq('a note says why it changed board', (a.notes || []).length, 1);
  ok('naming the board it went to', /Panel Patients/.test(a.notes[0].text), a.notes[0].text);
  ok('and saying it can be moved back', /paying for this treatment themselves/.test(a.notes[0].text));
  eq('the cash patient’s lead is untouched',
     r.leads.find(l => l.id === 'l3'), before.find(l => l.id === 'l3'));
}

// ── follow-ups go with their lead ────────────────────────────────────────
{
  const f = fixture(), r = run(f);
  eq('one follow-up moved', r.followupsMoved, 1);
  eq('the moved lead’s follow-up points at the panel board',
     r.followups.find(x => x.id === 'f1').pipelineId, 'p_panel');
  eq('a follow-up for a lead that stayed is left alone',
     r.followups.find(x => x.id === 'f2').pipelineId, 'p_dental');
  eq('and one whose lead does not exist is left alone',
     r.followups.find(x => x.id === 'f3').pipelineId, 'p_dental');
}

// ── once, and never again ────────────────────────────────────────────────
{
  const f = fixture(), first = run(f);
  const panel = first.pipelines.find(p => p.id === 'p_panel');
  ok('the panel board records the day it ran', !!panel.panelLeadsMovedAt, panel.panelLeadsMovedAt);

  const second = sandbox.__move(first.leads, f.contacts, f.companies, first.followups, first.pipelines);
  eq('a second open moves nothing', second.moved, 0);
  eq('and reports no change at all', second.changed, false);

  // The real point: a lead dragged back by hand must STAY back.
  const putBack = first.leads.map(l =>
    l.id === 'l1' ? Object.assign({}, l, { pipelineId: 'p_dental', stageId: 's2' }) : l);
  const third = sandbox.__move(putBack, f.contacts, f.companies, first.followups, first.pipelines);
  eq('a lead moved back by hand is left where the clinic put it',
     third.leads.find(l => l.id === 'l1').pipelineId, 'p_dental');
  eq('nothing was moved on that open either', third.moved, 0);
}

// ── stamped even when there was nothing to move ──────────────────────────
// Otherwise it comes back and looks again every morning, which is the one
// thing that could undo a decision somebody made in between.
{
  const f = fixture();
  f.leads = [lead('l3', 'c_cash', 'KB003', 's2')];
  const r = run(f);
  eq('nothing moved', r.moved, 0);
  ok('but it is still marked done', r.changed &&
     !!r.pipelines.find(p => p.id === 'p_panel').panelLeadsMovedAt);
}

// ── it does nothing dangerous when the boards are not as expected ────────
{
  const only = [JSON.parse(JSON.stringify(REGULAR))];     // no panel board
  const r = sandbox.__move([lead('l1', 'c_cghs', 'KB001', 's2')], CONTACTS, COMPANIES, [], only);
  eq('with no panel board nothing moves', r.moved, 0);
  eq('and nothing is marked', r.changed, false);
}
{
  // The panel board is the only board. There is nowhere to move from.
  const panelOnly = [{ id: 'p_panel', name: 'Panel Patients (CGHS / DGEHS)', stages: [{ id: 'ps1', name: 'Initial Contact', type: 'open' }] }];
  const r = sandbox.__move([lead('l1', 'c_cghs', 'KB001', 'ps1', { pipelineId: 'p_panel' })],
                           CONTACTS, COMPANIES, [], panelOnly);
  eq('nothing moves onto itself', r.moved, 0);
  eq('and nothing is marked', r.changed, false);
}
eq('no pipelines at all is not a crash', sandbox.__move([], [], [], [], []).changed, false);
eq('no leads at all is not a crash',
   sandbox.__move(undefined, undefined, undefined, undefined,
                  sandbox.__upgrade([JSON.parse(JSON.stringify(REGULAR))]).pipelines).moved, 0);

// ── the stage mapping on its own ─────────────────────────────────────────
{
  const from = { stages: [{ id: 'a', name: 'One', type: 'open' }, { id: 'b', name: 'Two', type: 'open' }] };
  const to = { stages: [{ id: 'x', name: 'two', type: 'open' }, { id: 'y', name: 'One', type: 'open' }] };
  eq('matched by name, not position', sandbox.__stageOn('b', from, to), 'x');
  eq('case and spacing do not matter', sandbox.__stageOn('a', from, to), 'y');
  const renamed = { stages: [{ id: 'x', name: 'Totally Different', type: 'open' }, { id: 'y', name: 'Other', type: 'open' }] };
  eq('a renamed stage falls back to the same position', sandbox.__stageOn('b', from, renamed), 'y');
  const short = { stages: [{ id: 'z', name: 'Only One', type: 'open' }] };
  eq('a shorter board falls back to the first open stage', sandbox.__stageOn('b', from, short), 'z');
  eq('an unknown stage still lands somewhere', sandbox.__stageOn('nope', from, short), 'z');
  eq('and a board with no stages gives nothing rather than throwing',
     sandbox.__stageOn('a', from, { stages: [] }), '');
}

// ── who counts as a panel patient ────────────────────────────────────────
{
  const is = sandbox.__lookup(CONTACTS, COMPANIES);
  ok('by contact id', is({ contactId: 'c_cghs' }));
  ok('by UHID when the lead has no contact', is({ contactId: '', uhid: 'kb002' }));
  ok('by panel company alone', is({ contactId: 'c_coonly' }));
  ok('a cash patient is not one', !is({ contactId: 'c_cash' }));
  ok('a corporate employer is not a panel', !is({ contactId: 'c_corp_person' }));
  ok('an unknown contact is not one', !is({ contactId: 'nobody', uhid: 'KB999' }));
  ok('and neither is nothing at all', !is(null) && !is({}));
}

// ── it is wired into the open, once, with the board saved too ────────────
ok('the move runs when the CRM loads', /var mv = movePanelLeads\(/.test(crm));
ok('after the boards are brought up to date',
   crm.indexOf('upgradePipelines(patch.pipelines)') < crm.indexOf('var mv = movePanelLeads('));
// What it changed is taken into the lists being carried through the open,
// and written once at the end -- see the single-write check below.
ok('the marked board is carried through',
   /cur\.pipelines = mv\.pipelines; dirty\.pipelines = true;/.test(crm));
ok('and so are the moved leads', /cur\.leads = mv\.leads; dirty\.leads = true;/.test(crm));
ok('and the moved follow-ups', /cur\.followups = mv\.followups; dirty\.followups = true;/.test(crm));
ok('each changed list is cached here and sent up, in one place',
   /patch\[k\] = rows; lsSet\(CK\[k\], rows\); crmSaveOne\(k, rows\);/.test(crm));
// saveCrmCollection rewrites a whole tab, so writing one list twice on a
// single open is a race: the slower, earlier, less complete write landing
// last would throw away a repair while its marker said it was done.
// Three mentions and no more: the definition, the loop, and persist().
eq('nothing writes a list twice on one open',
   (crm.match(/crmSaveOne\(/g) || []).length, 3);
// The marker must live in the book, not just here, or the next computer to
// open the CRM would do it all again.
ok('the marker travels with the pipeline record',
   /var mark = \{\}; mark\[PANEL_MOVED_FIELD\] = when;/.test(crm));

// ── and it says so, until somebody closes it ─────────────────────────────
// Appended, not assigned: the duplicate-board fold writes to the same bar
// on the same open, and whichever ran first must not be wiped.
ok('a bulk change to live leads is announced',
   /told\.push\(mv\.moved \+ ' lead\(s\) for panel patients moved to/.test(crm));
// The board it ACTUALLY went to. This used to print PANEL_PIPELINE_NAME,
// which after the duplicate boards were folded together named a board that
// no longer exists.
ok('naming the board they went to, not a hardcoded one',
   /moved to \u201c' \+ mv\.into/.test(crm) &&
   !/PANEL_PIPELINE_NAME \+ '\u201d, each at the stage/.test(crm));
ok('the notice can be dismissed', /onClick:function\(\)\{ upd\(\{moveMsg:''\}\); \}/.test(crm));
ok('and it is not a toast that disappears on its own',
   /var moveEl = st\.moveMsg/.test(crm) && /moveEl,/.test(crm));

// ── the board test asks one place what the panel board is ────────────────
ok('there is one function that says what the panel board is',
   /function isPanelBoard\(p\)\s*\{/.test(crm));
ok('pipelineFor asks it', /var panelPipe = panelBoard\(all\);/.test(crm));
ok('addPanelPipeline asks it', /if\(list\.some\(isPanelBoard\)\) return \{ pipelines:list, changed:false \};/.test(crm));
ok('and the old duplicated test is gone',
   (crm.match(/p\.id === PANEL_PIPELINE_ID \|\| sameName\(p\.name, PANEL_PIPELINE_NAME\)/g) || []).length === 1);
ok('by name as well as by id, so a hand-built board is recognised',
   sandbox.__isPanel({ id: 'whatever', name: 'panel patients (cghs / dgehs)' }) &&
   sandbox.__isPanel({ id: 'p_panel', name: 'Renamed By Hand' }) &&
   !sandbox.__isPanel({ id: 'p_dental', name: 'Dental Clinic Service Pipeline' }) &&
   !sandbox.__isPanel(null));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
