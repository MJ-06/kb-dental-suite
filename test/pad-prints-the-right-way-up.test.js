// "No matter how I put the paper this is what I am getting."
//
// The case paper prints onto a pre-printed letterhead pad. The margins
// reserve the banner across the top (44mm) and the doctor roster down the
// left (52mm), and those were right -- the content landed in the correct
// area of the sheet. It was the whole page that came out 180 degrees from
// the letterhead on it.
//
// Turning the sheet over does not fix that: it prints on the back. Some
// printers simply take the pad the other way round, and nothing the clinic
// does at the tray will change it. So the app turns the page instead, and
// swaps the reserved space to the other sides to match.
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

// The prescription form, out of its base64 blob.
const rx = (() => {
  const m = /const PRESCRIPTION_FORM_B64\s*=\n/.exec(html);
  const a = m.index, b = html.indexOf(';\n', a);
  return Buffer.from((html.slice(a, b).match(/"[^"]*"/g) || [])
    .map(x => x.slice(1, -1)).join(''), 'base64').toString('utf8');
})();
ok('the prescription form was decoded', rx.length > 20000, rx.length);

// ── the page builder, run both ways ──────────────────────────────────────
const FROM = rx.indexOf('  var padM = (!forPdf && PAD_FLIP)');
const TO = rx.indexOf("var t = '<style>@page{size:A4 portrait;margin:'", FROM);
ok('the margin and flip logic was found', FROM > 0 && TO > FROM, `${FROM}..${TO}`);

function build(forPdf, flip) {
  const sandbox = {
    forPdf, PAD_FLIP: flip,
    PAD_MARGINS: { top: '44mm', right: '15mm', bottom: '15mm', left: '52mm' }
  };
  vm.createContext(sandbox);
  vm.runInContext(rx.slice(FROM, TO) +
    '\n;globalThis.__m = margins; globalThis.__f = flipCss;', sandbox);
  return { margins: sandbox.__m, flipCss: sandbox.__f };
}

// ── printing on the pad, the normal way round ────────────────────────────
{
  const r = build(false, false);
  eq('the banner is cleared at the top and the roster on the left',
     r.margins, '44mm 15mm 15mm 52mm');
  eq('and nothing is turned', r.flipCss, '');
}

// ── printing on the pad, when the printer takes it the other way ─────────
{
  const r = build(false, true);
  // Upside down, the banner is where the printer thinks the bottom is and
  // the roster is on the right. 44 goes to the bottom, 52 to the right.
  eq('the reserved space swaps to the other sides',
     r.margins, '15mm 52mm 44mm 15mm');
  ok('and the page is turned to read the same way up as the letterhead',
     /rotate\(180deg\)/.test(r.flipCss), r.flipCss);
  ok('about its own centre, so it stays inside the printable area',
     /transform-origin:50% 50%/.test(r.flipCss), r.flipCss);
}

// ── the kept PDF is never touched by any of this ─────────────────────────
// It carries its own letterhead and goes nowhere near the pad.
for (const flip of [false, true]) {
  const r = build(true, flip);
  eq('the saved copy keeps its plain margins (flip=' + flip + ')', r.margins, '14mm 14mm 14mm 14mm');
  eq('and is never turned (flip=' + flip + ')', r.flipCss, '');
}

// ── the setting travels ──────────────────────────────────────────────────
ok('the form starts with the flip off', /var PAD_FLIP = false;/.test(rx));
ok('and takes it from Master', /if \(typeof d\.flip === 'boolean'\) PAD_FLIP = d\.flip;/.test(rx));
ok('Master sends it beside the margins',
   /postMessage\(\{ type: "KB_PAD_MARGINS", margins: padMargins, flip: !!\(padMargins && padMargins\.flip\) \}/.test(html));
// A clinic that ticks the box without touching a margin must still have it
// reach the form.
ok('the setting reaches the form even on default margins',
   /p\.padTop \|\| p\.padRight \|\| p\.padBottom \|\| p\.padLeft \|\| p\.padFlip/.test(html));
ok('and is read out of the saved profile',
   /flip: String\(p\.padFlip \|\| ""\) === "yes"/.test(html));

// ── it is savable, and says what it did ──────────────────────────────────
ok('Master has the tick box', /This printer takes the pad the other way round/.test(html));
ok('it explains why turning the sheet over does not work',
   /it prints on the back/.test(html));
ok('it is saved with the clinic profile', /padFlip: padFlip \? "yes" : "no"/.test(html));
ok('it survives a reload of the profile', /setPadFlip\(String\(profile\.padFlip \|\| ""\) === "yes"\)/.test(html));
ok('and the confirmation says whether the page will be turned',
   /It will be turned upside down to match the way this printer takes the pad/.test(html));

// ── the margins themselves are unchanged ─────────────────────────────────
// These were right all along and must not drift while fixing the rotation.
ok('the pad defaults still match the clinic’s own pad',
   /var PAD_MARGINS = \{ top: '44mm', right: '15mm', bottom: '15mm', left: '52mm' \};/.test(rx));
ok('the page is still A4 portrait', /@page\{size:A4 portrait;margin:/.test(rx));
ok('and the pad print still draws no letterhead of its own',
   /if\(forPdf\)\{/.test(rx));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
