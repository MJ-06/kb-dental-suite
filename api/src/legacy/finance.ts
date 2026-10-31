// Receipts, collections, expenses, profit and loss and balances, answering
// as the live Apps Script does.
//
// Amounts are numeric(12,2) in the database and plain numbers on the wire.
// Every "today", "this month" and financial year is the clinic's own: the
// financial year runs April to March, and the server's timezone never enters.
import { sql } from "kysely";
import { can } from "../auth/permissions.js";
import type { Tx } from "../db/index.js";
import { read, write, DeskError, type ActionTable } from "./types.js";
import { isoDay, nz, num, str, uhidOf } from "./util.js";

const MODES_JOINED = (m1: string | null, m2: string | null) => (m2 ? `${m1 ?? ""} + ${m2}` : m1 ?? "");

interface ReceiptRow {
  date: string; receipt_no: number; label: string | null; uhid: string | null; patient_name: string | null; service: string | null;
  mode1: string | null; mode2: string | null; fee: number; remarks: string | null;
}

/** Receipts between two clinic days (either may be empty), newest first. */
async function receiptsBetween(tx: Tx, from: string, to: string, uhid = ""): Promise<ReceiptRow[]> {
  const r = await sql<ReceiptRow>`
    SELECT receipt_date::text AS date, receipt_no, legacy_receipt_no AS label, uhid, patient_name, service, mode1, mode2,
           (amount1 + amount2)::float8 AS fee, remarks
      FROM receipts
     WHERE (${from || null}::date IS NULL OR receipt_date >= ${from || null}::date)
       AND (${to || null}::date IS NULL OR receipt_date <= ${to || null}::date)
       AND (${uhid} = '' OR upper(uhid) = ${uhid})
     ORDER BY receipt_date DESC, receipt_no DESC`.execute(tx);
  return r.rows;
}

