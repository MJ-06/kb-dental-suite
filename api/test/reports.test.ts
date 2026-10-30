// Admin dashboards, reports and Excel export.
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createUser } from "../src/admin.js";
import { setTenant } from "../src/db/index.js";
import { REPORTS } from "../src/reports/reports.js";
import { buildWorkbook } from "../src/reports/xlsx.js";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, OWNER_URL, PASSWORD, signIn, type World } from "./setup.js";

let w: World;
let admin: string, betaAdmin: string;
const get = async (cookie: string, url: string) => w.app.inject({ url: `/api/v1/admin${url}`, headers: { cookie } });

/** Entries of an .xlsx (a zip with sizes in the local headers) by name. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50;) {
    const packed = buf.readUInt32LE(at + 18), nameLen = buf.readUInt16LE(at + 26), extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const start = at + 30 + nameLen + extraLen;
    out[name] = inflateRawSync(buf.subarray(start, start + packed)).toString("utf8");
    at = start + packed;
  }
  return out;
}

function sheetNames(workbookXml: string): string[] {
  return [...workbookXml.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

beforeAll(async () => {
  w = await makeWorld();
  for (const role of ["doctor", "accounts"] as const) {
    await createUser(OWNER_URL, w.clinicA, { username: `a-${role}`, displayName: role, password: PASSWORD, role });
  }
  admin = await signIn(w.app, "alpha", "a-admin");
  betaAdmin = await execLogin(w, "beta", "b-admin");
  const adminExec = await execLogin(w, "alpha", "a-admin");

  const receipt = (extra: Record<string, unknown>) =>
    exec(w, adminExec, "saveReceipt", { patientName: "Plain Patient", service: "RCT", mode1: "Cash", amount1: 100, date: "2025-04-01", ...extra });
  await receipt({ date: "2025-03-31", amount1: 1000 });                                                      // last day of FY 2024-25
  await receipt({ amount1: 500, mode2: "UPI", amount2: 250, patientName: "=SUM(1,1)", service: "Scaling" }); // first day of FY 2025-26, split payment
  await receipt({ date: "2026-04-10", amount1: 2000, service: "Implant" });                                   // FY 2026-27
  await exec(w, adminExec, "saveExpense", { date: "2025-05-02", expenseName: "Rent", amount: 300, paidBy: "Seeta", mode: "Cash" });
  await exec(w, adminExec, "saveExpense", { date: "2026-05-03", expenseName: "Lab", amount: 100, paidBy: "Seeta", mode: "UPI" });
  await exec(w, betaAdmin, "saveReceipt", { patientName: "Beta Person", service: "RCT", mode1: "Cash", amount1: 7777, date: "2025-06-01" });
});
afterAll(() => w.close());

describe("who may see it", () => {
  const urls = ["/reports", "/dashboard", "/reports/receipts", "/reports/receipts/xlsx", "/export/all"];

  it("lets only the admin in", async () => {
    for (const user of ["a-desk", "a-doctor", "a-accounts"]) {
      const cookie = await signIn(w.app, "alpha", user);
      for (const url of urls) expect((await get(cookie, url)).statusCode, `${user} ${url}`).toBe(403);
    }
    for (const url of urls) expect((await get(admin, url)).statusCode, url).toBe(200);
  });

  it("turns away someone who is signed out", async () => {
    expect((await w.app.inject({ url: "/api/v1/admin/dashboard" })).statusCode).toBe(401);
    expect((await w.app.inject({ url: "/api/v1/admin/reports/receipts/xlsx" })).statusCode).toBe(401);
  });

  it("serves the admin page, which holds no data itself", async () => {
    const res = await w.app.inject({ url: "/admin.html" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("script-src 'self' 'nonce-");
  });
});

describe("periods", () => {
  it("keeps a financial year to 1 April - 31 March", async () => {
    const res = (await get(admin, "/reports/receipts?fy=2025-26")).json();
    expect(res.rows.map((r: { date: string }) => r.date)).toEqual(["2025-04-01"]);
    expect(res.period).toMatchObject({ label: "FY 2025-26", from: "2025-04-01", to: "2026-03-31" });
    expect(res.totals.total).toBe(750);
  });

  it("takes a custom range and 'all'", async () => {
    expect((await get(admin, "/reports/receipts?from=2025-03-31&to=2025-04-01")).json().rows).toHaveLength(2);
    expect((await get(admin, "/reports/receipts?fy=all")).json().rows).toHaveLength(3);
  });

  it("refuses a period that makes no sense", async () => {
    for (const q of ["fy=2025-27", "fy=25-26", "from=2026-02-30", "from=2026-05-01&to=2026-04-01", "from=yesterday"]) {
      expect((await get(admin, `/reports/receipts?${q}`)).statusCode, q).toBe(400);
    }
    expect((await get(admin, "/dashboard?fy=nope")).statusCode).toBe(400);
    expect((await get(admin, "/reports/not-a-report")).statusCode).toBe(404);
  });
});

describe("the numbers", () => {
  it("adds collections up by year and by the mode actually used", async () => {
    const { rows, columns } = (await get(admin, "/reports/collections-by-fy")).json();
    expect(rows.map((r: { fy: string }) => r.fy)).toEqual(["FY 2026-27", "FY 2025-26", "FY 2024-25"]);
    expect(rows[1]).toMatchObject({ receipts: 1, total: 750, "mode:Cash": 500, "mode:UPI": 250 });
    expect(rows[0]).toMatchObject({ total: 2000, "mode:Cash": 2000, "mode:UPI": 0 });
    expect(columns.map((c: { key: string }) => c.key)).toContain("mode:UPI");
  });

  it("sets what came in against what went out, month by month", async () => {
    const { rows, totals } = (await get(admin, "/reports/profit-loss?fy=2025-26")).json();
    expect(rows).toMatchObject([
      { month: "Apr 2025", collected: 750, expenses: 0, net: 750 },
      { month: "May 2025", collected: 0, expenses: 300, net: -300 }
    ]);
    expect(totals).toMatchObject({ collected: 750, expenses: 300, net: 450 });
  });

  it("builds the dashboard for the chosen year", async () => {
    const d = (await get(admin, "/dashboard?fy=2025-26")).json();
    expect(d.kpis).toMatchObject({ collectedPeriod: 750, expensesPeriod: 300, netPeriod: 450 });
    expect(d.months).toHaveLength(12);
    expect(d.byMode).toEqual([{ mode: "Cash", amount: 500 }, { mode: "UPI", amount: 250 }]);
    expect(d.topServices[0]).toEqual({ service: "Scaling", amount: 750 });
    expect(d.fys).toContain("2024-25");
  });

  it("never mixes in another clinic's money", async () => {
    const mine = (await get(admin, "/reports/receipts?fy=all")).json();
    expect(JSON.stringify(mine)).not.toContain("Beta Person");
    const beta = await get(await signIn(w.app, "beta", "b-admin"), "/reports/receipts?fy=all");
    expect(beta.json().totals.total).toBe(7777);
    expect(beta.json().rows).toHaveLength(1);
  });

  it("runs every report without error", async () => {
    for (const r of REPORTS) {
      const res = await get(admin, `/reports/${r.id}?fy=all`);
      expect(res.statusCode, r.id).toBe(200);
      expect(res.json().columns.length, r.id).toBeGreaterThan(0);
    }
  });
});

describe("patients", () => {
  it("dates an imported patient by the month in the UHID, not by the day of the import", async () => {
    await w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      await sql`INSERT INTO patients (uhid, full_name) VALUES ('AE0117', 'Imported Patient')`.execute(tx);
    });
    const old = (await get(admin, "/reports/patients?fy=2018-19")).json();
    expect(old.rows).toMatchObject([{ uhid: "AE0117", name: "Imported Patient", registered: "2019-01-01" }]);
    expect((await get(admin, "/reports/patients?fy=2025-26")).json().rows).toHaveLength(0);
  });
});

describe("Excel export", () => {
  it("downloads a real workbook with a header, the rows and a total", async () => {
    const res = await get(admin, "/reports/receipts/xlsx?fy=2025-26");
    expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="kb-receipts-fy-2025-26.xlsx"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const files = unzip(res.rawPayload);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"]));
    const sheet = files["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain("Receipt no.");
    expect(sheet).toContain("<v>750</v>");
    expect(sheet).toContain(">Total<");
  });

  it("stores a patient called =SUM(1,1) as text, never a formula", async () => {
    const sheet = unzip((await get(admin, "/reports/receipts/xlsx?fy=2025-26")).rawPayload)["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toMatch(/t="inlineStr"><is><t xml:space="preserve">=SUM\(1,1\)</);
    expect(sheet).not.toContain("<f>");
  });

  it("puts every report on its own sheet in the combined workbook", async () => {
    const files = unzip((await get(admin, "/export/all?fy=2025-26")).rawPayload);
    expect(sheetNames(files["xl/workbook.xml"]!)).toHaveLength(REPORTS.length);
  });

  it("copes with awkward sheet names and characters", () => {
    const long = "very long sheet name that overflows the limit";
    const wb = unzip(buildWorkbook([
      { name: `A/B:C*D?[E]\\F ${long}`, columns: [{ key: "a", label: "A & <B>", type: "text" }], rows: [{ a: "x\u0001y \"q\" ü" }] },
      { name: `a/b:c*d?[e]\\f ${long}`, columns: [{ key: "a", label: "A", type: "text" }], rows: [] }
    ]));
    const names = sheetNames(wb["xl/workbook.xml"]!);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(2);
    for (const n of names) { expect(n.length).toBeLessThanOrEqual(31); expect(n).not.toMatch(/[[\]:*?/\\]/); }
    expect(wb["xl/worksheets/sheet1.xml"]).toContain("xy &quot;q&quot; ü");
    expect(wb["xl/worksheets/sheet1.xml"]).toContain("A &amp; &lt;B&gt;");
  });
});
