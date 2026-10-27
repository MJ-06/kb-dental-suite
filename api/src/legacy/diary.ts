// The appointment diary, blocked slots, the Daily Register and the follow-up
// lists, answering as the live Apps Script does.
//
// Dates and times on the screens are the clinic's own ("2026-11-06",
// "10:30"); in the database they are instants, converted with the clinic's
// timezone in both directions, so a server in another country changes
// nothing at the desk.
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { getSetting } from "./masters.js";
import { read, write, DeskError, type ActionTable } from "./types.js";
import { hhmm, isoDay, nz, str, uhidOf } from "./util.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Diwali (holiday)" or "Sunday (weekly off)" when the clinic is shut that day, else "". */
async function closedReason(tx: Tx, date: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const h = await sql<{ name: string }>`SELECT name FROM holidays WHERE holiday_date = ${date}`.execute(tx);
  if (h.rows[0]) return `${h.rows[0].name || "Holiday"} (holiday)`;
  const weekOff = (await getSetting<number[]>(tx, "week_off")) ?? [];
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  return weekOff.includes(day) ? `${WEEKDAYS[day]} (weekly off)` : "";
}

async function slotMinutes(tx: Tx): Promise<number> {
  const t = await getSetting<{ slotMinutes?: number }>(tx, "clinic_timings");
  return t?.slotMinutes && t.slotMinutes > 0 ? t.slotMinutes : 30;
}

async function idOfNamed(tx: Tx, table: "doctors" | "chairs", name: string | null): Promise<string | null> {
  if (!name) return null;
  const r = await sql<{ id: string }>`SELECT id FROM ${sql.table(table)} WHERE lower(name) = ${name.toLowerCase()} AND active`.execute(tx);
  return r.rows[0]?.id ?? null;
}

async function patientIdOf(tx: Tx, uhid: string): Promise<string | null> {
  if (!uhid) return null;
  return (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0]?.id ?? null;
}

/** Finds a booking by the id the screen holds: ours, or the sheet's APT-… */
async function findAppt(tx: Tx, apptId: string): Promise<string | null> {
  const r = await sql<{ id: string }>`
    SELECT id FROM appointments WHERE id::text = ${apptId} OR legacy_id = ${apptId}`.execute(tx);
  return r.rows[0]?.id ?? null;
}

function stages(v: unknown): string {
  if (v === undefined || v === null || v === "") return "[]";
  if (typeof v === "string") { try { return JSON.stringify(JSON.parse(v)); } catch { return "[]"; } }
  return JSON.stringify(v);
}

// The visit's line through the day, and the stamp each step sets.
const STEPS = ["Scheduled", "Checked In", "In Chair", "Completed"] as const;
const STAMPS = ["", "checkin_at", "engaged_at", "checkout_at"] as const;

interface ApptRow {
  id: string; legacy_id: string | null; date: string; time: string; uhid: string | null; patient_name: string;
  reason: string; sub_type: string | null; doctor: string | null; chair: string | null; mobile: string | null;
  notes: string | null; status: string; checkin: string | null; engaged: string | null; checkout: string | null;
  cancel_reason: string | null; case_ref: string | null; procedure_code: string | null; procedure_name: string | null;
  family_code: string | null; planned_stages: unknown; completed_stages: unknown; visit_counter: string | null;
}

function apptOut(a: ApptRow) {
  return {
    id: a.legacy_id ?? a.id, date: a.date, uhid: a.uhid ?? "", patientName: a.patient_name, time: a.time,
    type: a.reason, subType: a.sub_type ?? "", doctor: a.doctor ?? "", chair: a.chair ?? "", mobile: a.mobile ?? "",
    notes: a.notes ?? "", status: a.status, checkinTime: a.checkin ?? "", engagedTime: a.engaged ?? "",
    checkoutTime: a.checkout ?? "", cancelReason: a.cancel_reason ?? "", caseId: a.case_ref ?? "",
    procedureCode: a.procedure_code ?? "", procedureName: a.procedure_name ?? "", familyCode: a.family_code ?? "",
    plannedStages: a.planned_stages ?? [], completedStages: a.completed_stages ?? [], visitCounter: a.visit_counter ?? ""
  };
}

