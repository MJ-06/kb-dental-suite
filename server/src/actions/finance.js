// Money: receipts, collections, outstanding, expenses, profit and loss.
//
// The rule that changes everything here: a payment names its patient, with
// a foreign key, always. In the sheets it named them in a text cell, and
// anything that wanted a patient's total had to match them up afterwards.
// That is how ₹65,000 went missing from one patient's Procedures sheet.
const { query, tx } = require("../db");
const { nz, num, dateISO, uhidOf } = require("../util");

const actions = {};

actions.saveReceipt = async (p) => {
  const uhid = uhidOf(p.uhid);
  const amount = num(p.fee !== undefined ? p.fee : p.amount);
  if (!uhid) return { success: false, error: "A receipt needs a UHID" };
  if (amount === null || amount <= 0) return { success: false, error: "A receipt needs an amount" };

  return tx(async (c) => {
    const known = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!known.rowCount) return { success: false, error: `Patient not found: ${uhid}` };

    const paidOn = dateISO(p.date) || dateISO(new Date());
    // Attach the payment to that day's visit when there is one. When there
    // is not, the payment still belongs to the patient — it is an advance,
    // not an orphan, and visit_id stays NULL rather than the row being
    // matched to the wrong day later.
    const v = await c.query(
      "SELECT id FROM visits WHERE uhid = $1 AND visit_date = $2", [uhid, paidOn]
    );

    // The receipt number the desk typed, or the next one. Unique either way:
    // two receipts cannot share a number.
    let receiptNo = nz(p.receiptNo);
    if (!receiptNo) {
      const seq = await c.query(
        `SELECT COALESCE(max(NULLIF(regexp_replace(receipt_no, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
           FROM payments WHERE receipt_no ~ '^[A-Za-z]*[0-9]+$'`
      );
      receiptNo = String(seq.rows[0].n);
    }

    try {
      const r = await c.query(
        `INSERT INTO payments (uhid, visit_id, paid_on, amount, mode, service, receipt_no, remarks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [uhid, v.rowCount ? v.rows[0].id : null, paidOn, amount,
         String(p.mode || "Cash"), nz(p.service), receiptNo, nz(p.remarks)]
      );
      return { success: true, id: String(r.rows[0].id), receiptNo };
    } catch (e) {
      if (e.constraint === "payments_receipt_no_key") {
        return { success: false, error: `Receipt ${receiptNo} already exists` };
      }
      throw e;
    }
  });
};

function receiptRow(x) {
  return {
    id: String(x.id),
    date: dateISO(x.paid_on),
    uhid: x.uhid,
    patientName: x.full_name || "",
    service: x.service || "",
    mode: x.mode,
    fee: Number(x.amount),
    receiptNo: x.receipt_no || "",
    remarks: x.remarks || ""
  };
}

const RECEIPT_SELECT = `
  SELECT pay.id, pay.uhid, pay.paid_on, pay.amount, pay.mode, pay.service,
         pay.receipt_no, pay.remarks, p.full_name
    FROM payments pay JOIN patients p ON p.uhid = pay.uhid`;

function dateWhere(p, col, params) {
  const parts = [];
  if (uhidOf(p.uhid)) { params.push(uhidOf(p.uhid)); parts.push(`pay.uhid = $${params.length}`); }
  if (dateISO(p.fromDate)) { params.push(dateISO(p.fromDate)); parts.push(`${col} >= $${params.length}`); }
  if (dateISO(p.toDate)) { params.push(dateISO(p.toDate)); parts.push(`${col} <= $${params.length}`); }
  if (dateISO(p.date)) { params.push(dateISO(p.date)); parts.push(`${col} = $${params.length}`); }
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

actions.getReceipts = async (p) => {
  const params = [];
  const where = dateWhere(p, "pay.paid_on", params);
  const r = await query(`${RECEIPT_SELECT} ${where} ORDER BY pay.paid_on DESC, pay.id DESC`, params);
  return { success: true, receipts: r.rows.map(receiptRow) };
};

// One patient's total. A sum, not a reconciliation.
actions.getRevenueByPatient = async (p) => {
  const uhid = uhidOf(p.uhid);
  const r = await query(
    `SELECT COALESCE(sum(amount), 0) AS total, count(*)::int AS n
       FROM payments WHERE uhid = $1`,
    [uhid]
  );
  return { success: true, revenue: Number(r.rows[0].total), receipts: r.rows[0].n };
};

actions.getDailyCollection = async (p) => {
  const from = dateISO(p.fromDate) || dateISO(p.date) || dateISO(new Date());
  const to = dateISO(p.toDate) || from;
  const r = await query(
    `${RECEIPT_SELECT} WHERE pay.paid_on BETWEEN $1 AND $2 ORDER BY pay.paid_on, pay.id`,
    [from, to]
  );
  const receipts = r.rows.map(receiptRow);
  const byMode = {};
  let total = 0;
  for (const x of receipts) {
    total += x.fee;
    byMode[x.mode] = (byMode[x.mode] || 0) + x.fee;
  }
  return { success: true, fromDate: from, toDate: to, total, byMode, count: receipts.length, receipts };
};

// What a patient still owes: their estimate, less what they have paid.
actions.getPatientOutstanding = async (p) => {
  const uhid = uhidOf(p.uhid);
  const plan = await query(
    "SELECT estimate FROM treatment_plans WHERE uhid = $1 ORDER BY plan_date DESC, id DESC LIMIT 1",
    [uhid]
  );
  const est = plan.rowCount && plan.rows[0].estimate ? plan.rows[0].estimate : {};
  const estimateTotal = Number(est.total || est.grandTotal || 0);
  const paid = await query("SELECT COALESCE(sum(amount), 0) AS t FROM payments WHERE uhid = $1", [uhid]);
  const p2 = Number(paid.rows[0].t);
  return { success: true, uhid, estimateTotal, paid: p2, outstanding: estimateTotal - p2 };
};

actions.getOutstandingList = async () => {
  // One query where the sheet read two whole tabs and matched them in the
  // browser. The estimate is the patient's most recent one.
  const r = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (uhid) uhid, estimate
         FROM treatment_plans ORDER BY uhid, plan_date DESC, id DESC
     ), paid AS (
       SELECT uhid, sum(amount) AS total FROM payments GROUP BY uhid
     )
     SELECT p.uhid, p.full_name, p.mobile,
            COALESCE((l.estimate->>'total')::numeric,
                     (l.estimate->>'grandTotal')::numeric, 0) AS estimate_total,
            COALESCE(paid.total, 0) AS paid
       FROM patients p
       LEFT JOIN latest l ON l.uhid = p.uhid
       LEFT JOIN paid    ON paid.uhid = p.uhid
      WHERE COALESCE((l.estimate->>'total')::numeric,
                     (l.estimate->>'grandTotal')::numeric, 0) > COALESCE(paid.total, 0)
      ORDER BY (COALESCE((l.estimate->>'total')::numeric,
                         (l.estimate->>'grandTotal')::numeric, 0) - COALESCE(paid.total, 0)) DESC`
  );
  const list = r.rows.map((x) => ({
    uhid: x.uhid, name: x.full_name, mobile: x.mobile || "",
    estimateTotal: Number(x.estimate_total), paid: Number(x.paid),
    outstanding: Number(x.estimate_total) - Number(x.paid)
  }));
  return {
    success: true, list, count: list.length,
    totalOutstanding: list.reduce((s, x) => s + x.outstanding, 0)
  };
};

actions.getFinanceSummary = async (p) => {
  const from = dateISO(p.fromDate) || `${new Date().getFullYear()}-01-01`;
  const to = dateISO(p.toDate) || dateISO(new Date());
  const income = await query(
    `SELECT COALESCE(sum(amount), 0) AS t, count(*)::int AS n
       FROM payments WHERE paid_on BETWEEN $1 AND $2`, [from, to]
  );
  const spend = await query(
    `SELECT COALESCE(sum(amount), 0) AS t, count(*)::int AS n
       FROM expenses WHERE spent_on BETWEEN $1 AND $2`, [from, to]
  );
  const byMode = await query(
    `SELECT mode, sum(amount) AS t FROM payments
      WHERE paid_on BETWEEN $1 AND $2 GROUP BY mode ORDER BY sum(amount) DESC`, [from, to]
  );
  const byMonth = await query(
    `SELECT to_char(paid_on, 'YYYY-MM') AS m, sum(amount) AS t FROM payments
      WHERE paid_on BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to]
  );
  return {
    success: true, fromDate: from, toDate: to,
    income: Number(income.rows[0].t), receiptCount: income.rows[0].n,
    expenses: Number(spend.rows[0].t), expenseCount: spend.rows[0].n,
    net: Number(income.rows[0].t) - Number(spend.rows[0].t),
    byMode: Object.fromEntries(byMode.rows.map((x) => [x.mode, Number(x.t)])),
    byMonth: byMonth.rows.map((x) => ({ month: x.m, total: Number(x.t) }))
  };
};

actions.getProfitLoss = async (p) => {
  const from = dateISO(p.fromDate) || `${new Date().getFullYear()}-01-01`;
  const to = dateISO(p.toDate) || dateISO(new Date());
  const income = await query(
    `SELECT COALESCE(sum(amount), 0) AS t FROM payments WHERE paid_on BETWEEN $1 AND $2`, [from, to]
  );
  const byCat = await query(
    `SELECT category, sum(amount) AS t FROM expenses
      WHERE spent_on BETWEEN $1 AND $2 GROUP BY category ORDER BY sum(amount) DESC`, [from, to]
  );
  const spend = byCat.rows.reduce((s, x) => s + Number(x.t), 0);
  return {
    success: true, fromDate: from, toDate: to,
    income: Number(income.rows[0].t), expenses: spend,
    profit: Number(income.rows[0].t) - spend,
    byCategory: byCat.rows.map((x) => ({ category: x.category, total: Number(x.t) }))
  };
};

// ── expenses ─────────────────────────────────────────────────────────────
actions.getExpenses = async (p) => {
  const params = [];
  const parts = [];
  if (dateISO(p.fromDate)) { params.push(dateISO(p.fromDate)); parts.push(`spent_on >= $${params.length}`); }
  if (dateISO(p.toDate)) { params.push(dateISO(p.toDate)); parts.push(`spent_on <= $${params.length}`); }
  if (nz(p.category)) { params.push(nz(p.category)); parts.push(`category = $${params.length}`); }
  const r = await query(
    `SELECT id, spent_on, category, amount, mode, payee, remarks FROM expenses
      ${parts.length ? `WHERE ${parts.join(" AND ")}` : ""}
      ORDER BY spent_on DESC, id DESC`,
    params
  );
  return {
    success: true,
    expenses: r.rows.map((x) => ({
      id: String(x.id), date: dateISO(x.spent_on), category: x.category,
      amount: Number(x.amount), mode: x.mode || "", payee: x.payee || "", remarks: x.remarks || ""
    }))
  };
};

actions.saveExpense = async (p) => {
  const amount = num(p.amount);
  if (amount === null || amount <= 0) return { success: false, error: "An expense needs an amount" };
  const r = await query(
    `INSERT INTO expenses (spent_on, category, amount, mode, payee, remarks)
     VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6) RETURNING id`,
    [dateISO(p.date) || null, String(p.category || "Other"), amount,
     nz(p.mode), nz(p.payee), nz(p.remarks)]
  );
  return { success: true, id: String(r.rows[0].id) };
};

actions.deleteExpense = async (p) => {
  const r = await query("DELETE FROM expenses WHERE id = $1 RETURNING id", [Number(p.id)]);
  if (!r.rowCount) return { success: false, error: "Expense not found" };
  return { success: true };
};

module.exports = { actions, receiptRow, RECEIPT_SELECT };
