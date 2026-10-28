// Receipts, collections, expenses, profit and loss and balances through /exec.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTenant } from "../src/db/index.js";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

let w: World;
let admin: string;
let desk: string;
let betaAdmin: string;
let uhid: string;

beforeAll(async () => {
  w = await makeWorld();
  admin = await execLogin(w, "alpha", "a-admin");
  desk = await execLogin(w, "alpha", "a-desk");
  betaAdmin = await execLogin(w, "beta", "b-admin");
  ({ uhid } = await exec(w, desk, "getNextUHID"));
  await exec(w, desk, "saveRegistration", { uhid, name: "Finance Patient", mobile: "9822200000" });
});
afterAll(() => w.close());

const receipt = (extra: Record<string, unknown>) =>
  exec(w, desk, "saveReceipt", { uhid, patientName: "Finance Patient", service: "RCT", mode1: "Cash", amount1: 1000, date: "2026-10-05", ...extra });

describe("receipts", () => {
  it("numbers receipts in a running series and keeps both halves of a split payment", async () => {
    const a = await receipt({});
    const b = await receipt({ mode1: "Cash", amount1: 500, mode2: "UPI", amount2: "250.50", date: "2026-10-06" });
    expect(a).toMatchObject({ success: true, receiptNo: 1 });
    expect(b).toMatchObject({ success: true, receiptNo: 2 });
    const list = (await exec(w, desk, "getReceipts", { uhid })).receipts;
    expect(list[0]).toMatchObject({ date: "2026-10-06", uhid, patientName: "Finance Patient", mode: "Cash + UPI", fee: 750.5, receiptNo: 2 });
    expect(list[1]).toMatchObject({ date: "2026-10-05", mode: "Cash", fee: 1000, service: "RCT" });
  });

  it("takes the patient's name from the register when the form left it empty", async () => {
    await receipt({ patientName: "", date: "2026-10-07", amount1: 1 });
    const first = (await exec(w, desk, "getReceipts", { uhid })).receipts[0];
    expect(first.patientName).toBe("Finance Patient");
  });

  it("refuses nothing paid, a negative amount and a second amount with no mode", async () => {
    expect((await receipt({ amount1: 0 })).error).toBe("Enter the amount received");
    expect((await receipt({ amount1: -5 })).error).toBe("An amount cannot be negative");
    expect((await receipt({ amount2: 40, mode2: "" })).error).toBe("Choose the payment mode for the second amount");
  });

  it("accepts a walk-in with no UHID", async () => {
    const res = await exec(w, desk, "saveReceipt", { patientName: "Walk In", service: "Scaling", mode1: "UPI", amount1: 300, date: "2026-10-08" });
    expect(res.success).toBe(true);
  });

  it("lets reception see one patient's receipts but not the clinic's", async () => {
    expect((await exec(w, desk, "getReceipts", { uhid })).success).toBe(true);
    expect(await exec(w, desk, "getReceipts", {})).toMatchObject({ success: false, forbidden: true });
    expect((await exec(w, admin, "getReceipts", { fromDate: "2026-10-01", toDate: "2026-10-31" })).receipts).toHaveLength(4);
  });

  it("keeps clinics apart, each with its own numbers", async () => {
    const res = await exec(w, betaAdmin, "saveReceipt", { patientName: "Beta Person", mode1: "Cash", amount1: 10, date: "2026-10-05" });
    expect(res.receiptNo).toBe(1);
    expect((await exec(w, betaAdmin, "getReceipts", {})).receipts).toHaveLength(1);
  });
});