// ── the register's merge rules, as the sheet had them ────────────────────
const combine = (oldV: unknown, newV: unknown) => {
  const o = str(oldV), n = str(newV);
  if (!n) return o;
  if (!o) return n;
  return o.split(/\s*\|\s*/).includes(n) ? o : `${o} | ${n}`;
};
const preferLatest = (oldV: unknown, newV: unknown) => str(newV) || str(oldV);
const keepFirst = (oldV: unknown, newV: unknown) => str(oldV) || str(newV);

export const diary: ActionTable = {
  getAppointments: read(async (p, { tx, actor }) => {
    const date = isoDay(p.date), from = isoDay(p.fromDate), to = isoDay(p.toDate);
    const tz = actor.timezone;
    const day = sql`(a.starts_at AT TIME ZONE ${tz})::date`;
    const where = date ? sql`${day} = ${date}::date`
      : from || to ? sql`(${from || null}::date IS NULL OR ${day} >= ${from || null}::date) AND (${to || null}::date IS NULL OR ${day} <= ${to || null}::date)`
      : sql`true`;
    const hm = (c: string) => sql`to_char(${sql.ref(c)} AT TIME ZONE ${tz}, 'HH24:MI')`;
    const r = await sql<ApptRow>`
      SELECT a.id, a.legacy_id, ${day}::text AS date, to_char(a.starts_at AT TIME ZONE ${tz}, 'HH24:MI') AS time,
             p.uhid, a.patient_name, a.reason, a.sub_type, coalesce(d.name, a.doctor_name) AS doctor,
             coalesce(c.name, a.chair_name) AS chair, a.mobile, a.notes, a.status,
             ${hm("a.checkin_at")} AS checkin, ${hm("a.engaged_at")} AS engaged, ${hm("a.checkout_at")} AS checkout,
             a.cancel_reason, a.case_ref, a.procedure_code, a.procedure_name, a.family_code, a.planned_stages,
             a.completed_stages, a.visit_counter
        FROM appointments a
        LEFT JOIN patients p ON p.id = a.patient_id
        LEFT JOIN doctors d ON d.id = a.doctor_id
        LEFT JOIN chairs c ON c.id = a.chair_id
       WHERE ${where}
       ORDER BY a.starts_at`.execute(tx);
    return { success: true, appointments: r.rows.map(apptOut) };
  }, "appointments:read"),

  saveAppointment: write("appointments:write", async (p, { tx, actor }) => {
    const date = isoDay(p.date);
    if (!date) throw new DeskError("Choose the date of the appointment");
    if (!p.walkIn || p.walkIn === "false") {
      const shut = await closedReason(tx, date);
      if (shut) return { success: false, error: `The clinic is closed on ${p.date} — ${shut}` };
    }
    const time = hhmm(p.time) || "00:00";
    const uhid = uhidOf(p.uhid);
    const doctor = nz(p.doctor), chair = nz(p.chair);
    const minutes = await slotMinutes(tx);
    const r = await sql<{ id: string }>`
      INSERT INTO appointments (patient_id, patient_name, mobile, starts_at, ends_at, reason, sub_type,
                                doctor_id, doctor_name, chair_id, chair_name, notes, status, walk_in,
                                case_ref, procedure_code, procedure_name, family_code, planned_stages, visit_counter)
      VALUES (${await patientIdOf(tx, uhid)}, ${str(p.patientName) || uhid || "Walk-in"}, ${nz(p.mobile)},
              (${date}::date + ${time}::time) AT TIME ZONE ${actor.timezone},
              (${date}::date + ${time}::time) AT TIME ZONE ${actor.timezone} + make_interval(mins => ${minutes}),
              ${str(p.type) || "Consultation"}, ${nz(p.subType)},
              ${await idOfNamed(tx, "doctors", doctor)}, ${doctor}, ${await idOfNamed(tx, "chairs", chair)}, ${chair},
              ${nz(p.notes)}, ${str(p.status) || "Scheduled"}, ${!!p.walkIn && p.walkIn !== "false"},
              ${nz(p.caseId)}, ${nz(p.procedureCode)}, ${nz(p.procedureName)}, ${nz(p.familyCode)},
              ${stages(p.plannedStages)}::jsonb, ${nz(p.visitCounter)})
      RETURNING id`.execute(tx);
    return { success: true, id: r.rows[0]!.id };
  }),

  updateAppointmentStatus: write("appointments:write", async (p, { tx }) => {
    const apptId = str(p.apptId);
    const id = await findAppt(tx, apptId);
    if (!id) return { success: false, error: `Appointment not found: ${apptId}` };
    const status = str(p.status);
    const step = STEPS.indexOf(status as (typeof STEPS)[number]);
    const cancelReason = nz(p.cancelReason);
    if (status === "Cancelled" && !cancelReason) throw new DeskError("Give a reason for the cancellation");

    const sets = [sql`status = ${status}`];
    if (step >= 0) {
      // Moving back clears the later stamps; moving forward stamps this step
      // and any earlier one that was skipped (a visit completed straight from
      // the diary was checked in at that moment too).
      for (let k = 1; k < STAMPS.length; k++) {
        const c = sql.ref(STAMPS[k]!);
        sets.push(k <= step ? sql`${c} = coalesce(${c}, now())` : sql`${c} = NULL`);
      }
      sets.push(sql`cancel_reason = ${cancelReason}`);
    } else if (cancelReason) {
      sets.push(sql`cancel_reason = ${cancelReason}`);
    }
    await sql`UPDATE appointments SET ${sql.join(sets)} WHERE id = ${id}`.execute(tx);
    return { success: true };
  }),

  updateAppointment: write("appointments:write", async (p, { tx, actor }) => {
    const date = isoDay(p.date);
    if ((!p.walkIn || p.walkIn === "false") && date) {
      const shut = await closedReason(tx, date);
      if (shut) return { success: false, error: `The clinic is closed on ${p.date} — ${shut}` };
    }
    const apptId = str(p.apptId);
    const id = await findAppt(tx, apptId);
    if (!id) return { success: false, error: `Appointment not found: ${apptId}` };

    // Only what was sent changes, as in the sheet.
    const sets = [];
    const given = (k: string) => p[k] !== undefined && p[k] !== null;
    if (date || given("time")) {
      const cur = (await sql<{ d: string; t: string; mins: number }>`
        SELECT (starts_at AT TIME ZONE ${actor.timezone})::date::text AS d,
               to_char(starts_at AT TIME ZONE ${actor.timezone}, 'HH24:MI') AS t,
               extract(epoch FROM ends_at - starts_at)::int / 60 AS mins
          FROM appointments WHERE id = ${id}`.execute(tx)).rows[0]!;
      const d = date || cur.d, t = hhmm(p.time) || cur.t;
      sets.push(sql`starts_at = (${d}::date + ${t}::time) AT TIME ZONE ${actor.timezone}`);
      sets.push(sql`ends_at = (${d}::date + ${t}::time) AT TIME ZONE ${actor.timezone} + make_interval(mins => ${cur.mins})`);
    }
    if (given("type")) sets.push(sql`reason = ${str(p.type)}`);
    if (given("subType")) sets.push(sql`sub_type = ${nz(p.subType)}`);
    if (given("doctor")) sets.push(sql`doctor_name = ${nz(p.doctor)}, doctor_id = ${await idOfNamed(tx, "doctors", nz(p.doctor))}`);
    if (given("chair")) sets.push(sql`chair_name = ${nz(p.chair)}, chair_id = ${await idOfNamed(tx, "chairs", nz(p.chair))}`);
    if (given("notes")) sets.push(sql`notes = ${nz(p.notes)}`);
    if (given("uhid")) sets.push(sql`patient_id = ${await patientIdOf(tx, uhidOf(p.uhid))}`);
    if (given("patientName")) sets.push(sql`patient_name = ${str(p.patientName)}`);
    if (given("caseId")) sets.push(sql`case_ref = ${nz(p.caseId)}`);
    if (given("procedureCode")) sets.push(sql`procedure_code = ${nz(p.procedureCode)}`);
    if (given("procedureName")) sets.push(sql`procedure_name = ${nz(p.procedureName)}`);
    if (given("familyCode")) sets.push(sql`family_code = ${nz(p.familyCode)}`);
    if (p.plannedStages) sets.push(sql`planned_stages = ${stages(p.plannedStages)}::jsonb`);
    if (sets.length) await sql`UPDATE appointments SET ${sql.join(sets)} WHERE id = ${id}`.execute(tx);
    return { success: true };
  }),

  deleteAppointment: write("appointments:write", async (p, { tx }) => {
    const apptId = str(p.apptId);
    const id = await findAppt(tx, apptId);
    if (!id) return { success: false, error: `Appointment not found: ${apptId}` };
    // The audit log keeps the whole row, so a deleted booking can be found.
    await sql`DELETE FROM appointments WHERE id = ${id}`.execute(tx);
    return { success: true };
  }),

  getBlockedSlots: read(async (p, { tx }) => {
    const date = isoDay(p.date);
    const r = await sql<{ id: string; legacy_id: string | null; d: string; block_type: string; chair_name: string | null;
      doctor_name: string | null; from_time: string | null; to_time: string | null; reason: string | null }>`
      SELECT id, legacy_id, block_date::text AS d, block_type, chair_name, doctor_name, from_time, to_time, reason
        FROM blocked_slots WHERE ${date || null}::date IS NULL OR block_date = ${date || null}::date
       ORDER BY block_date, from_time`.execute(tx);
    return { success: true, blocks: r.rows.map((b) => ({
      date: b.d, chair: b.chair_name ?? "", fromTime: b.from_time ?? "", toTime: b.to_time ?? "", reason: b.reason ?? "",
      id: b.legacy_id ?? b.id, blockType: b.block_type, doctor: b.doctor_name ?? "" })) };
  }, "appointments:read"),

  saveBlockedSlot: write("appointments:write", async (p, { tx }) => {
    const date = isoDay(p.date);
    if (!date) throw new DeskError("Choose the date to block");
    const type = ["chair", "doctor", "clinic"].includes(str(p.blockType)) ? str(p.blockType) : "chair";
    const r = await sql<{ id: string }>`
      INSERT INTO blocked_slots (block_date, block_type, chair_name, doctor_name, from_time, to_time, reason)
      VALUES (${date}, ${type}, ${nz(p.chair)}, ${nz(p.doctor)}, ${hhmm(p.fromTime) || null}, ${hhmm(p.toTime) || null}, ${nz(p.reason)})
      RETURNING id`.execute(tx);
    return { success: true, id: r.rows[0]!.id };
  }),

  deleteBlockedSlot: write("appointments:write", async (p, { tx }) => {
    const id = str(p.id);
    const r = await sql`DELETE FROM blocked_slots WHERE id::text = ${id} OR legacy_id = ${id} RETURNING id`.execute(tx);
    return r.rows.length ? { success: true } : { success: false, error: `Block not found: ${id}` };
  }),

  getDailyRegister: read(async (p, { tx }) => {
    const from = isoDay(p.fromDate) || null, to = isoDay(p.toDate) || null;
    const r = await sql<Record<string, string | null>>`
      SELECT month, visit_date::text AS date, uhid, patient_name, phone_no, age, time_walk_in, consultation_time, tat,
             initial_assessment, care_plan_documented, procedure_done, tooth_no, work_done, operating_doctor,
             delay_reason, mode_of_payment
        FROM daily_register
       WHERE (${from}::date IS NULL OR visit_date >= ${from}::date) AND (${to}::date IS NULL OR visit_date <= ${to}::date)
       ORDER BY visit_date, serial_no`.execute(tx);
    const s = (v: string | null | undefined) => v ?? "";
    return { success: true, entries: r.rows.map((x) => ({
      month: s(x.month), date: s(x.date), uhid: s(x.uhid), patientName: s(x.patient_name), phoneNo: s(x.phone_no),
      age: s(x.age), timeWalkIn: s(x.time_walk_in), consultationTime: s(x.consultation_time), tat: s(x.tat),
      initialAssessment: s(x.initial_assessment), carePlanDocumented: s(x.care_plan_documented),
      procedureDone: s(x.procedure_done), toothNo: s(x.tooth_no), workDone: s(x.work_done),
      operatingDoctor: s(x.operating_doctor), delayReason: s(x.delay_reason), modeOfPayment: s(x.mode_of_payment) })) };
  }, "appointments:read"),

  // The desk records the walk-in and payment; the clinician's forms add the
  // work done. Both roles keep the diary, so both may write here.
  saveToDailyRegister: write("appointments:write", async (p, { tx }) => {
    const date = isoDay(p.date) || (await sql<{ d: string }>`SELECT clinic_today()::text AS d`.execute(tx)).rows[0]!.d;
    const uhid = uhidOf(p.uhid);
    const month = str(p.month) || new Date(date + "T12:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    // The row for this patient today, locked, so two screens adding to the
    // same visit at once both land.
    const cur = uhid
      ? (await sql<Record<string, string | null> & { id: string }>`
          SELECT * FROM daily_register WHERE uhid = ${uhid} AND visit_date = ${date} FOR UPDATE`.execute(tx)).rows[0]
      : undefined;
    const v = {
      month: cur ? keepFirst(cur.month, month) : month,
      patient_name: keepFirst(cur?.patient_name, p.patientName),
      phone_no: keepFirst(cur?.phone_no, p.phoneNo),
      age: keepFirst(cur?.age, p.age),
      time_walk_in: keepFirst(cur?.time_walk_in, p.timeWalkIn),
      consultation_time: keepFirst(cur?.consultation_time, p.consultationTime),
      tat: keepFirst(cur?.tat, p.tat),
      initial_assessment: preferLatest(cur?.initial_assessment, p.initialAssessment),
      care_plan_documented: preferLatest(cur?.care_plan_documented, p.carePlanDocumented),
      procedure_done: combine(cur?.procedure_done, p.procedureDone),
      tooth_no: combine(cur?.tooth_no, p.toothNo),
      work_done: combine(cur?.work_done, p.workDone),
      operating_doctor: combine(cur?.operating_doctor, p.operatingDoctor),
      delay_reason: keepFirst(cur?.delay_reason, p.delayReason),
      mode_of_payment: combine(cur?.mode_of_payment, p.modeOfPayment)
    };
    const cols = Object.keys(v) as (keyof typeof v)[];
    if (cur) {
      await sql`UPDATE daily_register SET ${sql.join(cols.map((c) => sql`${sql.ref(c)} = ${v[c] || null}`))}
                 WHERE id = ${cur.id}`.execute(tx);
      return { success: true, merged: true, row: cur.id };
    }
    const serial = Number((await sql<{ n: string }>`SELECT count(*) + 1 AS n FROM daily_register`.execute(tx)).rows[0]!.n);
    await sql`INSERT INTO daily_register (visit_date, uhid, patient_id, serial_no, ${sql.join(cols.map((c) => sql.ref(c)))})
              VALUES (${date}, ${uhid || null}, ${await patientIdOf(tx, uhid)}, ${serial},
                      ${sql.join(cols.map((c) => v[c] || null))})`.execute(tx);
    return { success: true, merged: false };
  }),

  getFollowUps: read(async (_p, { tx }) => followUps(tx), "appointments:read")
};

// ── follow-ups ───────────────────────────────────────────────────────────

const FOLLOWUP_RULES = [
  { keywords: ["root canal", "rct"], days: 7, label: "RCT" },
  { keywords: ["extraction", "wisdom"], days: 3, label: "Extraction" },
  { keywords: ["implant surgery", "implant placement", "implant - "], days: 10, label: "Implant Surgery" },
  { keywords: ["denture", "rpd"], days: 14, label: "Denture Fitting" },
  { keywords: ["crown", "bridge", "prosthetic", "cementation"], days: 7, label: "Crown / Bridge" },
  { keywords: ["flap surgery", "periodontal", "gum surg"], days: 7, label: "Gum Surgery" },
  { keywords: ["apicoectomy"], days: 10, label: "Apicoectomy" }
];
const ruleFor = (text: string) => {
  const t = text.toLowerCase();
  return FOLLOWUP_RULES.find((r) => r.keywords.some((k) => t.includes(k))) ?? null;
};
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);

