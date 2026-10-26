// The Treatment Progress Notes tab's last two columns — Payment and Amount —
// were always empty, and could not be anything else.
//
// getTreatmentProgress reads the Daily Register. That sheet records the MODE
// of payment but has no amount column at all, so the backend hands back
// amountReceived as "" for every entry. The money is in the Finance receipts,
// which is why the Procedure & Fee Sheet — which reads those — showed
// payments while this tab showed dashes.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const GS = fs.readFileSync(path.join(REPO, "apps-script/out/Code.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

// ── the fault, named ─────────────────────────────────────────────────────
const gtp = GS.slice(GS.indexOf("function getTreatmentProgress(p)"),
                     GS.indexOf("\n}", GS.indexOf("function getTreatmentProgress(p)")));
ok("the register still has no amount to give",
   (gtp.match(/amountReceived:\s*"",/g) || []).length === 2, gtp.slice(-400));
ok("it is read from the Daily Register, which is why",
   /getSheet\("Daily Register"\)/.test(gtp));

// ── the rule, run ────────────────────────────────────────────────────────
const i = HTML.indexOf("function entriesWithPayments(");
const entriesWithPayments = new Function(
  HTML.slice(i, HTML.indexOf("\n}", i) + 2) + "\nreturn entriesWithPayments;")();

const E = (date, treatment) => ({ date, treatmentRendered: treatment, amountReceived: "", paymentMode: "" });
const R = (date, fee, mode) => ({ date, fee, mode });

// One visit, one payment.
let out = entriesWithPayments([E("2026-10-20", "RCT")], [R("2026-10-20", 3000, "UPI")]);
eq("the amount paid that day shows against the visit", out[0].amountReceived, 3000);
eq("and how it was paid", out[0].paymentMode, "UPI");

// Two procedures in one visit are ONE payment. Putting it on both would make
// the column add up to twice what the patient handed over.
out = entriesWithPayments([E("2026-10-20", "RCT"), E("2026-10-20", "Cleaning")],
                          [R("2026-10-20", 3000, "UPI")]);
eq("a day's payment is shown once, not against every procedure that day",
   out.map(e => e.amountReceived), [3000, ""]);
eq("so the column adds up to what was actually paid",
   out.reduce((s, e) => s + (Number(e.amountReceived) || 0), 0), 3000);

// Two payments on one day are added together.
out = entriesWithPayments([E("2026-10-20", "RCT")],
                          [R("2026-10-20", 2000, "Cash"), R("2026-10-20", 1000, "Card")]);
eq("two payments on one day are added up", out[0].amountReceived, 3000);
eq("and both modes are named", out[0].paymentMode, "Cash, Card");

// Different days stay apart.
out = entriesWithPayments([E("2026-10-20", "RCT"), E("2026-10-27", "RCT")],
                          [R("2026-10-20", 2000, "Cash"), R("2026-10-27", 1500, "UPI")]);
eq("each visit shows its own day's payment",
   out.map(e => e.amountReceived), [2000, 1500]);

// A visit with nothing paid stays blank rather than borrowing another day's.
out = entriesWithPayments([E("2026-10-21", "Check-up")], [R("2026-10-20", 2000, "Cash")]);
eq("a visit with no payment that day shows none", out[0].amountReceived, "");
ok("and does not borrow another day's", !out[0].paymentMode);

// The register's own mode wins; the receipt only fills a blank.
out = entriesWithPayments([Object.assign(E("2026-10-20", "RCT"), { paymentMode: "Cash in hand" })],
                          [R("2026-10-20", 3000, "UPI")]);
eq("what the register recorded is kept", out[0].paymentMode, "Cash in hand");
eq("while the amount is still filled in", out[0].amountReceived, 3000);

// A payment with no procedure recorded that day is not invented onto one.
out = entriesWithPayments([], [R("2026-10-20", 3000, "UPI")]);
eq("no entries means no rows", out, []);

// Timestamps and odd shapes must not break it.
out = entriesWithPayments([E("2026-10-20", "RCT")], [R("2026-10-20T10:30:00.000Z", 3000, "UPI")]);
eq("a receipt stamped with a time still matches its day", out[0].amountReceived, 3000);
eq("no receipts at all leaves the entries as they were",
   entriesWithPayments([E("2026-10-20", "RCT")], []).map(e => e.amountReceived), [""]);
eq("and neither list being there does not throw", entriesWithPayments(null, null), []);
out = entriesWithPayments([E("", "RCT")], [R("2026-10-20", 3000, "UPI")]);
eq("an entry with no date is left alone", out[0].amountReceived, "");

// The entries handed in are not altered — the register's own record stands.
const original = [E("2026-10-20", "RCT")];
entriesWithPayments(original, [R("2026-10-20", 3000, "UPI")]);
eq("the entry it was given is not changed underneath it", original[0].amountReceived, "");

// ── the tab uses it ──────────────────────────────────────────────────────
ok("the notes are built from the entries with their payments",
   /const progressRows = React\.useMemo\(\(\) => entriesWithPayments\(entries, receipts\), \[entries, receipts\]\)/.test(HTML));
ok("the total is of those rows, not the bare entries",
   /const totalAmt = progressRows\.reduce/.test(HTML));
ok("the table on screen shows them", /progressRows\.map\(\(e, i\) => \{/.test(HTML));
ok("and the printed notes too",
   (HTML.match(/buildProgressNotesHTML\(pat, progressRows\)/g) || []).length === 3);
ok("the WhatsApp PDF is one of those three",
   /const html = which === "progress" \? buildProgressNotesHTML\(pat, progressRows\)/.test(HTML));
// The Procedure Done sheet is a list of work, not of money, and is unchanged.
ok("the procedure sheet still gets the plain entries",
   /buildProcedureDoneHTML\(pat, entries\)/.test(HTML));
// Looking a patient up by UHID must load the receipts, or there is nothing
// to put in those columns.
ok("looking a patient up by UHID loads their receipts too",
   /loadEntries\(p\);\s*\n\s*\/\/ The receipts too\./.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