describe("collections", () => {
  it("adds a day or a range up by payment mode", async () => {
    const day = await exec(w, admin, "getDailyCollection", { date: "2026-10-06" });
    expect(day).toMatchObject({ total: 750.5, count: 1, byMode: { "Cash + UPI": 750.5 } });
    const range = await exec(w, admin, "getDailyCollection", { fromDate: "2026-10-05", toDate: "2026-10-08" });
    expect(range.total).toBe(1000 + 750.5 + 1 + 300);
    expect(range.byMode).toMatchObject({ Cash: 1001, UPI: 300 });
  });

  it("reports revenue per patient", async () => {
    const res = await exec(w, admin, "getRevenueByPatient", {});
    expect(res.revenue[uhid]).toBe(1751.5);
    expect(res.receipts).toBe(3);
  });

  it("summarises today, the month and the April-March year", async () => {
    await receipt({ date: "", amount1: 70 });
    const s = await exec(w, admin, "getFinanceSummary", {});
    expect(s.todayTotal).toBe(70);
    expect(s.allTimeTotal).toBe(1000 + 750.5 + 1 + 300 + 70);
    expect(s.totalReceipts).toBe(5);
    expect(s.fyLabel).toMatch(/^FY \d{4}-\d{2}$/);
    expect(s.recent).toHaveLength(5);
    expect(s.recent[0].date >= s.recent[1].date).toBe(true);
  });

  it("keeps collections from reception", async () => {
    expect(await exec(w, desk, "getDailyCollection", { date: "2026-10-06" })).toMatchObject({ success: false, forbidden: true });
    expect(await exec(w, desk, "getFinanceSummary")).toMatchObject({ success: false, forbidden: true });
  });
});

describe("expenses and profit and loss", () => {
  it("records, lists and voids an expense", async () => {
    const saved = await exec(w, admin, "saveExpense", { date: "2026-10-07", paidBy: "Dr. A", expenseName: "Lab bill", amount: 400, mode: "Cash", remarks: "crowns" });
    expect(saved.success).toBe(true);
    const list = (await exec(w, admin, "getExpenses", {})).expenses;
    expect(list[0]).toMatchObject({ id: saved.id, date: "2026-10-07", paidBy: "Dr. A", expenseName: "Lab bill", amount: 400, mode: "Cash", remarks: "crowns" });
    expect((await exec(w, admin, "deleteExpense", { id: saved.id })).success).toBe(true);
    expect((await exec(w, admin, "getExpenses", {})).expenses).toHaveLength(0);
    expect((await exec(w, admin, "deleteExpense", { id: saved.id })).success).toBe(false);
  });

  it("refuses an expense with no amount and keeps reception out", async () => {
    expect((await exec(w, admin, "saveExpense", { expenseName: "Nothing" })).error).toBe("Enter the amount spent");
    expect(await exec(w, desk, "saveExpense", { expenseName: "x", amount: 5 })).toMatchObject({ forbidden: true });
  });

  it("buckets income and expense by week (Monday start) and by month", async () => {
    await exec(w, admin, "saveExpense", { date: "2026-10-07", expenseName: "Consumables", amount: 200 });
    const weekly = await exec(w, admin, "getProfitLoss", { mode: "weekly", periods: 60 });
    const wk = weekly.series.find((x: { key: string }) => x.key === "2026-10-05");
    expect(wk).toMatchObject({ income: 1000 + 750.5 + 1 + 300, expense: 200, label: "05 Oct – 11 Oct" });
    expect(weekly.series.filter((x: { isCurrent: boolean }) => x.isCurrent)).toHaveLength(1);
    expect(weekly.expenseTracked).toBe(true);
    const monthly = await exec(w, admin, "getProfitLoss", { mode: "monthly", periods: 24 });
    const oct = monthly.series.find((x: { key: string }) => x.key === "2026-10");
    expect(oct).toMatchObject({ expense: 200, label: "October 2026" });
    expect(oct.net).toBe(oct.income - 200);
    expect(new Set(monthly.series.map((x: { key: string }) => x.key)).size).toBe(24);
  });
});

describe("labels and the signed-in user", () => {
  it("spells every week and month the same way on every machine", async () => {
    const weekly = await exec(w, admin, "getProfitLoss", { mode: "weekly", periods: 60 });
    for (const x of weekly.series) expect(x.label).toMatch(/^\d{2} [A-Z][a-z]{2} – \d{2} [A-Z][a-z]{2}$/);
    expect(weekly.series.some((x: { label: string }) => x.label.includes(" Sep"))).toBe(true);
    const monthly = await exec(w, admin, "getProfitLoss", { mode: "monthly", periods: 24 });
    expect(monthly.series.some((x: { label: string }) => x.label.startsWith("September "))).toBe(true);
  });

  it("tells the dashboard who is signed in", async () => {
    expect(await exec(w, admin, "whoAmI")).toEqual({ success: true, name: "a admin", role: "admin", clinic: "Alpha Dental" });
    expect(await exec(w, desk, "whoAmI")).toMatchObject({ role: "reception" });
  });
});

