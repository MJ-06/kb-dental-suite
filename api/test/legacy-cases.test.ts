// The procedure library and treatment cases through /exec, and the stage rules on their own.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStageOutcome, buildInitialStages, deriveCaseView } from "../src/legacy/case-stages.js";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

const lib = [
  { sequenceNo: 1, stageCode: "A", stageName: "Access", completesTreatment: false },
  { sequenceNo: 2, stageCode: "B", stageName: "Prep", completesTreatment: false },
  { sequenceNo: 3, stageCode: "C", stageName: "Fill", completesTreatment: true }
];
const NOW = "2026-10-28T10:00:00.000Z";

describe("stage rules", () => {
  it("opens with every stage pending, or the early ones done when the case starts late", () => {
    expect(buildInitialStages(lib).map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
    const late = buildInitialStages(lib, 2);
    expect(late.map((s) => s.status)).toEqual(["completed", "pending", "pending"]);
    expect(late[0]!.completedDate).toBe("");
  });

  it("derives current, next and completion from the stages alone", () => {
    const stages = buildInitialStages(lib);
    expect(deriveCaseView(stages)).toMatchObject({ currentStageCode: "A", nextStageCode: "B", isComplete: false });
    const done = applyStageOutcome(stages, [1, 2], "approved", "APT-1", NOW);
    expect(deriveCaseView(done)).toMatchObject({ currentStageCode: "C", nextStageCode: "", isComplete: false });
    expect(deriveCaseView(applyStageOutcome(done, [3], "approved", "APT-2", NOW)).isComplete).toBe(true);
  });

  it("slots an adjustment stage in without renumbering and never touches the input", () => {
    const stages = buildInitialStages(lib);
    const out = applyStageOutcome(stages, [1], "adjustment_required", "APT-1", NOW);
    expect(out.map((s) => s.sequenceNo)).toEqual([1, 1.1, 2, 3]);
    expect(out[1]).toMatchObject({ stageName: "Access / adjustment", status: "pending" });
    expect(stages.every((s) => s.status === "pending")).toBe(true);
    expect(deriveCaseView(out).currentStageName).toBe("Access / adjustment");
  });

  it("skips what is left when told to proceed to completion", () => {
    const out = applyStageOutcome(buildInitialStages(lib), [1], "proceed_to_completion", "", NOW);
    expect(out.map((s) => s.status)).toEqual(["completed", "skipped", "skipped"]);
    expect(deriveCaseView(out).isComplete).toBe(true);
  });

  it("ignores a stage that is already done", () => {
    const once = applyStageOutcome(buildInitialStages(lib), [1], "approved", "APT-1", NOW);
    const twice = applyStageOutcome(once, [1], "adjustment_required", "APT-2", NOW);
    expect(twice).toHaveLength(3); // nothing newly completed, so no adjustment stage
    expect(twice[0]!.completedInAppointment).toBe("APT-1");
  });
});

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
  await exec(w, desk, "saveRegistration", { uhid, name: "Case Patient", mobile: "9844400000" });
});
afterAll(() => w.close());

describe("procedure library", () => {
  it("starts a clinic from the standard list, in order, with the lists the screen needs", async () => {
    const res = await exec(w, desk, "getProcedureLibrary");
    expect(res.library).toHaveLength(274);
    expect(res.library[0]).toMatchObject({ procedureCode: "NEW_PATIENT_EXAMINATION", sequenceNo: 1, stageType: "P", completesTreatment: expect.any(Boolean) });
    expect(res.families).toContain("ENDODONTIC");
    expect(res.reviewStageTypes).toContain("RCT Review");
    expect((await exec(w, desk, "getProcedureLibrary")).library).toHaveLength(274); // seeded once
  });

  it("lets Master rewrite it, and keeps reception from doing so", async () => {
    expect(await exec(w, desk, "saveProcedureLibrary", { library: [] })).toMatchObject({ forbidden: true });
    const mine = lib.map((s, i) => ({ procedureCode: "MY_RCT", procedureName: "My RCT", familyCode: "ENDODONTIC", visitsMin: 2, visitsMax: 3,
      sequenceNo: s.sequenceNo, stageType: i === 2 ? "C" : "T", stageCode: s.stageCode, stageName: s.stageName, completesTreatment: s.completesTreatment }));
    expect((await exec(w, admin, "saveProcedureLibrary", { library: mine })).success).toBe(true);
    const after = (await exec(w, admin, "getProcedureLibrary")).library;
    expect(after).toHaveLength(3);
    expect(after[2]).toMatchObject({ procedureCode: "MY_RCT", stageName: "Fill", completesTreatment: true, visitsMax: 3 });
  });

  it("refuses an empty list, a half-filled row and a repeated stage number", async () => {
    expect((await exec(w, admin, "saveProcedureLibrary", { library: [] })).error).toBe("The procedure library cannot be empty");
    expect((await exec(w, admin, "saveProcedureLibrary", { library: [{ procedureCode: "X" }] })).error).toMatch(/Row 1 .* missing/);
    const dup = [{ procedureCode: "X", stageCode: "A", stageName: "a", sequenceNo: 1 }, { procedureCode: "X", stageCode: "B", stageName: "b", sequenceNo: 1 }];
    expect((await exec(w, admin, "saveProcedureLibrary", { library: dup })).error).toBe("X has two stages numbered 1");
    expect((await exec(w, admin, "getProcedureLibrary")).library).toHaveLength(3); // nothing was lost
  });

  it("keeps one clinic's library from another's", async () => {
    expect((await exec(w, betaAdmin, "getProcedureLibrary")).library).toHaveLength(274);
  });
});

