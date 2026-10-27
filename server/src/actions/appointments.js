// Appointments, the day sheet, and blocked slots.
//
// Three things the sheet could not enforce are rules here: a chair cannot
// hold two patients at one time, the four stamps cannot happen out of order,
// and a cancellation cannot have no reason. The first is a unique index, the
// other two are check constraints — see schema.sql.
const { query, tx } = require("../db");
const { nz, dateISO, timeHM, timeOrNull, parseList } = require("../util");

const actions = {};

// A doctor or a chair arrives as a NAME, because that is what the booking
// form shows. Resolve it to its master row; a name nobody has used before is
// added rather than refused, which is how the sheet behaved and what a busy
// desk needs. The master list stays the source of truth for the dropdown.
async function namedId(c, table, name) {
  const n = nz(name);
  if (!n) return null;
  const r = await c.query(
    `INSERT INTO ${table} (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [n]
  );
  return r.rows[0].id;
}

// Why the clinic is shut that day, or "" if it is open.
async function closedReason(c, date) {
  const d = dateISO(date);
  if (!d) return "";
  const hol = await c.query("SELECT name FROM holidays WHERE holiday_date = $1", [d]);
  if (hol.rowCount) return hol.rows[0].name;
  const off = await c.query("SELECT value FROM clinic_settings WHERE key = 'week_off'");
  const list = off.rowCount ? off.rows[0].value : [];
  if (Array.isArray(list) && list.length) {
    const dayName = new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
    if (list.map(String).includes(dayName)) return `${dayName} is a weekly off`;
  }
  return "";
}

const APPT_SELECT = `
  SELECT a.id, a.uhid, a.patient_name, a.mobile, a.appt_date, a.appt_time,
         a.reason, a.sub_type, a.notes, a.status,
         a.checkin_at, a.engaged_at, a.checkout_at, a.cancel_reason,
         a.case_id, d.name AS doctor, ch.name AS chair,
         tc.procedure_code, pr.name AS procedure_name, pr.family_code
    FROM appointments a
    LEFT JOIN doctors d  ON d.id  = a.doctor_id
    LEFT JOIN chairs  ch ON ch.id = a.chair_id
    LEFT JOIN treatment_cases tc ON tc.id = a.case_id
    LEFT JOIN procedures pr ON pr.code = tc.procedure_code`;

function apptRow(x) {
  return {
    id: String(x.id),
    date: dateISO(x.appt_date),
    uhid: x.uhid || "",
    patientName: x.patient_name || "",
    time: timeHM(x.appt_time),
    type: x.reason || "",
    // Which step of the reason. Filled from the case when the booking is
    // part of one, so nobody types "RCT — Obturation" by hand.
    subType: x.sub_type || "",
    doctor: x.doctor || "",
    chair: x.chair || "",
    mobile: x.mobile || "",
    notes: x.notes || "",
    status: x.status,
    checkinTime: timeHM(x.checkin_at),
    engagedTime: timeHM(x.engaged_at),
    checkoutTime: timeHM(x.checkout_at),
    cancelReason: x.cancel_reason || "",
    caseId: x.case_id === null ? "" : String(x.case_id),
    procedureCode: x.procedure_code || "",
    procedureName: x.procedure_name || "",
    familyCode: x.family_code || ""
  };
}

actions.getAppointments = async (p) => {
  const date = dateISO(p.date);
  const from = dateISO(p.fromDate);
  const to = dateISO(p.toDate);
  let where = "", params = [];
  if (date) { where = "WHERE a.appt_date = $1"; params = [date]; }
  else if (from || to) {
    const parts = [];
    if (from) { params.push(from); parts.push(`a.appt_date >= $${params.length}`); }
    if (to) { params.push(to); parts.push(`a.appt_date <= $${params.length}`); }
    where = "WHERE " + parts.join(" AND ");
  }
  const r = await query(`${APPT_SELECT} ${where} ORDER BY a.appt_date, a.appt_time`, params);
  return { success: true, appointments: r.rows.map(apptRow) };
};

actions.saveAppointment = async (p) => {
  return tx(async (c) => {
    // Nothing is booked into a day the clinic is shut. A walk-in is exempt:
    // it records a patient who actually came, which is a fact about the past
    // — an emergency seen on a holiday must still be recordable.
    if (!p.walkIn) {
      const shut = await closedReason(c, p.date);
      if (shut) return { success: false, error: `The clinic is closed on ${dateISO(p.date)} — ${shut}` };
    }

    const doctorId = await namedId(c, "doctors", p.doctor);
    const chairId = await namedId(c, "chairs", p.chair);

    // The sub-reason is taken from the case's current stage, not typed. If
    // the booking carries a case and no sub-type was sent, read it.
    let subType = nz(p.subType);
    const caseId = p.caseId ? Number(p.caseId) : null;
    if (!subType && caseId) {
      const st = await c.query(
        `SELECT stage_name FROM case_stages
          WHERE case_id = $1 AND status = 'pending'
          ORDER BY sequence_no LIMIT 1`,
        [caseId]
      );
      if (st.rowCount) subType = st.rows[0].stage_name;
    }

    try {
      const r = await c.query(
        `INSERT INTO appointments (
           uhid, patient_name, mobile, appt_date, appt_time, reason, sub_type,
           doctor_id, chair_id, case_id, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          nz(p.uhid), String(p.patientName || "").trim() || "(no name)", nz(p.mobile),
          dateISO(p.date), timeOrNull(p.time), String(p.type || "Consultation"),
          subType, doctorId, chairId, caseId, nz(p.notes), String(p.status || "Scheduled")
        ]
      );
      return { success: true, id: String(r.rows[0].id) };
    } catch (e) {
      // The one error worth translating: the desk double-books a chair and
      // needs to be told which, not shown a constraint name.
      if (e.constraint === "one_patient_per_chair_per_slot") {
        return {
          success: false,
          error: `${nz(p.chair)} already has a patient at ${timeHM(p.time)} on ${dateISO(p.date)}`
        };
      }
      throw e;
    }
  });
};

