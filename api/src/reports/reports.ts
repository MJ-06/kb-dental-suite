// The admin reports: each is a query that returns columns and rows, and the
// same result feeds the screen, the JSON API and the Excel export.
//
// Every query runs in the signed-in admin's transaction, so row level
// security keeps it to their own clinic. Dates are the clinic's own days and
// the financial year runs April to March, as everywhere else in the app.
import { sql, type RawBuilder } from "kysely";
import type { Tx } from "../db/index.js";
import { ESTIMATE_TOTAL } from "../legacy/finance.js";
import type { Column } from "./xlsx.js";

export const ROW_CAP = 20_000;

export interface Period { label: string; from: string | null; to: string | null }
export interface ReportResult {
  columns: Column[];
  rows: Record<string, unknown>[];
  /** Column keys worth adding up, and the sums. */
  totals?: Record<string, number>;
  truncated?: boolean;
}
interface Ctx { tx: Tx; tz: string; period: Period }
export interface ReportDef {
  id: string;
  title: string;
  group: "Money" | "Patients" | "Diary";
  about: string;
  /** Ignores the period filter (shows every year side by side). */
  allYears?: boolean;
  run: (c: Ctx) => Promise<ReportResult>;
}

// ── periods ────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const FY = /^(\d{4})-(\d{2})$/;
export const fyLabel = (start: number) => `${start}-${String(start + 1).slice(2)}`;

function validDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export class BadPeriod extends Error {}

/**
 * `fy=2025-26`, `fy=all`, or `from`/`to` (either may be left out).
 * Nothing given means the clinic's current financial year.
 */
