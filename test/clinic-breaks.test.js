// "Please insert a slot for lunch break in clinic timings."
// "Please give extra for breaks as some clinics have a tea break also."
//
// So: a LIST of breaks, not a lunch field. How many a clinic takes is the
// clinic's business.
//
// The trap is not the arithmetic, it is what happens to work already in the
// book. The day grid draws its rows from the slot list and matches an
// appointment by a.time === slot, so putting a break over two o'clock would
// have taken every two o'clock appointment off the screen — not cancelled,
// not moved, just invisible. And the time dropdown is a <select> whose value
// would no longer be among its options, which in a browser means it shows
// the first one instead and saving the form moves the patient to nine in
// the morning without a word.
//
// So a break is DRAWN, shut and named, and nothing already booked vanishes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : '')); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// ── the slot logic, lifted out of the page and run ──────────────────────
const A = html.indexOf('function hhmmToMin(v) {');
const B = html.indexOf('// The slot a booking should open on.', A);
ok('the slot logic was found', A > 0 && B > A, `${A}..${B}`);
const sandbox = { String, Number, Array, JSON, isNaN, parseInt, Math,
                  TIME_SLOTS: ['09:00','09:30','10:00'] };
vm.createContext(sandbox);
vm.runInContext(html.slice(A, B) +
  '\n;globalThis.__slots = buildSlots;' +
  '\n;globalThis.__all = buildAllSlots;' +
  '\n;globalThis.__clean = cleanBreaks;' +
  '\n;globalThis.__at = breakAt;', sandbox);

const DAY = { open:'09:00', close:'13:00', slotMinutes:30 };
const LUNCH = { name:'Lunch', from:'11:00', to:'12:00' };
const TEA = { name:'Tea', from:'10:00', to:'10:30' };

