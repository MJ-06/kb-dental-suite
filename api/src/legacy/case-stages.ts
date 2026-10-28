// How a treatment case moves: the stages it copied from the library, which
// one is current, and what a visit's outcome does to them. Pure functions
// over the stage list, ported from the live Apps Script unchanged.

export interface Stage {
  sequenceNo: number;
  stageCode: string;
  stageName: string;
  status: "pending" | "completed" | "skipped";
  completedDate: string;
  completedInAppointment: string;
  completesTreatment: boolean;
}

export interface LibraryStage {
  sequenceNo: number;
  stageCode: string;
  stageName: string;
  completesTreatment: boolean;
}

export type Outcome = "approved" | "adjustment_required" | "proceed_to_completion";
export const OUTCOMES: readonly Outcome[] = ["approved", "adjustment_required", "proceed_to_completion"];

/**
 * The stages for a brand-new case. `startAtSequenceNo` opens a case partway
 * through: earlier stages count as done (elsewhere, or before the clinic
 * tracked them), with no date or appointment.
 */
export function buildInitialStages(library: LibraryStage[], startAtSequenceNo = 0): Stage[] {
  return library.map((s) => ({
    sequenceNo: s.sequenceNo, stageCode: s.stageCode, stageName: s.stageName,
    status: startAtSequenceNo && s.sequenceNo < startAtSequenceNo ? "completed" : "pending",
    completedDate: "", completedInAppointment: "", completesTreatment: !!s.completesTreatment
  }));
}

/** Current stage = first pending; next = the one after; complete = nothing pending, or a finishing stage done. */
export function deriveCaseView(stages: Stage[]) {
  const sorted = [...stages].sort((a, b) => a.sequenceNo - b.sequenceNo);
  const i = sorted.findIndex((s) => s.status === "pending");
  const current = i >= 0 ? sorted[i]! : null;
  const next = i >= 0 && i + 1 < sorted.length ? sorted[i + 1]! : null;
  return {
    currentStageCode: current?.stageCode ?? "", currentStageName: current?.stageName ?? "",
    nextStageCode: next?.stageCode ?? "", nextStageName: next?.stageName ?? "",
    isComplete: sorted.every((s) => s.status !== "pending") || sorted.some((s) => s.status === "completed" && s.completesTreatment)
  };
}

/** The visit's outcome applied to the stages it covered. Returns a new list; the input is untouched. */
export function applyStageOutcome(stages: Stage[], completedSeqs: number[], outcome: Outcome, appointmentId: string, now: string): Stage[] {
  const sorted = stages.map((s) => ({ ...s })).sort((a, b) => a.sequenceNo - b.sequenceNo);
  let lastCompleted: number | null = null;

  for (const seq of completedSeqs) {
    const match = sorted.find((x) => x.sequenceNo === seq);
    if (match && match.status === "pending") {
      match.status = "completed"; match.completedDate = now; match.completedInAppointment = appointmentId;
      lastCompleted = seq;
    }
  }

  if (outcome === "adjustment_required" && lastCompleted !== null) {
    const done = sorted.find((x) => x.sequenceNo === lastCompleted)!;
    // A fractional number slots the extra stage in without renumbering the
    // ones already stored.
    let seq = lastCompleted + 0.1;
    while (sorted.some((x) => x.sequenceNo === seq)) seq += 0.01;
    sorted.push({
      sequenceNo: seq, stageCode: done.stageCode, stageName: `${done.stageName} / adjustment`,
      status: "pending", completedDate: "", completedInAppointment: "", completesTreatment: false
    });
    sorted.sort((a, b) => a.sequenceNo - b.sequenceNo);
  }

  if (outcome === "proceed_to_completion") {
    for (const s of sorted) if (s.status === "pending") s.status = "skipped";
  }
  return sorted;
}
