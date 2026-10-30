// Admin data visibility: a dashboard, a list of reports, each report as JSON
// or as an Excel file, and one workbook with every report.
//
// Admin only: every route needs "reports:read", which no other role has.
// The Excel files can hold patient names and phone numbers, so each export
// is recorded in the system log with who took it.
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import type { AppOptions } from "../app.js";
import { asActor } from "../http/context.js";
import { HttpError, notFound } from "../http/errors.js";
import { buildDashboard, BadPeriod, REPORTS, reportById, resolvePeriod, withTotalRow, type Period } from "../reports/reports.js";
import { buildWorkbook } from "../reports/xlsx.js";
import { recordEvent } from "../syslog.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PeriodQuery = Type.Object({
  fy: Type.Optional(Type.String({ maxLength: 8 })),
  from: Type.Optional(Type.String({ maxLength: 10 })),
  to: Type.Optional(Type.String({ maxLength: 10 }))
});

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const adminReportRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, opts) => {
  const { db } = opts;
  const limited = { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } };

  async function periodOf(tx: Tx, q: { fy?: string; from?: string; to?: string }): Promise<Period> {
    const today = (await sql<{ d: string }>`SELECT clinic_today()::text AS d`.execute(tx)).rows[0]!.d;
    try { return resolvePeriod(q, today); } catch (e) {
      if (e instanceof BadPeriod) throw new HttpError(400, "bad_period", e.message);
      throw e;
    }
  }

  app.get("/reports", async (req) => asActor(db, req, "reports:read", async () => ({
    reports: REPORTS.map((r) => ({ id: r.id, title: r.title, group: r.group, about: r.about, allYears: !!r.allYears }))
  })));

  app.get("/dashboard", { ...limited, schema: { querystring: Type.Object({ fy: Type.Optional(Type.String({ maxLength: 8 })) }) } }, async (req) =>
    asActor(db, req, "reports:read", async (tx, actor) => {
      const today = (await sql<{ d: string }>`SELECT clinic_today()::text AS d`.execute(tx)).rows[0]!.d;
      try { resolvePeriod({ fy: req.query.fy }, today); } catch (e) {
        if (e instanceof BadPeriod) throw new HttpError(400, "bad_period", e.message);
        throw e;
      }
      return buildDashboard(tx, actor.timezone, req.query);
    }));

  app.get("/reports/:id", { ...limited, schema: { params: Type.Object({ id: Type.String({ maxLength: 60 }) }), querystring: PeriodQuery } }, async (req) =>
    asActor(db, req, "reports:read", async (tx, actor) => {
      const def = reportById(req.params.id);
      if (!def) throw notFound("report");
      const period = def.allYears ? { label: "All years", from: null, to: null } : await periodOf(tx, req.query);
      const res = await def.run({ tx, tz: actor.timezone, period });
      return { id: def.id, title: def.title, about: def.about, period, allYears: !!def.allYears, ...res };
    }));

  app.get("/reports/:id/xlsx", { ...limited, schema: { params: Type.Object({ id: Type.String({ maxLength: 60 }) }), querystring: PeriodQuery } }, async (req, reply) => {
    const out = await asActor(db, req, "reports:read", async (tx, actor) => {
      const def = reportById(req.params.id);
      if (!def) throw notFound("report");
      const period = def.allYears ? { label: "All years", from: null, to: null } : await periodOf(tx, req.query);
      const res = await def.run({ tx, tz: actor.timezone, period });
      await recordEvent(tx, "export", "report.xlsx", `${actor.username} exported ${def.title} (${period.label})`, { user: actor.username, report: def.id, period: period.label, rows: res.rows.length });
      const note = `${def.title} - ${period.label}${res.truncated ? ` - first ${res.rows.length} rows only, narrow the dates for the rest` : ""}`;
      return { file: buildWorkbook([{ name: def.title, columns: res.columns, rows: withTotalRow(res), note }]), name: `kb-${def.id}-${safeName(period.label)}.xlsx` };
    });
    return reply.type(XLSX).header("Content-Disposition", `attachment; filename="${out.name}"`).header("Cache-Control", "no-store").send(out.file);
  });

  app.get("/export/all", { ...limited, schema: { querystring: PeriodQuery } }, async (req, reply) => {
    const out = await asActor(db, req, "reports:read", async (tx, actor) => {
      const period = await periodOf(tx, req.query);
      const sheets = [];
      for (const def of REPORTS) {
        const p = def.allYears ? { label: "All years", from: null, to: null } : period;
        const res = await def.run({ tx, tz: actor.timezone, period: p });
        sheets.push({ name: def.title, columns: res.columns, rows: withTotalRow(res), note: `${def.title} - ${p.label}${res.truncated ? " - truncated" : ""}` });
      }
      await recordEvent(tx, "export", "report.xlsx", `${actor.username} exported every report (${period.label})`, { user: actor.username, report: "all", period: period.label });
      return { file: buildWorkbook(sheets), name: `kb-all-reports-${safeName(period.label)}.xlsx` };
    });
    return reply.type(XLSX).header("Content-Disposition", `attachment; filename="${out.name}"`).header("Cache-Control", "no-store").send(out.file);
  });
};