async function followUps(tx: Tx) {
  const today = (await sql<{ d: string }>`SELECT clinic_today()::text AS d`.execute(tx)).rows[0]!.d;
  const tz = (await sql<{ tz: string }>`SELECT timezone AS tz FROM clinic_profile()`.execute(tx)).rows[0]!.tz;
  const dir = new Map((await sql<{ uhid: string; name: string; mobile: string | null }>`
    SELECT uhid, full_name AS name, mobile FROM patients`.execute(tx)).rows.map((x) => [x.uhid, x]));

  const visits = (await sql<{ uhid: string; d: string; procedure_done: string | null; patient_name: string | null; phone_no: string | null }>`
    SELECT uhid, visit_date::text AS d, procedure_done, patient_name, phone_no FROM daily_register
     WHERE uhid IS NOT NULL AND uhid <> ''`.execute(tx)).rows;
  const lastVisit = new Map<string, string>();
  const fallback = new Map<string, { name: string; mobile: string }>();
  for (const v of visits) {
    if (!lastVisit.has(v.uhid) || v.d > lastVisit.get(v.uhid)!) lastVisit.set(v.uhid, v.d);
    const f = fallback.get(v.uhid) ?? { name: "", mobile: "" };
    fallback.set(v.uhid, { name: f.name || (v.patient_name ?? ""), mobile: f.mobile || (v.phone_no ?? "") });
  }

  const appts = (await sql<{ uhid: string; d: string; status: string; name: string; mobile: string | null; reason: string }>`
    SELECT p.uhid, (a.starts_at AT TIME ZONE ${tz})::date::text AS d, a.status, a.patient_name AS name, a.mobile, a.reason
      FROM appointments a JOIN patients p ON p.id = a.patient_id`.execute(tx)).rows;
  const booked = new Set(appts.filter((a) => a.status !== "Cancelled" && a.d >= today).map((a) => a.uhid));
  const latest = new Map<string, { d: string; status: string }>();
  for (const a of appts) if (!latest.has(a.uhid) || a.d > latest.get(a.uhid)!.d) latest.set(a.uhid, { d: a.d, status: a.status });

  const missed = appts.filter((a) => {
    if (a.status !== "Cancelled" && a.status !== "No Show") return false;
    const age = daysBetween(a.d, today);
    const l = latest.get(a.uhid);
    return age >= 0 && age <= 60 && l?.d === a.d && l.status === a.status;
  }).map((a) => ({ uhid: a.uhid, name: a.name, mobile: a.mobile || dir.get(a.uhid)?.mobile || "", date: a.d, status: a.status, type: a.reason }));

  const postTreatment = visits.flatMap((v) => {
    const age = daysBetween(v.d, today);
    if (age < 0 || age > 45) return [];
    const rule = ruleFor(v.procedure_done ?? "");
    if (!rule) return [];
    const due = addDays(v.d, rule.days);
    const overdueDays = daysBetween(due, today);
    if (overdueDays < 0 || overdueDays > 14 || booked.has(v.uhid)) return [];
    return [{ uhid: v.uhid, name: v.patient_name || dir.get(v.uhid)?.name || "",
      mobile: dir.get(v.uhid)?.mobile || fallback.get(v.uhid)?.mobile || "",
      procedure: rule.label, treatmentDate: v.d, dueDate: due, overdueDays }];
  }).sort((a, b) => b.overdueDays - a.overdueDays);

  const recall = [...lastVisit].flatMap(([uhid, last]) => {
    if (booked.has(uhid)) return [];
    const since = daysBetween(last, today);
    if (since < 180) return [];
    return [{ uhid, name: dir.get(uhid)?.name || fallback.get(uhid)?.name || "",
      mobile: dir.get(uhid)?.mobile || fallback.get(uhid)?.mobile || "", lastVisit: last, daysSince: since }];
  }).sort((a, b) => b.daysSince - a.daysSince).slice(0, 100);

  return { success: true, postTreatment, recall, missed };
}