// ── the day, with and without breaks ────────────────────────────────────
{
  eq('an unbroken day is every slot',
     sandbox.__slots(DAY),
     ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30']);
  const withLunch = { ...DAY, breaks:[LUNCH] };
  eq('lunch takes its slots out of the bookable list',
     sandbox.__slots(withLunch),
     ['09:00','09:30','10:00','10:30','12:00','12:30']);
  eq('but the day still HAS those hours',
     sandbox.__all(withLunch),
     ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30']);

  // Two breaks. A clinic that takes tea as well as lunch.
  const both = { ...DAY, breaks:[LUNCH, TEA] };
  eq('tea comes out as well',
     sandbox.__slots(both), ['09:00','09:30','10:30','12:00','12:30']);
  eq('and the day is unchanged in length', sandbox.__all(both).length, 8);
}
// Half-open: the slot the break ends on is working time again.
{
  const t = { ...DAY, breaks:[LUNCH] };
  ok('the slot a break starts on is break', !!sandbox.__at(t, '11:00'));
  ok('a slot inside it is break', !!sandbox.__at(t, '11:30'));
  ok('the slot it ends on is NOT', !sandbox.__at(t, '12:00'));
  ok('nor is the one before it', !sandbox.__at(t, '10:30'));
  eq('and the break knows its own name', sandbox.__at(t, '11:30').name, 'Lunch');
}

// ── a break that cannot be a break is dropped, not half-applied ─────────
{
  eq('no end', sandbox.__clean([{ name:'X', from:'11:00' }]), []);
  eq('no start', sandbox.__clean([{ name:'X', to:'11:00' }]), []);
  eq('ending before it starts', sandbox.__clean([{ from:'12:00', to:'11:00' }]), []);
  eq('zero length', sandbox.__clean([{ from:'12:00', to:'12:00' }]), []);
  eq('nonsense times', sandbox.__clean([{ from:'99:99', to:'aa:bb' }]), []);
  eq('an unnamed break is still a break',
     sandbox.__clean([{ from:'11:00', to:'12:00' }])[0].name, 'Break');
  eq('they come back in time order',
     sandbox.__clean([LUNCH, TEA]).map(b => b.name), ['Tea', 'Lunch']);
  eq('a JSON string is read', sandbox.__clean(JSON.stringify([LUNCH])).length, 1);
  for (const junk of ['', 'not json', '{"a":1}', null, undefined, 42])
    eq('junk reads as no breaks: ' + JSON.stringify(junk), sandbox.__clean(junk), []);
}
// A break swallowing the whole day would leave the clinic unable to book
// anybody with nothing on screen to explain it.
{
  const all = { ...DAY, breaks:[{ name:'All day', from:'09:00', to:'13:00' }] };
  eq('a break over the whole day is ignored rather than emptying the book',
     sandbox.__slots(all).length, 8);
}

// ── nothing already booked may disappear ────────────────────────────────
ok('the grid draws every slot, not just the bookable ones',
   /gridRows\.map\(slot => React\.createElement/.test(html));
ok('and its rows include anything already booked at an hour the day lost',
   /activeAppts\.forEach\(a => \{[\s\S]{0,180}if \(t && !seen\[t\]\) \{ seen\[t\] = 1; rows\.push\(t\); \}/.test(html));
ok('the week view draws the whole day too',
   /GRID_SLOTS\.map\(slot => React\.createElement\("div", \{ key:slot/.test(html));
ok('a break cell is shut, like a block or a closed day',
   /const blocked = isBlocked\(chair, slot\) \|\| !!closedReason\(selDate\) \|\| !!slotBreak\(slot\);/.test(html));
ok('and it says which break it is rather than reading blank',
   /slotBreak\(slot\) \? slotBreak\(slot\)\.name \+ " — " \+ slotBreak\(slot\)\.from/.test(html));
ok('the row is labelled with the break name',
   /slotBreak\(slot\) && React\.createElement\("span"/.test(html));
// The select whose value is not among its options.
ok('a time dropdown keeps the time the appointment is already on',
   (html.match(/timeOptions\(TIME_SLOTS, fTime\)/g) || []).length === 2);
ok('and marks it as the break it now falls in',
   /t \+ \(slotBreak\(t\) \? "  \(" \+ slotBreak\(t\)\.name \+ "\)" : ""\)/.test(html));
ok('nothing offers the raw slot list to a time dropdown any more',
   !/value:fTime[\s\S]{0,120}TIME_SLOTS\.map\(t => React\.createElement\("option"/.test(html));

// ── timeOptions on its own ──────────────────────────────────────────────
{
  const C = html.indexOf('function timeOptions(slots, current) {');
  const D = html.indexOf('\n}', C) + 2;
  const box = { String };
  vm.createContext(box);
  vm.runInContext(html.slice(C, D) + '\n;globalThis.__t = timeOptions;', box);
  eq('an ordinary time is left alone', box.__t(['09:00','10:00'], '09:00'), ['09:00','10:00']);
  eq('a time no longer offered is added back, in order',
     box.__t(['09:00','12:00'], '11:00'), ['09:00','11:00','12:00']);
  eq('no current time changes nothing', box.__t(['09:00'], ''), ['09:00']);
  eq('and neither does none at all', box.__t(['09:00'], undefined), ['09:00']);
}

// ── the clinic book keeps them ──────────────────────────────────────────
ok('the sheet stores the breaks', /\["Breaks", JSON\.stringify\(breaks\), now\]/.test(gs));
ok('and reads them back', /breaks: cleanBreaks_\(got\["breaks"\]\)/.test(gs));
ok('the row count was widened for it', /sh\.getRange\(1, 1, 5, 3\)\.setValues/.test(gs));
ok('a day with nothing left to book is refused',
   /those breaks leave no time to book anybody in/.test(gs));
ok('Master sends them up', /breaks: JSON\.stringify\(cleanBreaks\(next\.breaks\)\)/.test(html));
ok('and reads them down', /breaks: cleanBreaks\(ct\.breaks\)/.test(html));
ok('an older backend without them still works',
   /A backend that predates breaks simply answers without them/.test(html));

// ── the same rules on the server ────────────────────────────────────────
{
  const E = gs.indexOf('function cleanBreaks_(raw) {');
  const F = gs.indexOf('\n}', gs.indexOf('out.sort(function', E)) + 2;
  const box = { String, JSON, parseInt, Array };
  box.hhmm_ = v => {
    const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(v == null ? '' : v));
    if (!m) return '';
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return '';
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  };
  vm.createContext(box);
  vm.runInContext(gs.slice(E, F) + '\n;globalThis.__c = cleanBreaks_;', box);
  eq('the server drops a break with no end', box.__c([{ from:'11:00' }]), []);
  eq('it reads a JSON string', box.__c(JSON.stringify([LUNCH])).length, 1);
  eq('it names an unnamed one', box.__c([{ from:'11:00', to:'12:00' }])[0].name, 'Break');
  eq('and sorts them', box.__c([LUNCH, TEA]).map(b => b.name), ['Tea', 'Lunch']);
  eq('junk is no breaks', box.__c('rubbish'), []);
  // Both sides must agree, or the book and the screen show different days.
  eq('the two agree on the same input',
     box.__c([LUNCH, TEA, { from:'bad', to:'worse' }]).map(b => b.name + b.from + b.to),
     sandbox.__clean([LUNCH, TEA, { from:'bad', to:'worse' }]).map(b => b.name + b.from + b.to));
}

// ── Master's editor ─────────────────────────────────────────────────────
ok('breaks can be added', /breaks\.length \? "\+ Add another break" : "\+ Add a break"/.test(html));
ok('and removed', /onClick:\(\)=>setBreaks\(breaks\.filter\(\(_,j\)=>j!==i\)\)/.test(html));
ok('each has a name, a start and an end', /placeholder:"e\.g\. Lunch"/.test(html));
ok('a break that ends before it starts is refused',
   /needs a start and an end, and must end after it starts/.test(html));
ok('two breaks over the same minutes are caught', /overlap\./.test(html));
ok('and breaks that leave no bookable time are refused',
   /Those breaks leave no time to book anybody in/.test(html));
ok('the preview counts only what can be booked',
   /left\.length \+ " slots a day/.test(html));
ok('and strikes through the hours that are break',
   /textDecoration: onBreak \? "line-through" : "none"/.test(html));
ok('a half-typed break is not shouted about',
   /it is somebody\s*\n?\s*\/\/ still typing/.test(html));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