// A visit moves Scheduled → Checked In → In Chair → Completed, each step
// stamping a time. It can also move BACK: somebody presses Check In for a
// patient who then does not come. Stepping back clears the stamps ahead of
// where it lands, so the day sheet does not keep showing a check-in that was
// undone.
const APPT_STEPS = [
  { status: "Scheduled",  stamp: null },
  { status: "Checked In", stamp: "checkin_at" },
  { status: "In Chair",   stamp: "engaged_at" },
  { status: "Completed",  stamp: "checkout_at" }
];

function stepOf(status) {
  return APPT_STEPS.findIndex((s) => s.status === status);   // -1: Cancelled, No Show
}

actions.updateAppointmentStatus = async (p) => {
  const id = Number(p.id);
  const status = String(p.status || "").trim();
  if (!id || !status) return { success: false, error: "Which appointment, and to what?" };
  if (status === "Cancelled" && !nz(p.cancelReason)) {
    return { success: false, error: "A cancellation needs a reason" };
  }

  const step = stepOf(status);
  const sets = ["status = $2"];
  const params = [id, status];

  // The stamp for this step, if it does not have one yet. Re-pressing a
  // button must not move the time.
  if (step > 0) {
    sets.push(`${APPT_STEPS[step].stamp} = COALESCE(${APPT_STEPS[step].stamp}, now())`);
  }
  // Everything after this step is cleared. Done in order from the last
  // column backwards so the stamps_in_order constraint is never momentarily
  // broken mid-statement — one UPDATE sets them all at once, so it is not,
  // but the order below is the one a reader expects.
  for (let k = APPT_STEPS.length - 1; k > Math.max(step, 0); k--) {
    if (APPT_STEPS[k].stamp) sets.push(`${APPT_STEPS[k].stamp} = NULL`);
  }
  if (step >= 0) sets.push("cancel_reason = NULL");
  else if (nz(p.cancelReason)) {
    params.push(nz(p.cancelReason));
    sets.push(`cancel_reason = $${params.length}`);
  }

  const r = await query(
    `UPDATE appointments SET ${sets.join(", ")} WHERE id = $1 RETURNING id`,
    params
  );
  if (!r.rowCount) return { success: false, error: "Appointment not found" };
  return { success: true, id: String(id), status };
};

