// The procedure library and treatment cases, answering as the live Apps
// Script does. A case is a patient's course of treatment for one procedure:
// the library's stages are copied onto it when it opens, and each visit's
// outcome moves it along (see case-stages.ts).
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import defaults from "./procedure-defaults.json" with { type: "json" };
import {
  applyStageOutcome, buildInitialStages, deriveCaseView, OUTCOMES,
  type LibraryStage, type Outcome, type Stage
} from "./case-stages.js";
import { read, write, DeskError, type ActionTable } from "./types.js";
import { nz, parseList, str, uhidOf } from "./util.js";

const PROCEDURE_FAMILIES = [
  "DIAGNOSTIC", "PREVENTIVE", "RESTORATIVE", "ENDODONTIC", "PROSTHODONTIC",
  "SURGICAL", "IMPLANT", "ORTHODONTIC", "AESTHETIC", "OCCLUSION_TMD"
];

// Reviews are not procedures: reusable stages appended to any open case.
const REVIEW_STAGE_TYPES = [
  "Post-Extraction Review", "Post-Surgical Review", "RCT Review", "Crown Review",
  "Bridge Review", "Implant Review", "Denture Review", "Orthodontic Review",
  "Whitening Review", "General Treatment Review"
];

interface LibraryRow {
  procedureCode: string; procedureName: string; familyCode: string; visitsMin: number; visitsMax: number;
  sequenceNo: number; stageType: string; stageCode: string; stageName: string; completesTreatment: boolean;
}

const truthy = (v: unknown) => v === true || String(v).toLowerCase() === "true";

async function insertLibrary(tx: Tx, rows: LibraryRow[]): Promise<void> {
  if (!rows.length) return;
  await sql`
    INSERT INTO procedure_library (ord, procedure_code, procedure_name, family_code, visits_min, visits_max,
                                   sequence_no, stage_type, stage_code, stage_name, completes_treatment)
    SELECT r.ord, r."procedureCode", r."procedureName", r."familyCode", r."visitsMin", r."visitsMax",
           r."sequenceNo", r."stageType", r."stageCode", r."stageName", r."completesTreatment"
      FROM jsonb_to_recordset(${JSON.stringify(rows.map((r, ord) => ({ ...r, ord })))}::jsonb)
        AS r("procedureCode" text, "procedureName" text, "familyCode" text, "visitsMin" int, "visitsMax" int,
             "sequenceNo" int, "stageType" text, "stageCode" text, "stageName" text, "completesTreatment" boolean, ord int)`.execute(tx);
}

async function readLibrary(tx: Tx): Promise<LibraryRow[]> {
  const q = () => sql<LibraryRow>`
    SELECT procedure_code AS "procedureCode", procedure_name AS "procedureName", family_code AS "familyCode",
           visits_min AS "visitsMin", visits_max AS "visitsMax", sequence_no AS "sequenceNo", stage_type AS "stageType",
           stage_code AS "stageCode", stage_name AS "stageName", completes_treatment AS "completesTreatment"
      FROM procedure_library ORDER BY ord`.execute(tx);
  let rows = (await q()).rows;
  if (!rows.length) { // a clinic's first look: it starts from the standard list
    await insertLibrary(tx, defaults as LibraryRow[]);
    rows = (await q()).rows;
  }
  return rows;
}

async function libraryStages(tx: Tx, procedureCode: string) {
  const rows = (await sql<LibraryRow>`
    SELECT procedure_name AS "procedureName", family_code AS "familyCode", visits_max AS "visitsMax",
           sequence_no AS "sequenceNo", stage_code AS "stageCode", stage_name AS "stageName",
           completes_treatment AS "completesTreatment"
      FROM procedure_library WHERE procedure_code = ${procedureCode} ORDER BY sequence_no`.execute(tx)).rows;
  // The standard list is copied in on first use, so a clinic that has never opened Master still has it.
  if (!rows.length && !(await sql`SELECT 1 FROM procedure_library LIMIT 1`.execute(tx)).rows.length) {
    await readLibrary(tx);
    return libraryStages(tx, procedureCode);
  }
  return rows;
}

interface CaseRow {
  case_ref: string; uhid: string; patient_name: string | null; procedure_code: string; procedure_name: string;
  family_code: string; tooth_ref: string | null; case_status: string; visit_counter: number; stages: Stage[];
}

const CASE_COLUMNS = sql`case_ref, uhid, patient_name, procedure_code, procedure_name, family_code, tooth_ref,
                         case_status, visit_counter, stages`;

