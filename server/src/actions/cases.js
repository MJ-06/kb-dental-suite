// Treatment cases: a course of treatment that takes several visits.
//
// An RCT is not one appointment, it is Access Opening, then BMP, then
// Obturation. The case knows which step is next, which is where the
// appointment's sub-reason comes from — nobody types "RCT — Obturation",
// the booking reads it.
const { query, tx } = require("../db");
const { nz, dateISO, uhidOf, parseList } = require("../util");

const actions = {};

// The app says in_progress; the table says open. One word each way, here.
const toAppStatus = (s) => (s === "open" ? "in_progress" : s);
const toDbStatus = (s) => (s === "in_progress" ? "open" : s);

// ── the procedure library ────────────────────────────────────────────────
actions.getProcedureLibrary = async () => {
  const r = await query(
    `SELECT p.code, p.name, p.family_code, p.visits_min, p.visits_max,
            s.sequence_no, s.stage_code, s.stage_name, s.stage_type, s.completes_treatment
       FROM procedures p
       LEFT JOIN procedure_stages s ON s.procedure_code = p.code
      WHERE p.active
      ORDER BY p.family_code, p.name, s.sequence_no`
  );
  const byCode = new Map();
  const families = new Set();
  for (const x of r.rows) {
    families.add(x.family_code);
    if (!byCode.has(x.code)) {
      byCode.set(x.code, {
        procedureCode: x.code, procedureName: x.name, familyCode: x.family_code,
        visitsMin: x.visits_min, visitsMax: x.visits_max, stages: []
      });
    }
    if (x.sequence_no !== null) {
      byCode.get(x.code).stages.push({
        sequenceNo: Number(x.sequence_no), stageCode: x.stage_code, stageName: x.stage_name,
        stageType: x.stage_type, completesTreatment: x.completes_treatment
      });
    }
  }
  return {
    success: true,
    library: [...byCode.values()],
    families: [...families].sort(),
    reviewStageTypes: ["T"]
  };
};