export function resolvePeriod(q: { fy?: string; from?: string; to?: string }, today: string): Period {
  if (q.from || q.to) {
    for (const d of [q.from, q.to]) if (d && !validDay(d)) throw new BadPeriod(`"${d}" is not a date (use YYYY-MM-DD)`);
    if (q.from && q.to && q.from > q.to) throw new BadPeriod("The start date is after the end date");
    return { label: `${q.from ?? "start"} to ${q.to ?? "today"}`, from: q.from || null, to: q.to || null };
  }
  if (q.fy === "all") return { label: "All years", from: null, to: null };
  let start: number;
  if (q.fy) {
    const m = FY.exec(q.fy);
    if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2]) || Number(m[1]) < 2000 || Number(m[1]) > 2100) {
      throw new BadPeriod(`"${q.fy}" is not a financial year (use for example 2025-26)`);
    }
    start = Number(m[1]);
  } else {
    start = Number(today.slice(5, 7)) >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  }
  return { label: `FY ${fyLabel(start)}`, from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/** Start year of the financial year a date column falls in. */
const fyOf = (col: string) =>
  sql.raw(`(CASE WHEN extract(month FROM ${col}) >= 4 THEN extract(year FROM ${col}) ELSE extract(year FROM ${col}) - 1 END)::int`);

/** `col BETWEEN from AND to`, with either end optional. */
const within = (col: string | RawBuilder<unknown>, p: Period) => {
  const c = typeof col === "string" ? sql.raw(col) : col;
  return sql`(${p.from}::date IS NULL OR ${c} >= ${p.from}::date) AND (${p.to}::date IS NULL OR ${c} <= ${p.to}::date)`;
};

/** The clinic's own day for a timestamptz column (a fixed column name, never user input). */
const localDay = (col: string, tz: string) => sql`((${sql.raw(col)}) AT TIME ZONE ${tz})::date`;

/** The day a patient registered, in the clinic's own day. */
const registeredDay = (tz: string, alias = "") => sql`((${sql.raw(alias + "registered_on")}) AT TIME ZONE ${tz})::date`;

/**
 * What a receipt was for, as the coarse group set at import or at the desk.
 * A receipt with a service but no group is "Other"; one with neither is shown
 * on its own row so the gap stays visible.
 */
const SERVICE_GROUP = sql`(CASE
  WHEN nullif(trim(service_group), '') IS NOT NULL THEN trim(service_group)
  WHEN nullif(trim(service), '') IS NULL THEN 'No service stated'
  ELSE 'Other' END)`;

/** Edit distance where swapping two neighbouring letters counts as one slip. */
function slip(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

const sum = (rows: Record<string, unknown>[], key: string) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const cap = <T>(rows: T[]) => ({ rows: rows.slice(0, ROW_CAP), truncated: rows.length > ROW_CAP });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** One row per (date, mode, amount): a receipt split across two modes counts each part under its own mode. */
const MODE_PARTS = sql`(
  SELECT receipt_date, coalesce(nullif(trim(mode1), ''), 'Unknown') AS mode, amount1 AS amt FROM receipts WHERE amount1 > 0
  UNION ALL
  SELECT receipt_date, coalesce(nullif(trim(mode2), ''), 'Unknown') AS mode, amount2 AS amt FROM receipts WHERE amount2 > 0
) parts`;

// ── the reports ────────────────────────────────────────────────────────────

export const REPORTS: ReportDef[] = [
  {
    id: "collections-by-fy", title: "Collections by financial year", group: "Money", allYears: true,
    about: "Money received each financial year, split by how it was paid.",
    async run({ tx }) {
      const byMode = await sql<{ fy: number; mode: string; v: number }>`
        SELECT ${fyOf("receipt_date")} AS fy, mode, sum(amt)::float8 AS v FROM ${MODE_PARTS} GROUP BY 1, 2`.execute(tx);
      const counts = await sql<{ fy: number; n: number }>`
        SELECT ${fyOf("receipt_date")} AS fy, count(*)::int AS n FROM receipts GROUP BY 1`.execute(tx);
      const modes = [...new Set(byMode.rows.map((r) => r.mode))].sort((a, b) => (a === "Unknown" ? 1 : b === "Unknown" ? -1 : a.localeCompare(b)));
      const years = [...new Set([...byMode.rows.map((r) => r.fy), ...counts.rows.map((r) => r.fy)])].sort((a, b) => b - a);
      const rows = years.map((fy) => {
        const row: Record<string, unknown> = { fy: `FY ${fyLabel(fy)}`, receipts: counts.rows.find((c) => c.fy === fy)?.n ?? 0, total: 0 };
        for (const m of modes) {
          const v = byMode.rows.find((r) => r.fy === fy && r.mode === m)?.v ?? 0;
          row[`mode:${m}`] = v; row.total = (row.total as number) + v;
        }
        return row;
      });
      const columns: Column[] = [
        { key: "fy", label: "Financial year", type: "text" }, { key: "receipts", label: "Receipts", type: "int" },
        ...modes.map((m): Column => ({ key: `mode:${m}`, label: m, type: "money" })),
        { key: "total", label: "Total received", type: "money" }
      ];
      return { columns, rows, totals: { receipts: sum(rows, "receipts"), total: sum(rows, "total") } };
    }
  },
  {
    id: "profit-loss", title: "Collections, expenses and net by month", group: "Money",
    about: "What came in, what went out and what was left each month. Personal expenses are shown separately so you can see the net with and without them.",
    async run({ tx, period }) {
      const inc = await sql<{ ym: string; n: number; v: number }>`
        SELECT to_char(receipt_date, 'YYYY-MM') AS ym, count(*)::int AS n, sum(amount1 + amount2)::float8 AS v
          FROM receipts WHERE ${within("receipt_date", period)} GROUP BY 1`.execute(tx);
      const exp = await sql<{ ym: string; v: number; personal: number }>`
        SELECT to_char(expense_date, 'YYYY-MM') AS ym, sum(amount)::float8 AS v,
               sum(amount) FILTER (WHERE lower(coalesce(category, '')) = 'personal')::float8 AS personal
          FROM expenses WHERE voided_at IS NULL AND ${within("expense_date", period)} GROUP BY 1`.execute(tx);
      const months = [...new Set([...inc.rows.map((r) => r.ym), ...exp.rows.map((r) => r.ym)])].sort();
      const rows = months.map((ym) => {
        const collected = inc.rows.find((r) => r.ym === ym)?.v ?? 0;
        const e = exp.rows.find((r) => r.ym === ym);
        const spent = e?.v ?? 0, personal = e?.personal ?? 0;
        return {
          month: monthName(ym), receipts: inc.rows.find((r) => r.ym === ym)?.n ?? 0, collected,
          expenses: spent, personal, net: collected - spent, netExPersonal: collected - (spent - personal)
        };
      });
      const columns: Column[] = [
        { key: "month", label: "Month", type: "text" }, { key: "receipts", label: "Receipts", type: "int" },
        { key: "collected", label: "Collected", type: "money" }, { key: "expenses", label: "Expenses", type: "money" },
        { key: "personal", label: "of which Personal", type: "money" }, { key: "net", label: "Net", type: "money" },
        { key: "netExPersonal", label: "Net without Personal", type: "money" }
      ];
      const totals = Object.fromEntries(["receipts", "collected", "expenses", "personal", "net", "netExPersonal"].map((k) => [k, sum(rows, k)]));
      return { columns, rows, totals };
    }
  },
  {
    id: "collections-by-service", title: "Collections by service", group: "Money",
    about: "Which kind of treatment brought in the money in the period, grouped (RCT, Implant, Orthodontics and so on). Receipts with no service typed are shown on their own row.",
    async run({ tx, period }) {
      const r = await sql<{ service: string; n: number; v: number }>`
        SELECT ${SERVICE_GROUP} AS service, count(*)::int AS n, sum(amount1 + amount2)::float8 AS v
          FROM receipts WHERE ${within("receipt_date", period)} GROUP BY 1 ORDER BY v DESC, service`.execute(tx);
      const all = r.rows.reduce((s, x) => s + x.v, 0);
      const rows = r.rows.map((x) => ({ service: x.service, receipts: x.n, collected: x.v, share: all ? Math.round((x.v / all) * 1000) / 10 : 0 }));
      return {
        columns: [
          { key: "service", label: "Service", type: "text" }, { key: "receipts", label: "Receipts", type: "int" },
          { key: "collected", label: "Collected", type: "money" }, { key: "share", label: "Share %", type: "money" }
        ],
        rows, totals: { receipts: sum(rows, "receipts"), collected: sum(rows, "collected") }
      };
    }
  },
  {
    id: "receipts", title: "Receipts", group: "Money",
    about: "Every receipt in the period, newest first.",
    async run({ tx, period }) {
      const r = await sql<Record<string, unknown>>`
        SELECT receipt_date::text AS date, coalesce(legacy_receipt_no, receipt_no::text) AS no, upper(uhid) AS uhid,
               patient_name AS patient, service, service_group AS "group", mode1, amount1::float8 AS amount1, mode2, amount2::float8 AS amount2,
               (amount1 + amount2)::float8 AS total, remarks
          FROM receipts WHERE ${within("receipt_date", period)}
         ORDER BY receipt_date DESC, receipt_no DESC LIMIT ${ROW_CAP + 1}`.execute(tx);
      const { rows, truncated } = cap(r.rows);
      return {
        columns: [
          { key: "date", label: "Date", type: "date" }, { key: "no", label: "Receipt no.", type: "text" },
          { key: "uhid", label: "UHID", type: "text" }, { key: "patient", label: "Patient", type: "text" },
          { key: "service", label: "Service (as typed)", type: "text" }, { key: "group", label: "Service group", type: "text" }, { key: "mode1", label: "Mode", type: "text" },
          { key: "amount1", label: "Amount", type: "money" }, { key: "mode2", label: "Second mode", type: "text" },
          { key: "amount2", label: "Second amount", type: "money" }, { key: "total", label: "Total", type: "money" },
          { key: "remarks", label: "Remarks", type: "text" }
        ],
        rows, truncated, totals: { total: sum(rows, "total") }
      };
    }
  },
  {
    id: "expenses-by-head", title: "Expenses by head", group: "Money",
    about: "What the clinic spent on, grouped by expense name, in the period. Voided expenses are left out.",
    async run({ tx, period }) {
      const r = await sql<{ head: string; category: string | null; n: number; v: number }>`
        SELECT coalesce(nullif(trim(expense_name), ''), 'Not stated') AS head,
               max(nullif(trim(category), '')) AS category, count(*)::int AS n, sum(amount)::float8 AS v
          FROM expenses WHERE voided_at IS NULL AND ${within("expense_date", period)}
         GROUP BY 1 ORDER BY v DESC, head`.execute(tx);
      const all = r.rows.reduce((s, x) => s + x.v, 0);
      const rows = r.rows.map((x) => ({ head: x.head, category: x.category ?? "", entries: x.n, amount: x.v, share: all ? Math.round((x.v / all) * 1000) / 10 : 0 }));
      return {
        columns: [
          { key: "head", label: "Expense", type: "text" }, { key: "category", label: "Type", type: "text" },
          { key: "entries", label: "Entries", type: "int" }, { key: "amount", label: "Amount", type: "money" },
          { key: "share", label: "Share %", type: "money" }
        ],
        rows, totals: { entries: sum(rows, "entries"), amount: sum(rows, "amount") }
      };
    }
  },
  {
    id: "expenses", title: "Expenses", group: "Money",
    about: "Every expense in the period, newest first. Voided expenses are left out.",
    async run({ tx, period }) {
      const r = await sql<Record<string, unknown>>`
        SELECT expense_date::text AS date, expense_name AS name, category, paid_by AS "paidBy", mode, amount::float8 AS amount, remarks
          FROM expenses WHERE voided_at IS NULL AND ${within("expense_date", period)}
         ORDER BY expense_date DESC, created_at DESC LIMIT ${ROW_CAP + 1}`.execute(tx);
      const { rows, truncated } = cap(r.rows);
      return {
        columns: [
          { key: "date", label: "Date", type: "date" }, { key: "name", label: "Expense", type: "text" },
          { key: "category", label: "Type", type: "text" }, { key: "paidBy", label: "Paid by", type: "text" },
          { key: "mode", label: "Mode", type: "text" }, { key: "amount", label: "Amount", type: "money" },
          { key: "remarks", label: "Remarks", type: "text" }
        ],
        rows, truncated, totals: { amount: sum(rows, "amount") }
      };
    }
  },
  {
    id: "outstanding", title: "Outstanding balances", group: "Money", allYears: true,
    about: "Patients whose treatment plan estimate is more than they have paid so far. Balances are measured the same way as the patient screen: estimate total minus all receipts.",
    async run({ tx }) {
      const r = await sql<{ uhid: string; name: string | null; plan_date: string | null; total: number; paid: number; last_paid: string | null }>`
        SELECT upper(t.uhid) AS uhid, coalesce(t.patient_name, p.full_name) AS name, t.plan_date, ${ESTIMATE_TOTAL} AS total,
               coalesce(x.paid, 0)::float8 AS paid, x.last_paid
          FROM treatment_plans t
          LEFT JOIN patients p ON p.id = t.patient_id
          LEFT JOIN (SELECT upper(uhid) AS u, sum(amount1 + amount2) AS paid, max(receipt_date)::text AS last_paid FROM receipts GROUP BY 1) x ON x.u = upper(t.uhid)`.execute(tx);
      const rows = r.rows
        .filter((x) => x.total > 0 && x.total - x.paid > 0)
        .map((x) => ({ uhid: x.uhid, patient: x.name ?? "", planDate: x.plan_date ?? "", estimate: x.total, paid: x.paid, outstanding: x.total - x.paid, lastPaid: x.last_paid ?? "" }))
        .sort((a, b) => b.outstanding - a.outstanding);
      return {
        columns: [
          { key: "uhid", label: "UHID", type: "text" }, { key: "patient", label: "Patient", type: "text" },
          { key: "planDate", label: "Plan date", type: "text" }, { key: "estimate", label: "Estimate", type: "money" },
          { key: "paid", label: "Paid", type: "money" }, { key: "outstanding", label: "Outstanding", type: "money" },
          { key: "lastPaid", label: "Last payment", type: "date" }
        ],
        rows, totals: { estimate: sum(rows, "estimate"), paid: sum(rows, "paid"), outstanding: sum(rows, "outstanding") }
      };
    }
  },
  {
    id: "patients", title: "Patients registered", group: "Patients",
    about: "Patients registered in the period with their visits and what they have paid in total. Contact details are included, so treat the Excel file as confidential.",
    async run({ tx, tz, period }) {
      const r = await sql<Record<string, unknown>>`
        SELECT p.uhid, p.full_name AS name, p.gender, p.date_of_birth::text AS dob, p.mobile,
               p.patient_type AS type, pl.name AS panel, ${registeredDay(tz, "p.")}::text AS registered,
               coalesce(v.visits, 0)::int AS visits, coalesce(x.paid, 0)::float8 AS paid
          FROM patients p
          LEFT JOIN panels pl ON pl.id = p.panel_id
          LEFT JOIN (SELECT patient_id, count(*) AS visits FROM daily_register GROUP BY 1) v ON v.patient_id = p.id
          LEFT JOIN (SELECT upper(uhid) AS u, sum(amount1 + amount2) AS paid FROM receipts GROUP BY 1) x ON x.u = upper(p.uhid)
         WHERE p.deleted_at IS NULL AND ${within(registeredDay(tz, "p."), period)}
         ORDER BY 8 DESC, p.uhid DESC LIMIT ${ROW_CAP + 1}`.execute(tx);
      const { rows, truncated } = cap(r.rows);
      return {
        columns: [
          { key: "uhid", label: "UHID", type: "text" }, { key: "name", label: "Name", type: "text" },
          { key: "gender", label: "Gender", type: "text" }, { key: "dob", label: "Date of birth", type: "date" },
          { key: "mobile", label: "Mobile", type: "text" }, { key: "type", label: "Type", type: "text" },
          { key: "panel", label: "Panel", type: "text" }, { key: "registered", label: "Registered on", type: "date" },
          { key: "visits", label: "Visits", type: "int" }, { key: "paid", label: "Paid in total", type: "money" }
        ],
        rows, truncated, totals: { visits: sum(rows, "visits"), paid: sum(rows, "paid") }
      };
    }
  },
  {
    id: "doctor-wise", title: "Doctor-wise activity", group: "Diary",
    about: "For each doctor: visits recorded in the daily register, patients seen, and appointments booked, completed, missed or cancelled. Money is not shown because receipts do not record which doctor treated the patient. The register's doctor is typed text, so spellings are matched to the doctor list where they clearly agree, allowing a small typo, and left as typed when more than one doctor fits (\"Dr. Viveyk\" or \"Dr. Vivyek Mittel\" is read as Dr. Viveyk Mittel), and a visit with two doctors counts for each.",
    async run({ tx, tz, period }) {
      const known = (await sql<{ name: string }>`SELECT name FROM doctors ORDER BY name`.execute(tx)).rows.map((d) => d.name);
      const squash = (s: string) => s.replace(/\s+/g, " ").trim();
      // A typed name is read as a doctor when each word of the shorter name
      // matches a word of the longer one, allowing one slip per word (a missing,
      // extra, wrong or swapped letter: "Vivyek" for "Viveyk", "Mittal" for
      // "Mittel"). If two doctors fit equally well it is left as typed.
      const words = (n: string) => n.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w && w !== "dr");
      const close = (x: string, y: string) => x === y || (Math.min(x.length, y.length) >= 4 && slip(x, y) <= 1);
      const covers = (small: string[], big: string[]) => small.length > 0 && small.every((w) => big.some((v) => close(w, v)));
      const known2 = known.map((name) => ({ name, w: words(name) }));
      const canon = (typed: string): string => {
        const t = words(typed);
        if (!t.length) return squash(typed) ? squash(typed) : "Not recorded";
        const exact = known2.filter((k) => k.w.join(" ") === t.join(" "));
        if (exact.length === 1) return exact[0]!.name;
        const fits = known2.filter((k) => covers(t, k.w) || covers(k.w, t));
        return fits.length === 1 ? fits[0]!.name : squash(typed);
      };
      type Row = { doctor: string; visits: number; patients: Set<string>; booked: number; completed: number; noShow: number; cancelled: number };
      const byDoctor = new Map<string, Row>();
      const rowFor = (name: string) => {
        let r = byDoctor.get(name);
        if (!r) byDoctor.set(name, (r = { doctor: name, visits: 0, patients: new Set(), booked: 0, completed: 0, noShow: 0, cancelled: 0 }));
        return r;
      };

      // Visits: one register row per patient per day; "A | B" credits both.
      const reg = await sql<{ doc: string; pid: string; n: number }>`
        SELECT trim(d) AS doc, coalesce(nullif(upper(uhid), ''), patient_name, '') AS pid, count(*)::int AS n
          FROM daily_register, unnest(string_to_array(coalesce(nullif(trim(operating_doctor), ''), ' '), '|')) AS d
         WHERE ${within("visit_date", period)} GROUP BY 1, 2`.execute(tx);
      for (const x of reg.rows) {
        const r = rowFor(canon(x.doc));
        r.visits += x.n;
        if (x.pid) r.patients.add(x.pid);
      }

      const day = localDay("a.starts_at", tz);
      const appts = await sql<{ doctor: string | null; status: string; n: number }>`
        SELECT d.name AS doctor, a.status, count(*)::int AS n
          FROM appointments a LEFT JOIN doctors d ON d.id = a.doctor_id
         WHERE ${within(day, period)} GROUP BY 1, 2`.execute(tx);
      for (const x of appts.rows) {
        const r = rowFor(x.doctor ? canon(x.doctor) : "Not recorded");
        r.booked += x.n;
        if (x.status === "Completed") r.completed += x.n;
        else if (x.status === "No Show") r.noShow += x.n;
        else if (x.status === "Cancelled") r.cancelled += x.n;
      }

      // Names that are not on the doctor list ("Dr. Deeksha" and "Dr. Deeksha
      // Bhanotia") are joined when one clearly is the other.
      const listed = new Set(known);
      const loose = [...byDoctor.keys()].filter((n) => !listed.has(n) && n !== "Not recorded");
      for (const n of loose) {
        const longer = loose.filter((m) => m !== n && words(m).length > words(n).length && covers(words(n), words(m)));
        if (longer.length !== 1) continue;
        const from = byDoctor.get(n)!, to = rowFor(longer[0]!);
        to.visits += from.visits; to.booked += from.booked; to.completed += from.completed; to.noShow += from.noShow; to.cancelled += from.cancelled;
        from.patients.forEach((p) => to.patients.add(p));
        byDoctor.delete(n);
      }

      const all = [...byDoctor.values()].sort((a, b) => b.visits - a.visits || b.booked - a.booked || a.doctor.localeCompare(b.doctor));
      const totalVisits = all.reduce((s, r) => s + r.visits, 0);
      const rows = all.map((r) => ({
        doctor: r.doctor, visits: r.visits, patients: r.patients.size, share: totalVisits ? Math.round((r.visits / totalVisits) * 1000) / 10 : 0,
        booked: r.booked, completed: r.completed, noShow: r.noShow, cancelled: r.cancelled
      }));
      return {
        columns: [
          { key: "doctor", label: "Doctor", type: "text" }, { key: "visits", label: "Visits (register)", type: "int" },
          { key: "patients", label: "Patients seen", type: "int" }, { key: "share", label: "Share of visits %", type: "money" },
          { key: "booked", label: "Appointments booked", type: "int" }, { key: "completed", label: "Completed", type: "int" },
          { key: "noShow", label: "No-shows", type: "int" }, { key: "cancelled", label: "Cancelled", type: "int" }
        ],
        // Patients seen is not summed: one patient can see two doctors.
        rows, totals: { visits: sum(rows, "visits"), booked: sum(rows, "booked"), completed: sum(rows, "completed"), noShow: sum(rows, "noShow"), cancelled: sum(rows, "cancelled") }
      };
    }
  },
  {
    id: "appointments-by-month", title: "Appointments by month", group: "Diary",
    about: "How many visits were booked each month and how they ended.",
    async run({ tx, tz, period }) {
      const day = localDay("starts_at", tz);
      const r = await sql<{ ym: string; status: string; n: number }>`
        SELECT to_char(${day}, 'YYYY-MM') AS ym, status, count(*)::int AS n
          FROM appointments WHERE ${within(day, period)} GROUP BY 1, 2`.execute(tx);
      const months = [...new Set(r.rows.map((x) => x.ym))].sort();
      const statuses = ["Completed", "Scheduled", "Checked In", "In Chair", "Cancelled", "No Show"];
      const rows = months.map((ym) => {
        const row: Record<string, unknown> = { month: monthName(ym), total: 0 };
        for (const s of statuses) {
          const n = r.rows.find((x) => x.ym === ym && x.status === s)?.n ?? 0;
          row[s] = n; row.total = (row.total as number) + n;
        }
        const t = row.total as number;
        row.noShowPct = t ? Math.round(((row["No Show"] as number) / t) * 1000) / 10 : 0;
        return row;
      });
      return {
        columns: [
          { key: "month", label: "Month", type: "text" }, { key: "total", label: "Booked", type: "int" },
          ...statuses.map((s): Column => ({ key: s, label: s, type: "int" })),
          { key: "noShowPct", label: "No-show %", type: "money" }
        ],
        rows, totals: Object.fromEntries(["total", ...statuses].map((k) => [k, sum(rows, k)]))
      };
    }
  },
  {
    id: "appointments", title: "Appointments", group: "Diary",
    about: "Every booking in the period, newest first, with doctor, chair and outcome.",
    async run({ tx, tz, period }) {
      const day = localDay("a.starts_at", tz);
      const r = await sql<Record<string, unknown>>`
        SELECT ${day}::text AS date, to_char(a.starts_at AT TIME ZONE ${tz}, 'HH24:MI') AS time,
               a.patient_name AS patient, upper(p.uhid) AS uhid, a.mobile, a.reason, a.sub_type AS "subType",
               d.name AS doctor, c.name AS chair, a.status, a.cancel_reason AS "cancelReason"
          FROM appointments a
          LEFT JOIN patients p ON p.id = a.patient_id
          LEFT JOIN doctors d ON d.id = a.doctor_id
          LEFT JOIN chairs c ON c.id = a.chair_id
         WHERE ${within(day, period)}
         ORDER BY a.starts_at DESC LIMIT ${ROW_CAP + 1}`.execute(tx);
      const { rows, truncated } = cap(r.rows);
      return {
        columns: [
          { key: "date", label: "Date", type: "date" }, { key: "time", label: "Time", type: "text" },
          { key: "patient", label: "Patient", type: "text" }, { key: "uhid", label: "UHID", type: "text" },
          { key: "mobile", label: "Mobile", type: "text" }, { key: "reason", label: "Reason", type: "text" },
          { key: "subType", label: "Detail", type: "text" }, { key: "doctor", label: "Doctor", type: "text" },
          { key: "chair", label: "Chair", type: "text" }, { key: "status", label: "Status", type: "text" },
          { key: "cancelReason", label: "Cancel reason", type: "text" }
        ],
        rows, truncated
      };
    }
  }
];

export const reportById = (id: string) => REPORTS.find((r) => r.id === id);

/** The finished rows with a closing "Total" row, for Excel. */
export function withTotalRow(res: ReportResult): Record<string, unknown>[] {
  if (!res.totals || !res.rows.length) return res.rows;
  return [...res.rows, { [res.columns[0]!.key]: "Total", ...res.totals }];
}

// ── dashboard ──────────────────────────────────────────────────────────────

export interface Dashboard {
  period: Period;
  today: string;
  isCurrentFy: boolean;
  fys: string[];
  kpis: {
    patientsTotal: number; patientsNew: number;
    collectedToday: number; collectedMonth: number; collectedPeriod: number;
    expensesMonth: number; expensesPeriod: number; netPeriod: number;
    appointmentsToday: number; appointmentsMonth: number; noShowsMonth: number;
    outstandingTotal: number; outstandingPatients: number;
  };
  months: { month: string; collected: number; expenses: number; newPatients: number; appointments: number }[];
  byMode: { mode: string; amount: number }[];
  topServices: { service: string; amount: number }[];
  topExpenses: { head: string; amount: number }[];
}

export async function buildDashboard(tx: Tx, tz: string, q: { fy?: string }): Promise<Dashboard> {
  const today = (await sql<{ d: string }>`SELECT clinic_today()::text AS d`.execute(tx)).rows[0]!.d;
  const period = resolvePeriod({ fy: q.fy }, today);
  const month = today.slice(0, 7);
  const apptDay = localDay("starts_at", tz);
  const regDay = registeredDay(tz);
  const one = async <T>(query: RawBuilder<T>) => (await query.execute(tx)).rows[0]!;

  const rec = await one(sql<{ today: number; month: number; period: number }>`
    SELECT coalesce(sum(amount1 + amount2) FILTER (WHERE receipt_date = ${today}::date), 0)::float8 AS today,
           coalesce(sum(amount1 + amount2) FILTER (WHERE to_char(receipt_date, 'YYYY-MM') = ${month}), 0)::float8 AS month,
           coalesce(sum(amount1 + amount2) FILTER (WHERE ${within("receipt_date", period)}), 0)::float8 AS period FROM receipts`);
  const exp = await one(sql<{ month: number; period: number }>`
    SELECT coalesce(sum(amount) FILTER (WHERE to_char(expense_date, 'YYYY-MM') = ${month}), 0)::float8 AS month,
           coalesce(sum(amount) FILTER (WHERE ${within("expense_date", period)}), 0)::float8 AS period
      FROM expenses WHERE voided_at IS NULL`);
  const pat = await one(sql<{ total: number; fresh: number }>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE ${within(regDay, period)})::int AS fresh
      FROM patients WHERE deleted_at IS NULL`);
  const apt = await one(sql<{ today: number; month: number; noshow: number }>`
    SELECT count(*) FILTER (WHERE ${apptDay} = ${today}::date)::int AS today,
           count(*) FILTER (WHERE to_char(${apptDay}, 'YYYY-MM') = ${month})::int AS month,
           count(*) FILTER (WHERE to_char(${apptDay}, 'YYYY-MM') = ${month} AND status = 'No Show')::int AS noshow
      FROM appointments`);
  const out = await outstandingTotals(tx);

  // Months of the chosen year, or the last 12 months when "all years" or a custom range is shown.
  const inc = await sql<{ ym: string; v: number }>`
    SELECT to_char(receipt_date, 'YYYY-MM') AS ym, sum(amount1 + amount2)::float8 AS v FROM receipts WHERE ${within("receipt_date", period)} GROUP BY 1`.execute(tx);
  const spent = await sql<{ ym: string; v: number }>`
    SELECT to_char(expense_date, 'YYYY-MM') AS ym, sum(amount)::float8 AS v FROM expenses WHERE voided_at IS NULL AND ${within("expense_date", period)} GROUP BY 1`.execute(tx);
  const regs = await sql<{ ym: string; n: number }>`
    SELECT to_char(${regDay}, 'YYYY-MM') AS ym, count(*)::int AS n FROM patients WHERE deleted_at IS NULL AND ${within(regDay, period)} GROUP BY 1`.execute(tx);
  const appts = await sql<{ ym: string; n: number }>`
    SELECT to_char(${apptDay}, 'YYYY-MM') AS ym, count(*)::int AS n FROM appointments WHERE ${within(apptDay, period)} GROUP BY 1`.execute(tx);
  const keys = monthRange(period, today);
  const months = keys.map((ym) => ({
    month: monthName(ym),
    collected: inc.rows.find((r) => r.ym === ym)?.v ?? 0,
    expenses: spent.rows.find((r) => r.ym === ym)?.v ?? 0,
    newPatients: regs.rows.find((r) => r.ym === ym)?.n ?? 0,
    appointments: appts.rows.find((r) => r.ym === ym)?.n ?? 0
  }));

  const modes = await sql<{ mode: string; v: number }>`
    SELECT mode, sum(amt)::float8 AS v FROM ${MODE_PARTS} WHERE ${within("receipt_date", period)} GROUP BY 1 ORDER BY v DESC`.execute(tx);
  const services = await sql<{ service: string; v: number }>`
    SELECT ${SERVICE_GROUP} AS service, sum(amount1 + amount2)::float8 AS v
      FROM receipts WHERE ${within("receipt_date", period)} GROUP BY 1 ORDER BY v DESC LIMIT 6`.execute(tx);
  const heads = await sql<{ head: string; v: number }>`
    SELECT coalesce(nullif(trim(expense_name), ''), 'Not stated') AS head, sum(amount)::float8 AS v
      FROM expenses WHERE voided_at IS NULL AND ${within("expense_date", period)} GROUP BY 1 ORDER BY v DESC LIMIT 6`.execute(tx);

  const bounds = await one(sql<{ first: string | null }>`
    SELECT least((SELECT min(receipt_date) FROM receipts), (SELECT min(expense_date) FROM expenses),
                 (SELECT min(${regDay}) FROM patients))::text AS first`);
  const nowFy = Number(resolvePeriod({}, today).from!.slice(0, 4));
  const firstFy = bounds.first ? Math.min(nowFy, Number(bounds.first.slice(5, 7)) >= 4 ? Number(bounds.first.slice(0, 4)) : Number(bounds.first.slice(0, 4)) - 1) : nowFy;
  const fys: string[] = [];
  for (let y = nowFy; y >= firstFy; y--) fys.push(fyLabel(y));

  return {
    period, today, fys,
    isCurrentFy: period.from === resolvePeriod({}, today).from,
    kpis: {
      patientsTotal: pat.total, patientsNew: pat.fresh,
      collectedToday: rec.today, collectedMonth: rec.month, collectedPeriod: rec.period,
      expensesMonth: exp.month, expensesPeriod: exp.period, netPeriod: rec.period - exp.period,
      appointmentsToday: apt.today, appointmentsMonth: apt.month, noShowsMonth: apt.noshow,
      outstandingTotal: out.total, outstandingPatients: out.count
    },
    months,
    byMode: modes.rows.map((r) => ({ mode: r.mode, amount: r.v })),
    topServices: services.rows.map((r) => ({ service: r.service, amount: r.v })),
    topExpenses: heads.rows.map((r) => ({ head: r.head, amount: r.v }))
  };
}

async function outstandingTotals(tx: Tx): Promise<{ total: number; count: number }> {
  const r = await sql<{ total: number; paid: number }>`
    SELECT ${ESTIMATE_TOTAL} AS total, coalesce(x.paid, 0)::float8 AS paid
      FROM treatment_plans t
      LEFT JOIN (SELECT upper(uhid) AS u, sum(amount1 + amount2) AS paid FROM receipts GROUP BY 1) x ON x.u = upper(t.uhid)`.execute(tx);
  const owing = r.rows.filter((x) => x.total > 0 && x.total - x.paid > 0);
  return { total: owing.reduce((s, x) => s + x.total - x.paid, 0), count: owing.length };
}

/** YYYY-MM for each month of the period; for an open-ended period, the last 12 months to today. */
function monthRange(p: Period, today: string): string[] {
  const to = p.to && p.to < today ? p.to : today;
  let from = p.from;
  if (!from) from = shiftMonth(to.slice(0, 7), -11) + "-01";
  const out: string[] = [];
  for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ym = shiftMonth(ym, 1)) out.push(ym);
  return out.slice(-36);
}

function shiftMonth(ym: string, by: number): string {
  const m = Number(ym.slice(5, 7)) - 1 + by, y = Number(ym.slice(0, 4)) + Math.floor(m / 12);
  return `${y}-${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}`;
}