async function today(tx: Tx): Promise<string> {
  return (await sql<{ d: string }>`SELECT clinic_today()::text AS d`.execute(tx)).rows[0]!.d;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Monday of the week the day falls in, as the P&L buckets weeks. */
const weekKey = (iso: string) => {
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
};

const monthKey = (iso: string) => iso.slice(0, 7);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Fixed names, not the runtime's locale data: en-IN spells September "Sept" on some Node versions and "Sep" on others.
const dayMon = (iso: string) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

const weekLabel = (key: string) => `${dayMon(key)} – ${dayMon(addDays(key, 6))}`;
const monthLabel = (key: string) => `${MONTHS_LONG[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

/**
 * What a plan says it will cost: the estimate's own total ("₹5,000" and 5000
 * alike). Anything that is not a plain number once the symbols are stripped
 * counts as 0 rather than failing the query, so one damaged plan can never
 * take every patient's balance down with it.
 */
export const ESTIMATE_TOTAL = sql<number>`(CASE
  WHEN regexp_replace(coalesce(estimate->>'total', ''), '[^0-9.-]', '', 'g') ~ '^[0-9]{1,12}([.][0-9]{1,4})?$'
  THEN regexp_replace(coalesce(estimate->>'total', ''), '[^0-9.-]', '', 'g')::float8
  ELSE 0 END)`;

export const finance: ActionTable = {
  saveReceipt: write("payments:collect", async (p, { tx }) => {
    const amount1 = num(p.amount1) ?? 0, amount2 = num(p.amount2) ?? 0;
    if (amount1 < 0 || amount2 < 0) throw new DeskError("An amount cannot be negative");
    if (amount1 + amount2 <= 0) throw new DeskError("Enter the amount received");
    if (amount2 > 0 && !str(p.mode2)) throw new DeskError("Choose the payment mode for the second amount");
    const uhid = uhidOf(p.uhid);
    const patient = uhid
      ? (await sql<{ id: string; full_name: string }>`SELECT id, full_name FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0]
      : undefined;
    const date = isoDay(p.date) || (await today(tx));
    const r = await sql<{ id: string; receipt_no: number; label: string | null }>`
      INSERT INTO receipts (receipt_no, receipt_date, patient_id, uhid, patient_name, service,
                            mode1, amount1, mode2, amount2, remarks, legacy_receipt_no)
      VALUES (next_receipt_no(), ${date}::date, ${patient?.id ?? null}, ${nz(uhid)},
              ${nz(p.patientName) ?? patient?.full_name ?? null}, ${nz(p.service)},
              ${nz(p.mode1)}, ${amount1}, ${amount2 > 0 ? nz(p.mode2) : null}, ${amount2}, ${nz(p.remarks)}, next_receipt_label(${date}::date))
      RETURNING id, receipt_no, legacy_receipt_no AS label`.execute(tx);
    return { success: true, id: r.rows[0]!.id, receiptNo: r.rows[0]!.label ?? r.rows[0]!.receipt_no };
  }),

  // One patient's receipts need the right to take payments; the whole
  // clinic's need the right to read the books.
  getReceipts: read(async (p, { tx, actor }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid && !can(actor, "finance:read")) {
      return { success: false, error: "Your role does not allow this", forbidden: true };
    }
    const rows = await receiptsBetween(tx, isoDay(p.fromDate), isoDay(p.toDate), uhid);
    return {
      success: true,
      receipts: rows.map((r) => ({
        date: r.date, uhid: r.uhid ?? "", patientName: r.patient_name ?? "", service: r.service ?? "",
        mode: MODES_JOINED(r.mode1, r.mode2), fee: r.fee, receiptNo: r.label ?? r.receipt_no, remarks: r.remarks ?? ""
      }))
    };
  }, "payments:collect"),

  getRevenueByPatient: read(async (p, { tx }) => {
    const from = isoDay(p.fromDate), to = isoDay(p.toDate);
    const r = await sql<{ uhid: string; total: number; n: number }>`
      SELECT upper(uhid) AS uhid, sum(amount1 + amount2)::float8 AS total, count(*)::int AS n
        FROM receipts
       WHERE coalesce(uhid, '') <> ''
         AND (${from || null}::date IS NULL OR receipt_date >= ${from || null}::date)
         AND (${to || null}::date IS NULL OR receipt_date <= ${to || null}::date)
       GROUP BY upper(uhid)`.execute(tx);
    const revenue: Record<string, number> = {};
    let receipts = 0;
    for (const row of r.rows) { revenue[row.uhid] = row.total; receipts += row.n; }
    return { success: true, revenue, receipts };
  }, "finance:read"),

  getDailyCollection: read(async (p, { tx }) => {
    const date = isoDay(p.date);
    const from = isoDay(p.fromDate) || date, to = isoDay(p.toDate) || date;
    const rows = await receiptsBetween(tx, from, to);
    const byMode: Record<string, number> = {};
    let total = 0;
    const receipts = rows.map((r) => {
      const mode = MODES_JOINED(r.mode1, r.mode2) || "Unknown";
      total += r.fee;
      byMode[mode] = (byMode[mode] ?? 0) + r.fee;
      return { uhid: r.uhid ?? "", patientName: r.patient_name ?? "", service: r.service ?? "", mode, fee: r.fee };
    });
    return { success: true, fromDate: from, toDate: to, total, byMode, count: receipts.length, receipts };
  }, "finance:read"),

  getFinanceSummary: read(async (_p, { tx }) => {
    const todayIso = await today(tx);
    const year = Number(todayIso.slice(0, 4)), month = Number(todayIso.slice(5, 7));
    const fyStart = month >= 4 ? year : year - 1;
    const rows = await receiptsBetween(tx, "", "");
    const todayByMode: Record<string, number> = {};
    let todayTotal = 0, monthTotal = 0, allTimeTotal = 0, fyTotal = 0;
    for (const r of rows) {
      allTimeTotal += r.fee;
      if (r.date === todayIso) {
        todayTotal += r.fee;
        const mode = MODES_JOINED(r.mode1, r.mode2) || "Unknown";
        todayByMode[mode] = (todayByMode[mode] ?? 0) + r.fee;
      }
      if (r.date.slice(0, 7) === todayIso.slice(0, 7)) monthTotal += r.fee;
      if (r.date >= `${fyStart}-04-01` && r.date <= `${fyStart + 1}-03-31`) fyTotal += r.fee;
    }
    return {
      success: true, todayTotal, monthTotal, allTimeTotal, fyTotal,
      fyLabel: `FY ${fyStart}-${String(fyStart + 1).slice(2)}`,
      totalReceipts: rows.length, todayByMode,
      recent: rows.slice(0, 8).map((r) => ({
        date: r.date, uhid: r.uhid ?? "", patientName: r.patient_name ?? "", service: r.service ?? "",
        mode: MODES_JOINED(r.mode1, r.mode2), fee: r.fee
      }))
    };
  }, "finance:read"),

  getProfitLoss: read(async (p, { tx }) => {
    const monthly = str(p.mode) === "monthly";
    const periods = Math.min(Math.max(parseInt(str(p.periods), 10) || (monthly ? 6 : 8), 1), 60);
    const keyOf = monthly ? monthKey : weekKey;
    const labelOf = monthly ? monthLabel : weekLabel;
    const now = await today(tx);

    // Walk back from the current period; months step by calendar month, so
    // the 31st never lands in the wrong one.
    const keys: string[] = [];
    for (let i = periods - 1; i >= 0; i--) {
      if (monthly) {
        const y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7)) - 1 - i;
        keys.push(`${y + Math.floor(m / 12)}-${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}`);
      } else keys.push(weekKey(addDays(now, -7 * i)));
    }
    const first = monthly ? `${keys[0]}-01` : keys[0]!;

    const income = await sql<{ d: string; v: number }>`
      SELECT receipt_date::text AS d, sum(amount1 + amount2)::float8 AS v FROM receipts
       WHERE receipt_date >= ${first}::date GROUP BY receipt_date`.execute(tx);
    const spent = await sql<{ d: string; v: number }>`
      SELECT expense_date::text AS d, sum(amount)::float8 AS v FROM expenses
       WHERE voided_at IS NULL AND expense_date >= ${first}::date GROUP BY expense_date`.execute(tx);
    const tracked = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM expenses WHERE voided_at IS NULL`.execute(tx)).rows[0]!.n > 0;

    const buckets = new Map(keys.map((k) => [k, { income: 0, expense: 0 }]));
    for (const row of income.rows) { const b = buckets.get(keyOf(row.d)); if (b) b.income += row.v; }
    for (const row of spent.rows) { const b = buckets.get(keyOf(row.d)); if (b) b.expense += row.v; }

    const current = keyOf(now);
    const series = keys.map((key) => {
      const b = buckets.get(key)!;
      return { key, label: labelOf(key), income: b.income, expense: b.expense, net: b.income - b.expense, isCurrent: key === current };
    });
    const totalIncome = series.reduce((s, x) => s + x.income, 0);
    const totalExpense = series.reduce((s, x) => s + x.expense, 0);
    return {
      success: true, mode: monthly ? "monthly" : "weekly", series,
      totalIncome, totalExpense, totalNet: totalIncome - totalExpense, expenseTracked: tracked
    };
  }, "finance:read"),

  getExpenses: read(async (p, { tx }) => {
    const from = isoDay(p.fromDate), to = isoDay(p.toDate);
    const r = await sql<{ id: string; date: string; paid_by: string | null; name: string | null; amount: number; mode: string | null; remarks: string | null }>`
      SELECT coalesce(legacy_id, id::text) AS id, expense_date::text AS date, paid_by, expense_name AS name,
             amount::float8 AS amount, mode, remarks
        FROM expenses
       WHERE voided_at IS NULL
         AND (${from || null}::date IS NULL OR expense_date >= ${from || null}::date)
         AND (${to || null}::date IS NULL OR expense_date <= ${to || null}::date)
       ORDER BY expense_date DESC, created_at DESC`.execute(tx);
    return {
      success: true,
      expenses: r.rows.map((e) => ({
        date: e.date, paidBy: e.paid_by ?? "", expenseName: e.name ?? "", amount: e.amount,
        mode: e.mode ?? "", remarks: e.remarks ?? "", id: e.id
      }))
    };
  }, "finance:read"),

  saveExpense: write("finance:write", async (p, { tx }) => {
    const amount = num(p.amount);
    if (amount === null || amount <= 0) throw new DeskError("Enter the amount spent");
    const date = isoDay(p.date) || (await today(tx));
    const r = await sql<{ id: string }>`
      INSERT INTO expenses (expense_date, paid_by, expense_name, amount, mode, remarks)
      VALUES (${date}::date, ${nz(p.paidBy)}, ${nz(p.expenseName)}, ${amount}, ${nz(p.mode)}, ${nz(p.remarks)})
      RETURNING id`.execute(tx);
    return { success: true, id: r.rows[0]!.id };
  }),

  deleteExpense: write("finance:write", async (p, { tx, actor }) => {
    const id = str(p.id);
    const r = await sql<{ id: string }>`
      UPDATE expenses SET voided_at = now(), voided_by = ${actor.userId}
       WHERE (id::text = ${id} OR legacy_id = ${id}) AND voided_at IS NULL
      RETURNING id`.execute(tx);
    return r.rows[0] ? { success: true } : { success: false, error: `Expense not found: ${id}` };
  }),

  // ── balances: what the plan estimated against what has been paid ───────

  getPatientOutstanding: read(async (p, { tx }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid) return { success: false, error: "uhid required" };
    const plan = await sql<{ total: number }>`
      SELECT ${ESTIMATE_TOTAL} AS total FROM treatment_plans WHERE upper(uhid) = ${uhid}`.execute(tx);
    const paid = await sql<{ paid: number }>`
      SELECT coalesce(sum(amount1 + amount2), 0)::float8 AS paid FROM receipts WHERE upper(uhid) = ${uhid}`.execute(tx);
    const estimateTotal = plan.rows[0]?.total ?? 0, amountPaid = paid.rows[0]!.paid;
    return { success: true, uhid, estimateTotal, paid: amountPaid, outstanding: estimateTotal - amountPaid };
  }, "payments:collect"),

  getOutstandingList: read(async (_p, { tx }) => {
    const r = await sql<{ uhid: string; name: string | null; total: number; paid: number }>`
      SELECT upper(t.uhid) AS uhid, t.patient_name AS name, ${ESTIMATE_TOTAL} AS total,
             coalesce(x.paid, 0)::float8 AS paid
        FROM treatment_plans t
        LEFT JOIN (SELECT upper(uhid) AS u, sum(amount1 + amount2) AS paid FROM receipts GROUP BY 1) x ON x.u = upper(t.uhid)`.execute(tx);
    // One pass over the receipts instead of one per plan: with 220 plans and
    // 1,700 receipts the per-plan lookup took 850 ms; this takes a few.
    const list = r.rows
      .filter((x) => x.total > 0 && x.total - x.paid > 0)
      .map((x) => ({ uhid: x.uhid, patientName: x.name ?? "", estimateTotal: x.total, paid: x.paid, outstanding: x.total - x.paid }))
      .sort((a, b) => b.outstanding - a.outstanding);
    return { success: true, list, count: list.length, totalOutstanding: list.reduce((s, x) => s + x.outstanding, 0) };
  }, "finance:read"),

  // The treatment plan itself belongs to the clinical screens; it is here
  // because the balances above are measured against its estimate.
  getTreatmentPlan: read(async (p, { tx }) => {
    const uhid = uhidOf(p.uhid);
    const r = await sql<{ plan_rows: unknown; estimate: unknown; saved: string }>`
      SELECT plan_rows, estimate, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS saved
        FROM treatment_plans WHERE upper(uhid) = ${uhid}`.execute(tx);
    const row = r.rows[0];
    return row ? { success: true, rows: row.plan_rows, estimate: row.estimate, savedAt: row.saved }
               : { success: true, rows: null, estimate: null };
  }, "clinical:read"),

  saveTreatmentPlan: write("clinical:write", async (p, { tx }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid) throw new DeskError("uhid required");
    const json = (v: unknown) => {
      if (v === undefined || v === null || v === "") return null;
      if (typeof v !== "string") return JSON.stringify(v);
      try { return JSON.stringify(JSON.parse(v)); } catch { throw new DeskError("The treatment plan arrived damaged and was not saved"); }
    };
    const total = (JSON.parse(json(p.estimate) ?? "null") as { total?: unknown } | null)?.total;
    if (total !== undefined && total !== null && total !== "") {
      // Same reading as ESTIMATE_TOTAL: symbols and commas go, what is left must be plain money.
      if (!/^\d{1,12}(\.\d{1,4})?$/.test(String(total).replace(/[^0-9.\-]/g, ""))) throw new DeskError("The estimate total must be an amount of money");
    }
    const patient = (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0];
    await sql`
      INSERT INTO treatment_plans (patient_id, uhid, patient_name, plan_date, plan_rows, estimate)
      VALUES (${patient?.id ?? null}, ${uhid}, ${nz(p.patientName)}, ${nz(p.date)}, ${json(p.rows)}::jsonb, ${json(p.estimate)}::jsonb)
      ON CONFLICT (clinic_id, uhid) DO UPDATE
        SET patient_name = EXCLUDED.patient_name, plan_date = EXCLUDED.plan_date,
            plan_rows = EXCLUDED.plan_rows, estimate = EXCLUDED.estimate`.execute(tx);
    return { success: true };
  })
};