describe("treatment cases", () => {
  let caseId: string;
  let apptId: string;

  it("opens a case from the library and numbers a patient's cases per procedure", async () => {
    const res = await exec(w, desk, "startTreatmentCase", { uhid: uhid.toLowerCase(), procedureCode: "MY_RCT", patientName: "Case Patient", toothRef: "36" });
    expect(res).toMatchObject({ success: true, caseId: `${uhid}-MY_RCT-01`, procedureName: "My RCT", visitsMax: 3, visitCounter: 0,
      caseStatus: "in_progress", currentStageCode: "A", nextStageCode: "B" });
    expect(res.stages).toHaveLength(3);
    caseId = res.caseId;
  });

  it("reuses the open case and refuses an unknown procedure", async () => {
    const open = await exec(w, desk, "getOpenCase", { uhid, procedureCode: "MY_RCT" });
    expect(open).toMatchObject({ found: true, caseId, visitsMax: 3, currentStageCode: "A" });
    expect(await exec(w, desk, "getOpenCase", { uhid, procedureCode: "SCALING" })).toEqual({ success: true, found: false });
    expect((await exec(w, desk, "startTreatmentCase", { uhid, procedureCode: "NOPE" })).error).toBe("Unknown procedureCode: NOPE");
    expect((await exec(w, desk, "startTreatmentCase", { uhid })).error).toBe("uhid and procedureCode required");
  });

  it("moves along as visits are resolved, and mirrors the visit onto its appointment", async () => {
    ({ id: apptId } = await exec(w, desk, "saveAppointment", { date: "2026-11-06", time: "10:00", uhid, patientName: "Case Patient", type: "RCT", caseId }));
    const res = await exec(w, desk, "resolveStageOutcome", { caseId, appointmentId: apptId, stageOutcome: "approved", completedStages: [1] });
    expect(res).toMatchObject({ success: true, caseStatus: "in_progress", visitCounter: 1, currentStageCode: "B", nextStageCode: "C" });
    const appt = (await exec(w, desk, "getAppointments", { date: "2026-11-06" })).appointments[0];
    expect(appt).toMatchObject({ completedStages: [1], visitCounter: "1" });
    const state = await exec(w, desk, "getCaseState", { caseId });
    expect(state.stages[0]).toMatchObject({ status: "completed", completedInAppointment: apptId });
  });

  it("adds an adjustment stage, then closes the case when the finishing stage is done", async () => {
    const adj = await exec(w, desk, "resolveStageOutcome", { caseId, stageOutcome: "adjustment_required", completedStages: JSON.stringify([2]) });
    expect(adj).toMatchObject({ visitCounter: 2, currentStageName: "Prep / adjustment", nextStageCode: "C" });
    await exec(w, desk, "resolveStageOutcome", { caseId, stageOutcome: "approved", completedStages: [2.1] });
    const done = await exec(w, desk, "resolveStageOutcome", { caseId, stageOutcome: "approved", completedStages: [3] });
    expect(done).toMatchObject({ caseStatus: "completed", visitCounter: 4, currentStageCode: "" });
    expect(await exec(w, desk, "getOpenCase", { uhid, procedureCode: "MY_RCT" })).toEqual({ success: true, found: false });
  });

  it("reopens a finished case when a review is appended, and numbers the next case 02", async () => {
    const res = await exec(w, desk, "appendCaseStage", { caseId, stageName: "RCT Review" });
    expect(res).toMatchObject({ success: true, currentStageName: "RCT Review", currentStageCode: "TI" });
    expect((await exec(w, desk, "getCaseState", { caseId })).caseStatus).toBe("in_progress");
    expect((await exec(w, desk, "startTreatmentCase", { uhid, procedureCode: "MY_RCT" })).caseId).toBe(`${uhid}-MY_RCT-02`);
  });

  it("refuses bad outcomes and unknown cases", async () => {
    expect((await exec(w, desk, "resolveStageOutcome", { caseId, stageOutcome: "maybe", completedStages: [1] })).error).toMatch(/stageOutcome must be/);
    expect((await exec(w, desk, "resolveStageOutcome", { caseId, stageOutcome: "approved" })).error).toBe("caseId and completedStages required");
    expect((await exec(w, desk, "resolveStageOutcome", { caseId: "NOPE", stageOutcome: "approved", completedStages: [1] })).error).toBe("Case not found: NOPE");
    expect((await exec(w, desk, "getCaseState", { caseId: "NOPE" })).error).toBe("Case not found: NOPE");
    expect((await exec(w, desk, "appendCaseStage", { caseId })).error).toBe("caseId and stageName required");
  });

  it("does not show one clinic's case to another", async () => {
    expect((await exec(w, betaAdmin, "getCaseState", { caseId })).error).toBe(`Case not found: ${caseId}`);
  });
});