actions.saveProcedureLibrary = async (p) => {
  const rows = parseList(p.library, "procedure library");
  await tx(async (c) => {
    await c.query("UPDATE procedures SET active = FALSE");
    for (const proc of rows) {
      const code = String((proc && proc.procedureCode) || "").trim();
      if (!code) continue;
      await c.query(
        `INSERT INTO procedures (code, name, family_code, visits_min, visits_max, active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name, family_code = EXCLUDED.family_code,
           visits_min = EXCLUDED.visits_min, visits_max = EXCLUDED.visits_max, active = TRUE`,
        [code, String(proc.procedureName || code), String(proc.familyCode || "OTHER"),
         Number(proc.visitsMin) || 1, Number(proc.visitsMax) || 1]
      );
      // Stages are replaced wholesale — but ON DELETE CASCADE would take
      // open cases with them, so only the library's own stage rows go.
      await c.query("DELETE FROM procedure_stages WHERE procedure_code = $1", [code]);
      for (const s of (proc.stages || [])) {
        await c.query(
          `INSERT INTO procedure_stages
             (procedure_code, sequence_no, stage_code, stage_name, stage_type, completes_treatment)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [code, Number(s.sequenceNo), String(s.stageCode || ""), String(s.stageName || ""),
           String(s.stageType || "P").charAt(0), s.completesTreatment === true]
        );
      }
    }
  });
  return { success: true };
};

// ── one case ─────────────────────────────────────────────────────────────
async function readStages(c, caseId) {
  const r = await c.query(
    `SELECT sequence_no, stage_code, stage_name, status, done_on,
            completes_treatment, completed_in_appointment
       FROM case_stages WHERE case_id = $1 ORDER BY sequence_no`,
    [caseId]
  );
  return r.rows.map((x) => ({
    sequenceNo: Number(x.sequence_no),
    stageCode: x.stage_code || "",
    stageName: x.stage_name,
    status: x.status,
    completedDate: x.done_on ? dateISO(x.done_on) : "",
    completedInAppointment: x.completed_in_appointment === null ? "" : String(x.completed_in_appointment),
    completesTreatment: x.completes_treatment
  }));
}

// Current is the first stage still pending; next is the one after it.
function deriveView(stages) {
  const pending = stages.filter((s) => s.status === "pending").sort((a, b) => a.sequenceNo - b.sequenceNo);
  return {
    currentStageCode: pending[0] ? pending[0].stageCode : "",
    currentStageName: pending[0] ? pending[0].stageName : "",
    nextStageCode: pending[1] ? pending[1].stageCode : "",
    nextStageName: pending[1] ? pending[1].stageName : ""
  };
}

async function caseState(c, caseId) {
  const r = await c.query(
    `SELECT tc.id, tc.uhid, tc.procedure_code, tc.status, tc.visit_counter,
            tc.tooth_numbers, p.name AS procedure_name, p.family_code, p.visits_max
       FROM treatment_cases tc JOIN procedures p ON p.code = tc.procedure_code
      WHERE tc.id = $1`,
    [caseId]
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  const stages = await readStages(c, caseId);
  return {
    caseId: String(x.id),
    uhid: x.uhid,
    procedureCode: x.procedure_code,
    procedureName: x.procedure_name,
    familyCode: x.family_code,
    toothRef: x.tooth_numbers || "",
    caseStatus: toAppStatus(x.status),
    visitCounter: x.visit_counter,
    visitsMax: x.visits_max,
    stages,
    ...deriveView(stages)
  };
}

actions.startTreatmentCase = async (p) => {
  const uhid = uhidOf(p.uhid);
  const code = String(p.procedureCode || "").trim();
  if (!uhid || !code) return { success: false, error: "uhid and procedureCode required" };

  return tx(async (c) => {
    const meta = await c.query(
      `SELECT sequence_no, stage_code, stage_name, completes_treatment
         FROM procedure_stages WHERE procedure_code = $1 ORDER BY sequence_no`,
      [code]
    );
    if (!meta.rowCount) return { success: false, error: `Unknown procedureCode: ${code}` };

    const known = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!known.rowCount) return { success: false, error: `Patient not found: ${uhid}` };

    const r = await c.query(
      `INSERT INTO treatment_cases (uhid, procedure_code, tooth_numbers, patient_name, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [uhid, code, nz(p.toothRef), nz(p.patientName)]
    );
    const caseId = r.rows[0].id;

    // Starting part way through: a patient who had the access opening
    // elsewhere starts at stage 2, and stage 1 is recorded as skipped
    // rather than quietly missing.
    const startAt = Number(p.startAtSequenceNo) || 0;
    for (const s of meta.rows) {
      await c.query(
        `INSERT INTO case_stages
           (case_id, sequence_no, stage_code, stage_name, status, completes_treatment)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [caseId, s.sequence_no, s.stage_code, s.stage_name,
         Number(s.sequence_no) < startAt ? "skipped" : "pending", s.completes_treatment]
      );
    }
    return { success: true, ...(await caseState(c, caseId)) };
  });
};

// The most recent OPEN case for a patient and procedure — so a returning
// patient continues the case they already have instead of silently starting
// a second one.
actions.getOpenCase = async (p) => {
  const uhid = uhidOf(p.uhid);
  const code = String(p.procedureCode || "").trim();
  if (!uhid || !code) return { success: false, error: "uhid and procedureCode required" };
  return tx(async (c) => {
    const r = await c.query(
      `SELECT id FROM treatment_cases
        WHERE uhid = $1 AND procedure_code = $2 AND status = 'open'
        ORDER BY opened_on DESC, id DESC LIMIT 1`,
      [uhid, code]
    );
    if (!r.rowCount) return { success: true, found: false };
    return { success: true, found: true, ...(await caseState(c, r.rows[0].id)) };
  });
};

actions.getCaseState = async (p) => {
  const caseId = Number(p.caseId);
  if (!caseId) return { success: false, error: "caseId required" };
  return tx(async (c) => {
    const st = await caseState(c, caseId);
    if (!st) return { success: false, error: `Case not found: ${p.caseId}` };
    return { success: true, ...st };
  });
};

// The three outcomes a visit can have. This is the only clinical decision
// the system asks for; current, next and whether the case is finished are
// all worked out from it.
actions.resolveStageOutcome = async (p) => {
  const caseId = Number(p.caseId);
  const outcome = String(p.outcome || "").trim();
  if (!caseId || !outcome) return { success: false, error: "caseId and outcome required" };
  const completed = (p.completedStages === undefined ? [] : parseList(p.completedStages, "completed stages"))
    .map(Number).filter((n) => !isNaN(n));
  const apptId = p.appointmentId ? Number(p.appointmentId) : null;

  return tx(async (c) => {
    const exists = await c.query("SELECT 1 FROM treatment_cases WHERE id = $1", [caseId]);
    if (!exists.rowCount) return { success: false, error: `Case not found: ${p.caseId}` };

    let lastDone = null;
    for (const seq of completed) {
      const r = await c.query(
        `UPDATE case_stages
            SET status = 'completed', done_on = CURRENT_DATE, completed_in_appointment = $3
          WHERE case_id = $1 AND sequence_no = $2 AND status = 'pending'
          RETURNING sequence_no, stage_code, stage_name`,
        [caseId, seq, apptId]
      );
      if (r.rowCount) lastDone = r.rows[0];
    }

    if (outcome === "adjustment_required" && lastDone) {
      // A fractional number puts the adjustment straight after the stage it
      // belongs to, and leaves every later stage's own number untouched.
      let newSeq = Number(lastDone.sequence_no) + 0.1;
      for (;;) {
        const clash = await c.query(
          "SELECT 1 FROM case_stages WHERE case_id = $1 AND sequence_no = $2", [caseId, newSeq]
        );
        if (!clash.rowCount) break;
        newSeq = Math.round((newSeq + 0.01) * 100) / 100;
      }
      await c.query(
        `INSERT INTO case_stages (case_id, sequence_no, stage_code, stage_name, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [caseId, newSeq, lastDone.stage_code, `${lastDone.stage_name} / adjustment`]
      );
    }

    if (outcome === "proceed_to_completion") {
      await c.query(
        "UPDATE case_stages SET status = 'skipped' WHERE case_id = $1 AND status = 'pending'",
        [caseId]
      );
    }

    await c.query(
      "UPDATE treatment_cases SET visit_counter = visit_counter + 1 WHERE id = $1", [caseId]
    );

    // No stage left pending means the course of treatment is over.
    const left = await c.query(
      "SELECT count(*)::int AS n FROM case_stages WHERE case_id = $1 AND status = 'pending'", [caseId]
    );
    if (left.rows[0].n === 0) {
      await c.query(
        "UPDATE treatment_cases SET status = 'completed', closed_on = CURRENT_DATE WHERE id = $1",
        [caseId]
      );
    }

    return { success: true, ...(await caseState(c, caseId)) };
  });
};

// An extra stage the plan did not have: one more sitting, added at the end.
actions.appendCaseStage = async (p) => {
  const caseId = Number(p.caseId);
  if (!caseId) return { success: false, error: "caseId required" };
  return tx(async (c) => {
    const last = await c.query(
      "SELECT COALESCE(max(sequence_no), 0) AS m FROM case_stages WHERE case_id = $1", [caseId]
    );
    const seq = Math.floor(Number(last.rows[0].m)) + 1;
    await c.query(
      `INSERT INTO case_stages (case_id, sequence_no, stage_code, stage_name, status, completes_treatment)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [caseId, seq, nz(p.stageCode) || `EXTRA_${seq}`, String(p.stageName || `Visit ${seq}`),
       p.completesTreatment === true || String(p.completesTreatment) === "true"]
    );
    // Adding a stage reopens a case that had been closed: there is more to do.
    await c.query(
      "UPDATE treatment_cases SET status = 'open', closed_on = NULL WHERE id = $1 AND status = 'completed'",
      [caseId]
    );
    const st = await caseState(c, caseId);
    if (!st) return { success: false, error: `Case not found: ${p.caseId}` };
    return { success: true, ...st };
  });
};

module.exports = { actions, caseState, deriveView, toAppStatus, toDbStatus };