describe("balances", () => {
  const PAID = 1000 + 750.5 + 1 + 70;

  it("shows no estimate until a plan is saved", async () => {
    expect(await exec(w, desk, "getPatientOutstanding", { uhid })).toMatchObject({ estimateTotal: 0, paid: PAID, outstanding: -PAID });
    expect((await exec(w, admin, "getOutstandingList", {})).count).toBe(0);
  });

  it("measures what was paid against the plan's estimate", async () => {
    const saved = await exec(w, admin, "saveTreatmentPlan", {
      uhid, patientName: "Finance Patient", date: "2026-10-01", rows: [{ tooth: "16", procedure: "RCT" }], estimate: { total: "Rs 5,000" }
    });
    expect(saved.success).toBe(true);
    expect(await exec(w, desk, "getPatientOutstanding", { uhid: uhid.toLowerCase() }))
      .toMatchObject({ uhid, estimateTotal: 5000, paid: PAID, outstanding: 5000 - PAID });
    const list = await exec(w, admin, "getOutstandingList", {});
    expect(list).toMatchObject({ count: 1, totalOutstanding: 5000 - PAID });
    expect(list.list[0]).toMatchObject({ uhid, patientName: "Finance Patient", estimateTotal: 5000 });
  });

  it("saves the plan once per patient, and reads it back", async () => {
    await exec(w, admin, "saveTreatmentPlan", { uhid, patientName: "Finance Patient", rows: [], estimate: { total: 1500 } });
    const plan = await exec(w, admin, "getTreatmentPlan", { uhid });
    expect(plan).toMatchObject({ rows: [], estimate: { total: 1500 } });
    expect((await exec(w, admin, "getOutstandingList", {})).count).toBe(0); // fully covered now
    expect(await exec(w, admin, "getTreatmentPlan", { uhid: "NOPE" })).toMatchObject({ rows: null, estimate: null });
  });

  it("refuses a damaged plan instead of saving nothing", async () => {
    const res = await w.app.inject({ url: "/exec", query: { action: "saveTreatmentPlan", uhid, rows: "[{oops", estimate: "{}" }, headers: { cookie: admin } });
    expect(res.json()).toMatchObject({ success: false, error: expect.stringMatching(/damaged/) });
  });

  it("refuses an estimate total that is not money, so no balance query can be broken by it", async () => {
    for (const total of ["1.2.3", "lots", "-5", "9".repeat(400)]) {
      const res = await exec(w, admin, "saveTreatmentPlan", { uhid, rows: [], estimate: { total } });
      expect(res).toMatchObject({ success: false, error: "The estimate total must be an amount of money" });
    }
    expect((await exec(w, admin, "getOutstandingList", {})).success).toBe(true);
  });

  it("reads a damaged total already in the books as nothing owed, instead of failing the list", async () => {
    await w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      const plans = [["BAD1", "12-34"], ["BAD2", "1.2.3"], ["BAD3", "9".repeat(61)], ["GOOD1", "Rs 2,500.50"]]
        .map(([uhid, total]) => ({ uhid, patient_name: uhid, estimate: { total } }));
      await sql`INSERT INTO treatment_plans (uhid, patient_name, estimate)
        SELECT uhid, patient_name, estimate FROM jsonb_to_recordset(${JSON.stringify(plans)}::jsonb)
          AS t(uhid text, patient_name text, estimate jsonb)`.execute(tx);
    });
    const list = await exec(w, admin, "getOutstandingList", {});
    expect(list.success).toBe(true);
    expect(list.list.map((x: { uhid: string }) => x.uhid)).toEqual(["GOOD1"]);
    expect(list.list[0].estimateTotal).toBe(2500.5);
  });

  it("keeps the balances of one clinic from another", async () => {
    expect((await exec(w, betaAdmin, "getPatientOutstanding", { uhid })).estimateTotal).toBe(0);
  });
});
