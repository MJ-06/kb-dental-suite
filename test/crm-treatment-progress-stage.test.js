// "In CRM under leads I need a new addition after treatment planning: it
// should be Treatment Progress."
//
// The trap here is that the pipeline in DEF_PIPELINE is only ever used to
// seed a CRM that has never run. This clinic's pipeline has been saved for
// a long time, in this browser and in the PMS book, so adding a stage to
// the default alone would have changed precisely nothing on screen.
//
// So an existing pipeline is brought up to date too -- once, in place, and
// without touching a lead. Leads name their stage by id and no id changes.
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

// ── the migration, lifted out and run ────────────────────────────────────
// From the constants, because sameName lives with them now -- it is used
// by the panel-pipeline routing as well as by this migration.
const FROM = crm.indexOf("  var PANEL_PIPELINE_ID = 'p_panel';");
const TO = crm.indexOf('  function initPipelines(){', FROM);
ok('the migration was found', FROM > 0 && TO > FROM, `${FROM}..${TO}`);

const sandbox = { Object, String, Array, JSON };
vm.createContext(sandbox);
vm.runInContext(crm.slice(FROM, TO) + '\n;globalThis.__add = addTreatmentProgress;', sandbox);
const add = sandbox.__add;
const names = p => p.stages.map(s => s.name);

// The clinic's pipeline as it stands today.
const LIVE = [{
  id: 'p_dental', name: 'Dental Clinic Service Pipeline',
  stages: [
    { id: 's1', name: 'Initial Contact', type: 'open' },
    { id: 's2', name: 'Consultation Scheduled', type: 'open' },
    { id: 's3', name: 'Treatment Planning', type: 'open' },
    { id: 's4', name: 'Treatment Completed', type: 'close' },
    { id: 's5', name: 'Patient Lost', type: 'close' }
  ]
}];

// ── it goes in the right place ───────────────────────────────────────────
{
  const r = add(JSON.parse(JSON.stringify(LIVE)));
  ok('the pipeline was changed', r.changed);
  eq('Treatment Progress sits straight after Treatment Planning',
     names(r.pipelines[0]),
     ['Initial Contact', 'Consultation Scheduled', 'Treatment Planning',
      'Treatment Progress', 'Treatment Completed', 'Patient Lost']);
  const added = r.pipelines[0].stages[3];
  eq('it is an open stage, not a closing one', added.type, 'open');
  ok('and its id collides with nothing', !LIVE[0].stages.some(s => s.id === added.id), added.id);
  // Leads point at a stage by id. If any existing id moved, every lead in
  // that stage would be orphaned.
  for (const s of LIVE[0].stages) {
    const now = r.pipelines[0].stages.find(x => x.name === s.name);
    eq('the id of ' + s.name + ' is untouched', now.id, s.id);
  }
}

// ── running it again changes nothing ─────────────────────────────────────
{
  const once = add(JSON.parse(JSON.stringify(LIVE)));
  const twice = add(once.pipelines);
  eq('a second run reports no change', twice.changed, false);
  eq('and adds no second copy', names(twice.pipelines[0]).filter(n => n === 'Treatment Progress').length, 1);
  const thrice = add(twice.pipelines);
  eq('nor does a third', names(thrice.pipelines[0]).length, 6);
}

// Somebody who already added it by hand must not get a duplicate, whatever
// case or spacing they typed.
for (const typed of ['Treatment Progress', 'treatment progress', '  Treatment  Progress  '.replace(/\s+/g, ' ').trim()]) {
  const theirs = [{ id: 'p', stages: [
    { id: 'a', name: 'Treatment Planning', type: 'open' },
    { id: 'b', name: typed, type: 'open' },
    { id: 'c', name: 'Treatment Completed', type: 'close' }] }];
  const r = add(theirs);
  eq('"' + typed + '" is recognised as already there', r.changed, false);
}

// ── a pipeline that does not look like the default ───────────────────────
{
  // Planning renamed. It still belongs after the open stages and before
  // the first closing one.
  const renamed = [{ id: 'p', stages: [
    { id: 'a', name: 'Enquiry', type: 'open' },
    { id: 'b', name: 'Plan Given', type: 'open' },
    { id: 'c', name: 'Done', type: 'close' },
    { id: 'd', name: 'Lost', type: 'close' }] }];
  const r = add(renamed);
  eq('it lands before the first closing stage',
     names(r.pipelines[0]), ['Enquiry', 'Plan Given', 'Treatment Progress', 'Done', 'Lost']);
}
{
  const allOpen = [{ id: 'p', stages: [
    { id: 'a', name: 'One', type: 'open' }, { id: 'b', name: 'Two', type: 'open' }] }];
  eq('with no closing stage it goes on the end',
     names(add(allOpen).pipelines[0]), ['One', 'Two', 'Treatment Progress']);
}
{
  const r = add([{ id: 'p', stages: [] }]);
  eq('an empty pipeline gets it', names(r.pipelines[0]), ['Treatment Progress']);
}
{
  // An id clash is stepped over rather than producing two stages with one id.
  const clash = [{ id: 'p', stages: [
    { id: 's_tprog', name: 'Something Else', type: 'open' },
    { id: 'z', name: 'Treatment Planning', type: 'open' }] }];
  const r = add(clash);
  const added = r.pipelines[0].stages.find(s => s.name === 'Treatment Progress');
  ok('a clashing id is avoided', added.id !== 's_tprog', added.id);
  eq('and every id is still unique',
     new Set(r.pipelines[0].stages.map(s => s.id)).size, r.pipelines[0].stages.length);
}

// Several pipelines: each is handled on its own.
{
  const two = [
    { id: 'p1', stages: [{ id: 'a', name: 'Treatment Planning', type: 'open' }] },
    { id: 'p2', stages: [{ id: 'b', name: 'Treatment Progress', type: 'open' }] }
  ];
  const r = add(two);
  eq('the one without it gets it', names(r.pipelines[0]), ['Treatment Planning', 'Treatment Progress']);
  eq('the one with it is left alone', names(r.pipelines[1]), ['Treatment Progress']);
}
// Nothing at all must not throw.
eq('no pipelines is not a crash', add([]).changed, false);
eq('undefined is not a crash', add(undefined).changed, false);

// ── it is applied where it matters ───────────────────────────────────────
ok('a brand new CRM gets the stage in its default pipeline',
   /\{id:'s3',name:'Treatment Planning',type:'open'\},\s*\n\s*\{id:'s6',name:'Treatment Progress',type:'open'\},/.test(crm));
ok('a pipeline already saved on this computer is brought up to date',
   /var up = upgradePipelines\(saved\);/.test(crm));
// The book's copy is what every other machine reads. Without this, the
// stage would show here and vanish on the next sync.
ok('and so is the clinic book’s copy', /upgradePipelines\(cur\.pipelines\)/.test(crm));
ok('which is sent straight back up',
   /cur\.pipelines = up\.pipelines; dirty\.pipelines = true;/.test(crm) &&
   /patch\[k\] = rows; lsSet\(CK\[k\], rows\); crmSaveOne\(k, rows\);/.test(crm));
ok('and cached locally too', /lsSet\(CK\.pipelines, up\.pipelines\)/.test(crm));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
