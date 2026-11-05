# One-patient UI comparison — 6 November 2026

## Scope and handling

Compared the live original at https://kbdental.github.io/kb-dental-suite/ with the
protected laptop review using one shared reference patient only. The reference was
selected from existing records with five treatment cases, 109 clinical forms,
83 day-book entries, 13 appointments and one stored chart. No patient identities,
clinical text, dates, amounts or signatures are reproduced in this document.
No patient records or original Sheets data were saved/edited. Other patients were
not individually investigated. Private selection/evidence lives under the ignored
`api/.organization-demo-runtime/realdata-review/` folder.

## Findings

| Check | Result | Evidence and limitation |
|---|---|---|
| Same patient | Verified | Same retained UHID opened in both UIs. |
| Treatment Plan | Empty state consistent | Original UI had no selected procedure/tooth/fee; migrated UI likewise showed six plan controls with no chosen procedure/tooth/fee. Snapshot has no authored plan rows for this patient. This does not establish populated Treatment Plan acceptance. |
| Populated Records | Verified for selected restoration sheet | Both UIs rendered two tooth groups. The selected source record's explicit doctor and material values both appeared in both UIs. This is not a check of all 109 forms. |
| Recorded doctor | Matched | Same recorded clinical doctor value present in original sheet, migrated sheet and prototype print preview. No revenue or treatment attribution inferred from appointments. |
| Historical assistant/staff | Unavailable in source | No explicit assistant/staff/nurse/hygienist value found in the selected patient's 109 forms. Do not substitute the importing admin or a demo login as the historical author. |
| Daysheet date filtering | Verified against API | Committed the visible DD/MM/YYYY input. Prototype displayed five non-cancelled rows, matching the API's five. Searching this patient's UHID showed one row in each UI and in the API. Planned appointment-doctor text was present in both. |
| Whole-day original vs snapshot totals | Pending source review | Live original UI displayed four rows, dated imported snapshot/prototype displayed five. The chosen patient's row agrees. Cause of the remaining whole-day difference is not established; do not call it confirmed export drift or a migration loss without source review. |
| Planned vs actual doctor | Kept distinct | Selected historical appointment's planned doctor differs from the restoration record's recorded doctor. They are different source events, not evidence for rewriting attribution. |
| Prototype populated print output | Verified for content and basic preview layout | In-page preview contains the selected patient identity and both recorded doctor/material values. A4 rule present; no horizontal overflow in preview frame. No physical printing was submitted. Full page-break/pixel-layout acceptance is not established by these checks. |
| Original print output | Inconclusive in in-app browser | Original popup print action did not expose a new browser tab, iframe or accessible print-preview window. Do not claim byte/pixel parity with the original printed document. |

## Print correction

Clinical Sheets used `window.open()` and automatic printing. The original/prototype
popup action was not observable in the in-app browser. Prototype now uses the same
`PreviewModal` already used elsewhere in the clinical app. Existing sheet builders
and generated content are retained; the modal's Print button still opens normal
browser printing. The original site was not modified.

`Print Sample` now always uses a clearly labelled SAMPLE identity, even with a real
patient open, so fictional example teeth are never printed under that patient's
name. The render regression reproduced a blocked-popup failure first, then verified
populated preview, close behavior and SAMPLE separation without any save/API call.

## User decision: unverified details stay separate

User approved retaining unverified/ambiguous details separately for Viveyk/source
owner verification later, rather than treating them as confirmed clinical facts.
Private packet: `realdata-review/verification-pending/` under the ignored runtime:

- 1,993 registration-date estimates (UHID month / earliest activity).
- 325 register-derived receipt-description suggestions.
- 219 finance opening estimates, not clinician-authored plans.
- 77 recovered identities requiring identity/registration review.
- Nine existing source exception CSVs and the unresolved UI comparison issues.

Packet contents contain real patient information. They are not in Git, are not
served by the tunnel, contain no application credentials, and have not been sent
to anyone. Share privately only with the authorized reviewer. Corrections need
source evidence, reviewer identity/date and an explicit decision; no automatic
merges by name/phone or conversion of opening balances into clinical plans.

Opening estimates remain in their existing storage for financial compatibility;
Dashboard and organization reports now exclude them from clinical plan counts and
show them separately as unverified. No source amounts/records were deleted or
rewritten. This packet is the known-exception inventory, not certification that
every other historical field is accurate.

## Final technical checks and newly preserved CRM exception

Backend suite308/308 passed, followed by3/3 focused CRM identity regressions;
TypeScript/build and the113 original report arithmetic checks pass. Protected HTTP
verifier34/34 passes, including one clinical plan versus219 opening estimates.
Synthetic-only preview screenshot: `evidence/clinical-sheet-preview-sample.png`.
No real-data screenshots or prints were added to Git.

The final independent comparison confirms all original patient/master/clinical/
finance fields and all three attachment checksums still match. CRM is **not** a
clean current fingerprint match: two pipeline storage IDs/order values changed,
and one pipeline's stages differ from the previously approved review fingerprint.
All original CRM entities were found using stable `data.id`; patient-contact/lead
payloads did not change. The old fingerprint was reconstructed exactly from
existing audit rows before classifying this newer change. No pipeline or reviewer
changes were overwritten or silently accepted. Private before/after configuration
is in `verification-pending/PRIVATE-crm-review-changes.json` for Viveyk to verify.
The strict verifier continues to flag it; `--report-pending` records the other
checks while keeping `complete:false` and a nonzero status. Do not describe this
newer stage change as already approved or as patient loss.

## Before demo sharing

The one-patient historical Daysheet filter and populated restoration/doctor/material
rendering checks are closed. Remaining focused review items: reconcile the whole-day
4-vs-5 discrepancy and the preserved CRM pipeline-stage change; verify an actual authored Treatment Plan when one exists; confirm
original print/page-break layout in a browser that exposes its print preview; obtain
source-owner corrections for pending records. Complete visit/item-usage history and
historical staff authorship remain incomplete and must not be advertised as delivered.

Temporary review credentials were rotated again after this comparison on 6 November;
old sessions ended and the34 protected HTTP checks passed with the new logins.
Use the updated private demo-logins.txt and sign in again. No CRM UI access was
needed for the comparison or the read-only fingerprint diagnostics.
