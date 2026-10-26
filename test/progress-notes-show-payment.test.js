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
// The rows are in date order now, so the visit is found by its date rather
// than by position -- the payment's own row comes first here.
out = entriesWithPayments([E("2026-10-21", "Check-up")], [R("2026-10-20", 2000, "Cash")]);
const visit = out.find(e => e.date === "2026-10-21");
eq("a visit with no payment that day shows none", visit.amountReceived, "");
ok("and does not borrow another day's", !visit.paymentMode);
ok("while the payment itself is still accounted for",
   out.some(e => e.paymentOnly && e.amountReceived === 2000), JSON.stringify(out));

// The register's own mode wins; the receipt only fills a blank.
out = entriesWithPayments([Object.assign(E("2026-10-20", "RCT"), { paymentMode: "Cash in hand" })],
                          [R("2026-10-20", 3000, "UPI")]);
eq("what the register recorded is kept", out[0].paymentMode, "Cash in hand");
eq("while the amount is still filled in", out[0].amountReceived, 3000);

// A payment with no procedure is given a row of its own rather than dropped:
// losing it made the column total less than the patient had paid.
out = entriesWithPayments([], [R("2026-10-20", 3000, "UPI")]);
eq("a payment with no visit at all is still shown", out.length, 1);
eq("for what was paid", out[0].amountReceived, 3000);
ok("and marked as a payment rather than a procedure", out[0].paymentOnly);

// Timestamps and odd shapes must not break it.
out = entriesWithPayments([E("2026-10-20", "RCT")], [R("2026-10-20T10:30:00.000Z", 3000, "UPI")]);
eq("a receipt stamped with a time still matches its day", out[0].amountReceived, 3000);
eq("no receipts at all leaves the entries as they were",
   entriesWithPayments([E("2026-10-20", "RCT")], []).map(e => e.amountReceived), [""]);
eq("and neither list being there does not throw", entriesWithPayments(null, null), []);
out = entriesWithPayments([E("", "RCT")], [R("2026-10-20", 3000, "UPI")]);
eq("an entry with no date is given no money",
   out.find(e => e.treatmentRendered === "RCT").amountReceived, "");

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


// ── a payment on a day with no procedure ─────────────────────────────────
// The clinic hit this: ₹65,000 paid on the 15th, the implant surgery written
// up on the 16th. Matching on the date alone dropped that receipt, and the
// column totalled ₹1,05,000 against the fee sheet's ₹1,70,000.
const VISITS = [E("2026-07-14", "Consultation"), E("2026-09-16", "Implant Surgery"),
                E("2026-09-23", "Restoration")];
const PAID = [R("2026-07-14", 20000, "UPI"), R("2026-09-15", 65000, "UPI"),
              R("2026-09-23", 85000, "Card")];
out = entriesWithPayments(VISITS, PAID);
eq("every payment is somewhere, so nothing is lost",
   out.reduce((s, e) => s + (Number(e.amountReceived) || 0), 0), 170000);
eq("which is what the fee sheet totals",
   PAID.reduce((s, r) => s + r.fee, 0), 170000);
eq("the payment with no procedure gets a row of its own",
   out.filter(e => e.paymentOnly).length, 1);
const only = out.find(e => e.paymentOnly);
eq("on the day it was actually paid", only.date, "2026-09-15");
eq("for the amount paid", only.amountReceived, 65000);
ok("saying plainly why it is there",
   /no procedure recorded in the register on this day/.test(only.clinicalNotes), only.clinicalNotes);
eq("and the rows stay in date order",
   out.map(e => e.date),
   ["2026-07-14", "2026-09-15", "2026-09-16", "2026-09-23"]);
eq("the visit on the next day is not given that money",
   out.find(e => e.date === "2026-09-16").amountReceived, "");

// The service on the receipt names the row, so it is not a bare amount.
eq("the receipt's service names the row",
   entriesWithPayments([], [Object.assign(R("2026-09-15", 65000, "UPI"), { service: "Implant Surgery" })])[0].treatmentRendered,
   "Implant Surgery");

// Several unclaimed payments on one day are one row.
out = entriesWithPayments([], [R("2026-09-15", 40000, "UPI"), R("2026-09-15", 25000, "Cash")]);
eq("two payments on an unclaimed day make one row", out.length, 1);
eq("adding up", out[0].amountReceived, 65000);
eq("with both modes", out[0].paymentMode, "UPI, Cash");

// Entries that share a date keep the register's own order.
out = entriesWithPayments([E("2026-09-16", "First"), E("2026-09-16", "Second")], []);
eq("two entries on one day are not reordered",
   out.map(e => e.treatmentRendered), ["First", "Second"]);

// An entry with no date is not sorted to the front.
out = entriesWithPayments([E("", "Undated"), E("2026-09-16", "Dated")], []);
eq("an undated entry goes last rather than first",
   out.map(e => e.treatmentRendered), ["Dated", "Undated"]);

// ── the screen says so ───────────────────────────────────────────────────
ok("the count still means visits, not rows",
   /entries\.length \+ " visit"/.test(HTML));
ok("and the total says when it includes a payment with no visit",
   /payment\(s\) on days with no procedure recorded/.test(HTML));
ok("such a row is marked out on screen",
   /background: e\.paymentOnly \? "#f0fdf4"/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
