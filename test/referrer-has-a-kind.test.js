// A referral is worth knowing the shape of, not just the name. "Sunita" on
// its own does not say whether she is a patient the clinic should thank, a
// doctor who refers regularly, somebody doing PR, or a member of staff — and
// which of those it was is what decides whether anything is owed for it. So
// the register keeps the kind of referrer beside the name, and hands both out
// to the CRM.
const fs = require("fs");
const path = require("path");
const GS = fs.readFileSync(path.resolve(__dirname, "../apps-script/out/Code.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const body = (sig) => {
  const i = GS.indexOf(sig);
  return i < 0 ? "" : GS.slice(i, GS.indexOf("\n}", i));
};

// ── the register has somewhere to put it ──────────────────────────────────
const save = body("function saveRegistration(p)");
ok("saveRegistration is there to check", save.length > 0);

// A column that does not exist swallows what is written to it silently, so
// the column is added rather than assumed — the same rule as the panel fields.
const ensured = (save.match(/ensureRegColumns_\(sh, \[[\s\S]*?\]\)/) || [""])[0];
ok("the Referred By Type column is made sure of, not assumed",
   ensured.indexOf('"Referred By Type"') >= 0, ensured);
ok("alongside the panel columns, in the one call",
   ["Patient Type", "Panel", "Panel Category", "Card ID"].every(n => ensured.indexOf('"' + n + '"') >= 0),
   ensured);
ok("and the value is written into it",
   /"Referred By Type": p\.referredByType \|\| ""/.test(save), save.slice(-400));
ok("a registration that does not say sends nothing, rather than guessing a kind",
   /p\.referredByType \|\| ""/.test(save));

// ── and hands both out, so the CRM need not ask again ─────────────────────
const all = body("function getAllPatients(p)");
ok("getAllPatients is there to check", all.length > 0);
ok("the referrer's name comes out of the register",
   /referredBy: refCol >= 0 \? String\(r\[refCol\]\|\|""\)\.trim\(\) : ""/.test(all.replace(/\s*\|\|\s*/g, "||")),
   all);
ok("and their kind with it",
   /referredByType: refTypeCol >= 0 \? String/.test(all), all);

// Both are looked up by header, so a book that has not got the column yet
// reports nothing rather than throwing or reading the wrong column.
ok("the name column is found by header", /findRegColumn_\(headers, \["Referred By"\]\)/.test(all));
ok("the kind column too", /findRegColumn_\(headers, \["Referred By Type"\]\)/.test(all));
ok("an older book without them reports nothing rather than failing",
   /refCol >= 0 \?/.test(all) && /refTypeCol >= 0 \?/.test(all));

// ── the two headings nest, so the lookup is run for real ──────────────────
// "Referred By" sits inside "Referred By Type". Under a plain substring match
// whichever column came first would win, and the referrer's kind would be
// read as their name. Run it, both ways round.
const find = new Function(body("function findRegColumn_(") + "\n}\nreturn findRegColumn_;")();
const H1 = ["Timestamp", "Full Name", "Referred By", "Referred By Type"];
const H2 = ["Timestamp", "Full Name", "Referred By Type", "Referred By"];
ok("the name column is found with the kind after it", find(H1, ["Referred By"]) === 2);
ok("and with the kind before it", find(H2, ["Referred By"]) === 3,
   "got " + find(H2, ["Referred By"]));
ok("the kind column is found either way round",
   find(H1, ["Referred By Type"]) === 3 && find(H2, ["Referred By Type"]) === 2);
ok("a register that has neither reports nothing",
   find(["Timestamp", "Full Name"], ["Referred By"]) === -1);
// The loose match is why "Mobile" finds "Mobile No." -- it must survive.
ok("a heading spelled longer is still found", find(["Mobile No."], ["Mobile"]) === 0);
ok("and an exact heading is preferred to a longer one that contains it",
   find(["Mobile No.", "Mobile"], ["Mobile"]) === 1);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