const viewOut = (stages: Stage[]) => {
  const v = deriveCaseView(stages);
  return { currentStageCode: v.currentStageCode, currentStageName: v.currentStageName, nextStageCode: v.nextStageCode, nextStageName: v.nextStageName };
};

const maxVisits = (rows: { visitsMax: number }[]) => rows.reduce((m, s) => Math.max(m, s.visitsMax), 0);

async function lockCase(tx: Tx, caseId: string): Promise<CaseRow | null> {
  return (await sql<CaseRow>`SELECT ${CASE_COLUMNS} FROM treatment_cases WHERE case_ref = ${caseId} FOR UPDATE`.execute(tx)).rows[0] ?? null;
}

export const cases: ActionTable = {
  getProcedureLibrary: read(async (_p, { tx }) => ({
    success: true, library: await readLibrary(tx), families: PROCEDURE_FAMILIES, reviewStageTypes: REVIEW_STAGE_TYPES
  })),

  // Master's rewrite of the whole list. An empty list is refused: it would
  // leave the clinic with no procedures to book.
  saveProcedureLibrary: write("masters:write", async (p, { tx }) => {
    const arr = parseList(p.library, "procedure library") as Record<string, unknown>[];
    if (!arr.length) throw new DeskError("The procedure library cannot be empty");
    const seen = new Set<string>();
    const rows = arr.map((r, i): LibraryRow => {
      const row: LibraryRow = {
        procedureCode: str(r.procedureCode), procedureName: str(r.procedureName), familyCode: str(r.familyCode),
        visitsMin: Math.trunc(Number(r.visitsMin)) || 0, visitsMax: Math.trunc(Number(r.visitsMax)) || 0,
        sequenceNo: Math.trunc(Number(r.sequenceNo)), stageType: str(r.stageType),
        stageCode: str(r.stageCode), stageName: str(r.stageName), completesTreatment: truthy(r.completesTreatment)
      };
      if (!row.procedureCode || !row.stageCode || !row.stageName || !Number.isFinite(row.sequenceNo)) {
        throw new DeskError(`Row ${i + 1} of the procedure library is missing its code, stage or sequence number`);
      }
      const key = `${row.procedureCode}#${row.sequenceNo}`;
      if (seen.has(key)) throw new DeskError(`${row.procedureCode} has two stages numbered ${row.sequenceNo}`);
      seen.add(key);
      return row;
    });
    await sql`DELETE FROM procedure_library`.execute(tx);
    await insertLibrary(tx, rows);
    return { success: true };
  }),

  startTreatmentCase: write("appointments:write", async (p, { tx }) => {
    const uhid = uhidOf(p.uhid), code = str(p.procedureCode);
    if (!uhid || !code) return { success: false, error: "uhid and procedureCode required" };
    const meta = await libraryStages(tx, code);
    if (!meta.length) return { success: false, error: `Unknown procedureCode: ${code}` };

    // Two desks opening the same patient's second RCT must not take one number.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"case:" + uhid + ":" + code}, 0))`.execute(tx);
    const existing = (await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM treatment_cases WHERE upper(uhid) = ${uhid} AND procedure_code = ${code}`.execute(tx)).rows[0]!.n;
    const caseId = `${uhid}-${code}-${String(existing + 1).padStart(2, "0")}`;
    const stages = buildInitialStages(meta as LibraryStage[], Number(p.startAtSequenceNo) || 0);
    const patient = (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0];
    const first = meta[0]!;

    await sql`
      INSERT INTO treatment_cases (case_ref, uhid, patient_id, patient_name, procedure_code, procedure_name, family_code, tooth_ref, stages)
      VALUES (${caseId}, ${uhid}, ${patient?.id ?? null}, ${nz(p.patientName)}, ${code}, ${first.procedureName}, ${first.familyCode},
              ${nz(p.toothRef)}, ${JSON.stringify(stages)}::jsonb)`.execute(tx);
    return {
      success: true, caseId, procedureCode: code, procedureName: first.procedureName, familyCode: first.familyCode,
      visitsMax: maxVisits(meta), visitCounter: 0, caseStatus: "in_progress", stages, ...viewOut(stages)
    };
  }),

  // The latest open case for this patient and procedure, so a returning
  // patient continues it instead of starting a second.
  getOpenCase: read(async (p, { tx }) => {
    const uhid = uhidOf(p.uhid), code = str(p.procedureCode);
    if (!uhid || !code) return { success: false, error: "uhid and procedureCode required" };
    const row = (await sql<CaseRow>`
      SELECT ${CASE_COLUMNS} FROM treatment_cases
       WHERE upper(uhid) = ${uhid} AND procedure_code = ${code} AND case_status = 'in_progress'
       ORDER BY opened_at DESC, id DESC LIMIT 1`.execute(tx)).rows[0];
    if (!row) return { success: true, found: false };
    return {
      success: true, found: true, caseId: row.case_ref, procedureCode: row.procedure_code, procedureName: row.procedure_name,
      familyCode: row.family_code, visitCounter: row.visit_counter, caseStatus: row.case_status, stages: row.stages,
      visitsMax: maxVisits(await libraryStages(tx, code)), ...viewOut(row.stages)
    };
  }, "appointments:read"),

  getCaseState: read(async (p, { tx }) => {
    const caseId = str(p.caseId);
    if (!caseId) return { success: false, error: "caseId required" };
    const row = (await sql<CaseRow>`SELECT ${CASE_COLUMNS} FROM treatment_cases WHERE case_ref = ${caseId}`.execute(tx)).rows[0];
    if (!row) return { success: false, error: `Case not found: ${caseId}` };
    return {
      success: true, caseId: row.case_ref, procedureCode: row.procedure_code, procedureName: row.procedure_name,
      familyCode: row.family_code, caseStatus: row.case_status, visitCounter: row.visit_counter, stages: row.stages,
      ...viewOut(row.stages)
    };
  }, "appointments:read"),

  // The one clinical decision the system asks for at the end of a visit.
  resolveStageOutcome: write("appointments:write", async (p, { tx }) => {
    const caseId = str(p.caseId), apptId = str(p.appointmentId), outcome = str(p.stageOutcome) as Outcome;
    if (!OUTCOMES.includes(outcome)) return { success: false, error: "stageOutcome must be approved, adjustment_required, or proceed_to_completion" };
    let seqs: unknown = p.completedStages;
    if (typeof seqs === "string") { try { seqs = JSON.parse(seqs); } catch { seqs = []; } }
    const completed = (Array.isArray(seqs) ? seqs : []).map(Number);
    if (!caseId || !completed.length || completed.some((n) => !Number.isFinite(n))) {
      return { success: false, error: "caseId and completedStages required" };
    }

    const row = await lockCase(tx, caseId);
    if (!row) return { success: false, error: `Case not found: ${caseId}` };
    const stages = applyStageOutcome(row.stages, completed, outcome, apptId, new Date().toISOString());
    const view = deriveCaseView(stages);
    const visits = row.visit_counter + 1;
    const status = view.isComplete ? "completed" : "in_progress";

    await sql`
      UPDATE treatment_cases
         SET stages = ${JSON.stringify(stages)}::jsonb, visit_counter = ${visits}, case_status = ${status},
             closed_at = CASE WHEN ${status} = 'completed' THEN now() ELSE closed_at END
       WHERE case_ref = ${caseId}`.execute(tx);

    // What other screens read per appointment.
    if (apptId) {
      await sql`
        UPDATE appointments SET completed_stages = ${JSON.stringify(completed)}::jsonb, visit_counter = ${String(visits)}
         WHERE id::text = ${apptId} OR legacy_id = ${apptId}`.execute(tx);
    }
    return { success: true, caseId, caseStatus: status, visitCounter: visits, ...viewOut(stages) };
  }),

  // A review or follow-up stage added to the end of a case, reopening it if it had finished.
  appendCaseStage: write("appointments:write", async (p, { tx }) => {
    const caseId = str(p.caseId), stageName = str(p.stageName), stageCode = str(p.stageCode) || "TI";
    if (!caseId || !stageName) return { success: false, error: "caseId and stageName required" };
    const row = await lockCase(tx, caseId);
    if (!row) return { success: false, error: `Case not found: ${caseId}` };
    const maxSeq = row.stages.reduce((m, s) => Math.max(m, s.sequenceNo), 0);
    const stages: Stage[] = [...row.stages, {
      sequenceNo: Math.floor(maxSeq) + 1, stageCode, stageName, status: "pending",
      completedDate: "", completedInAppointment: "", completesTreatment: false
    }];
    await sql`UPDATE treatment_cases SET stages = ${JSON.stringify(stages)}::jsonb, case_status = 'in_progress', closed_at = NULL WHERE case_ref = ${caseId}`.execute(tx);
    return { success: true, ...viewOut(stages) };
  })
};