actions.updateAppointment = async (p) => {
  const id = Number(p.id);
  if (!id) return { success: false, error: "Which appointment?" };
  return tx(async (c) => {
    const sets = [], params = [id];
    const put = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };
    if (p.date !== undefined) put("appt_date", dateISO(p.date));
    if (p.time !== undefined) put("appt_time", timeOrNull(p.time));
    if (p.type !== undefined) put("reason", String(p.type));
    if (p.subType !== undefined) put("sub_type", nz(p.subType));
    if (p.notes !== undefined) put("notes", nz(p.notes));
    if (p.mobile !== undefined) put("mobile", nz(p.mobile));
    if (p.patientName !== undefined) put("patient_name", String(p.patientName));
    if (p.doctor !== undefined) put("doctor_id", await namedId(c, "doctors", p.doctor));
    if (p.chair !== undefined) put("chair_id", await namedId(c, "chairs", p.chair));
    if (!sets.length) return { success: true, id: String(id), changed: 0 };
    const r = await c.query(
      `UPDATE appointments SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, params
    );
    if (!r.rowCount) return { success: false, error: "Appointment not found" };
    return { success: true, id: String(id), changed: sets.length };
  });
};

// Deleting is kept for the booking made in error moments ago. A visit that
// happened is cancelled with a reason, not deleted — the clinic has to be
// able to say what it did.
actions.deleteAppointment = async (p) => {
  const r = await query("DELETE FROM appointments WHERE id = $1 RETURNING id", [Number(p.id)]);
  if (!r.rowCount) return { success: false, error: "Appointment not found" };
  return { success: true };
};

actions.getBlockedSlots = async (p) => {
  const date = dateISO(p.date);
  const r = await query(
    `SELECT b.id, b.block_date, b.from_time, b.to_time, b.reason,
            ch.name AS chair, d.name AS doctor
       FROM blocked_slots b
       LEFT JOIN chairs ch ON ch.id = b.chair_id
       LEFT JOIN doctors d ON d.id = b.doctor_id
      WHERE $1::date IS NULL OR b.block_date = $1
      ORDER BY b.block_date, b.from_time`,
    [date || null]
  );
  return {
    success: true,
    blocks: r.rows.map((x) => ({
      id: String(x.id), date: dateISO(x.block_date),
      fromTime: timeHM(x.from_time), toTime: timeHM(x.to_time),
      chair: x.chair || "", doctor: x.doctor || "", reason: x.reason || ""
    }))
  };
};

actions.saveBlockedSlot = async (p) => {
  return tx(async (c) => {
    const r = await c.query(
      `INSERT INTO blocked_slots (block_date, from_time, to_time, chair_id, doctor_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        dateISO(p.date), timeOrNull(p.fromTime), timeOrNull(p.toTime),
        await namedId(c, "chairs", p.chair), await namedId(c, "doctors", p.doctor),
        nz(p.reason)
      ]
    );
    return { success: true, id: String(r.rows[0].id) };
  });
};

actions.deleteBlockedSlot = async (p) => {
  const r = await query("DELETE FROM blocked_slots WHERE id = $1 RETURNING id", [Number(p.id)]);
  if (!r.rowCount) return { success: false, error: "That block is already gone" };
  return { success: true };
};

// The patient chatbot: "what appointments do I have?"
actions.findAppointmentsByPhone = async (p) => {
  const phone = String(p.phone || p.mobile || "").trim();
  if (!phone) return { success: true, appointments: [] };
  const r = await query(
    `${APPT_SELECT}
      WHERE (a.mobile = $1 OR a.uhid IN (SELECT uhid FROM patients WHERE mobile = $1 OR whatsapp = $1))
        AND a.appt_date >= CURRENT_DATE AND a.status NOT IN ('Cancelled','No Show')
      ORDER BY a.appt_date, a.appt_time`,
    [phone]
  );
  return { success: true, appointments: r.rows.map(apptRow) };
};

actions.saveChatbotAppointment = async (p) => {
  // A patient booking for themselves gets a Scheduled appointment like any
  // other, with no chair: the desk assigns one.
  return actions.saveAppointment({
    ...p, chair: "", doctor: p.doctor || "", status: "Scheduled",
    notes: `Booked by the patient. ${nz(p.notes) || ""}`.trim()
  });
};

module.exports = { actions, namedId, closedReason, APPT_STEPS, stepOf, apptRow, APPT_SELECT };
