// Every Master save was fire-and-forget: it set the list on screen, sent the
// write, and never looked at the answer. A write the sheet refused, or that
// never arrived, left the new value sitting on screen under a green "Saved"
// — and the edit was simply gone at the next refresh, with nothing to say
// why. That is what "the save button isn't working" looks like from the
// chair, and there was no way to tell it from a save that worked.
const fs = require("fs");
const path = require("path");
const HTML = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

const fn = HTML.slice(HTML.indexOf("const persist = async (action, payload"),
                      HTML.indexOf("const currentTop = MASTER_STRUCTURE"));
ok("there is one checked save for the whole screen", fn.length > 0);
ok("it looks at the answer instead of ignoring it", /const r = await api\(action, payload\)/.test(fn));
ok("a success:false is a failure, not a save",
   /!r \|\| r\.success === false/.test(fn));
ok("and so is a read that never came back", /!r \|\|/.test(fn));
ok("the backend's own reason is shown when it gives one", /\(r && r\.error\)/.test(fn));
ok("a failure puts the list back as it was", /setter\(prev\)/.test(fn));
ok("it does not leave a green Saved standing over a failure", /setMsg\(""\)/.test(fn));
ok("it says plainly that nothing was changed", /Nothing was changed/.test(fn));
ok("and reports whether it worked, for callers that hold other state",
   /return true;/.test(fn) && /return false;/.test(fn));

// Every master list must go through it — one left behind is one that still
// loses edits silently.
const block = HTML.slice(HTML.indexOf("const persist = async (action, payload"),
                         HTML.indexOf("const currentTop = MASTER_STRUCTURE"));
const savers = block.match(/const (save\w+) = /g) || [];
eq("every master save on the screen is accounted for", savers.length >= 19, true);
const unchecked = (block.match(/const save\w+ = async \(arr\) => \{[^\n]*await api\(/g) || []);
eq("none of them still fires and forgets", unchecked, []);
const viaPersist = (block.match(/=> persist\(/g) || []).length;
ok("they all route through the checked save", viaPersist >= 18, String(viaPersist));

// The clinic profile also writes window.CLINIC, which the forms and the
// printed header read directly — a rollback that left it set would put a
// different clinic name on paper than the master shows.
const prof = HTML.slice(HTML.indexOf("const saveClinicProfile"),
                        HTML.indexOf("const currentTop = MASTER_STRUCTURE"));
ok("the clinic profile goes through it too", /await persist\("saveClinicProfile"/.test(prof));
ok("and window.CLINIC is put back when the save failed",
   /if \(!saved\) window\.CLINIC = prevWindow;/.test(prof));

// The message has to be on screen, or the rollback is just as silent.
ok("the failure is rendered, not only stored",
   /errMsg && React\.createElement/.test(HTML));
ok("in red, so it cannot be mistaken for the Saved line",
   /errMsg && React\.createElement\([\s\S]{0,200}#b91c1c/.test(HTML));
ok("errMsg is state on the Master screen",
   /const \[errMsg, setErrMsg\] = React\.useState\(""\);/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
