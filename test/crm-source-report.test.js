// A source that brings calls and a source that brings patients look identical
// on a lead count. The report puts conversion and money beside that count:
// how many leads became a real patient, and what those patients have actually
// paid into the Finance book.
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

const m = /const CRM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
const CRM = Buffer.from((m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join(""), "base64").toString("utf8");

// ── the totalling, run for real ───────────────────────────────────────────
// Lifted from the report so the arithmetic is exercised, not read.
function report(leads, rev) {
  const rows = {};
  const bucket = name => {
    const k = String(name || "").trim() || "(no source recorded)";
    if (!rows[k]) rows[k] = { source: k, leads: 0, won: 0, lost: 0, open: 0, linked: 0, value: 0, revenue: 0, _seen: {} };
    return rows[k];
  };
  leads.forEach(l => {
    const b = bucket(l.source);
    b.leads++;
    if (l.status === "won") b.won++; else if (l.status === "lost") b.lost++; else b.open++;
    const amt = parseFloat(l.amount);
    if (isFinite(amt)) b.value += amt;
    const uh = String(l.uhid || "").trim().toUpperCase();
    if (uh && !b._seen[uh]) { b._seen[uh] = true; b.linked++; b.revenue += Number(rev[uh] || 0); }
  });
  return rows;
}

const leads = [
  { source: "Google",   status: "won",  amount: 12000, uhid: "KB1" },
  { source: "Google",   status: "won",  amount: 48000, uhid: "KB2" },
  { source: "Google",   status: "lost", amount: 1500,  uhid: "" },
  { source: "Referral", status: "won",  amount: 9000,  uhid: "KB3" },
  { source: "Referral", status: "open", amount: 5000,  uhid: "KB3" },   // same patient
  { source: "",         status: "open", amount: 0,     uhid: "" },
];
const rev = { KB1: 10000, KB2: 45000, KB3: 8000 };
const r = report(leads, rev);

eq("leads are grouped by source", Object.keys(r).sort(),
   ["(no source recorded)", "Google", "Referral"]);
eq("a lead with no source is not silently dropped", r["(no source recorded)"].leads, 1);
eq("won and lost are counted", [r.Google.won, r.Google.lost, r.Google.open], [2, 1, 0]);

// The part that is easy to get wrong: two enquiries from one person are one
// patient and one set of bills.
eq("two leads for the same patient count as one conversion", r.Referral.linked, 1);
eq("and their bills are counted once, not twice", r.Referral.revenue, 8000);
eq("so revenue per patient is not halved", r.Referral.revenue / r.Referral.linked, 8000);
eq("while two different patients count twice", r.Google.linked, 2);
eq("with both their bills", r.Google.revenue, 55000);

// What the lead was estimated at is not what the patient paid — both are
// shown, because the gap between them is the useful part.
eq("the estimate and the payment are kept apart",
   [r.Google.value, r.Google.revenue], [61500, 55000]);
eq("a patient with no receipts adds nothing rather than breaking the sum",
   report([{ source: "X", status: "won", uhid: "NOBILLS" }], rev).X.revenue, 0);
eq("a lead with no patient linked adds no revenue",
   report([{ source: "X", status: "won", uhid: "" }], rev).X.linked, 0);

// ── the backend that supplies it ──────────────────────────────────────────
const fn = GS.slice(GS.indexOf("function getRevenueByPatient("), GS.indexOf("function getReceipts("));
ok("revenue is totalled in the sheet, not shipped receipt by receipt",
   /total\[uhid\] = \(total\[uhid\] \|\| 0\) \+ fee;/.test(fn));
ok("a receipt with no patient on it is left out", /if \(!uhid\) return;/.test(fn));
ok("a fee that is not a number counts as nothing, rather than poisoning the total",
   /if \(!isFinite\(fee\)\) fee = 0;/.test(fn));
ok("it can be limited to a date range", /if \(fromDate && d && d < fromDate\) return;/.test(fn));
ok("the action is wired", /case "getRevenueByPatient":  return getRevenueByPatient\(p\);/.test(GS));
ok("and the app passes it through", /d\.type === "KB_CRM_REVENUE"/.test(HTML) &&
   /api\("getRevenueByPatient"/.test(HTML));

// ── the screen ────────────────────────────────────────────────────────────
ok("there is a Source Report to open", /upd\(\{sec:'sourcereport'\}\)/.test(CRM));
ok("and it is routed", /if\(st\.sec==='sourcereport'\) return renderSourceReport\(\);/.test(CRM));
ok("the columns say both what came in and what was paid",
   /'Source','Leads','Won','Won %','Became patients','Converted %','Lead value','Actually paid','Per patient'/.test(CRM));
ok("there is an All sources line", /source:'All sources'/.test(CRM));
ok("revenue is fetched on request, because it is the slow part",
   /function loadSourceRevenue\(\)/.test(CRM) && /Load revenue/.test(CRM));
ok("a Finance book that cannot be read says so and leaves the lead figures standing",
   /Could not read the Finance book/.test(CRM) && /lead figures below are still correct/.test(CRM));
ok("the button cannot be pressed twice while it runs", /disabled:st\.srcBusy/.test(CRM));
ok("the screen explains what 'became patients' counts",
   /counts leads carrying a UHID/.test(CRM));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
