# Improvements identified during verification — 6 November 2026

Keep the familiar clinical screens. This backlog distinguishes observed problems,
source-code risks and proposed follow-on work; it does not mean full clinical or
launch acceptance is complete. See UI-COMPARISON-2026-11-06.md for the focused checks.

## Before launch

| Priority | Finding | UI improvement | Backend/data improvement and acceptance |
|---|---|---|---|
| 1 | Historical Daysheet initially showed unrelated rows despite a committed date; explicit Refresh showed four matching snapshot bookings. The snapshot/API has five. | Keep selected date and displayed results synchronized, show which date loaded, retain clear retry/error states. | Add a failing asynchronous-response regression before changing code; ignore obsolete requests. Separately reconcile the one remaining source/snapshot booking. A loading fix alone does not explain that booking. |
| 1 | Legacy importer infers appointment outcomes from age. | Identify imported/inferred statuses when reviewing attendance; do not label these as confirmed attendance. | `migration/import_sheets.py` changes historical Scheduled to No Show, and Checked In/In Chair to Completed. Inventory affected raw rows, preserve original status and transformation provenance, and obtain source-owner decisions before relying on attendance/completion metrics. Affected-row count and correction are not yet established. |
| 1 | Imported dates, suggested receipt descriptions, recovered identities and financial opening estimates need review. | Clear labels and a review list; distinguish financial estimates from clinician-authored plans. | Extend the private pending-verification packet with newly discovered transformations. Preserve raw values, source references, reviewer decisions and correction audit. Never invent missing doctor/staff attribution. |
| 1 | Two supplied PDFs are image-only, sideways content on portrait US Letter pages. Their Restoration content matches the reference fields. | Consistent preview, paper size, orientation and page breaks. | Verify the actual downloaded PDF, including multipage output, not only iframe HTML. Prefer searchable text where feasible. Existing in-page preview does not prove PDF fidelity. |
| 1 | CRM comparison found changed storage IDs/order and one changed pipeline stages payload. Contact/lead payloads match. | Preserve user configuration; avoid accidental changes when simply opening a screen. | Resolve the pending stages difference with the owner. Use stable domain IDs and versioned per-record writes rather than collection replacement; audit changes and detect concurrent edits. Strict current CRM fingerprint remains unresolved. |
| 1 | Recovery/cutover has not received final launch acceptance. | Clear errors for failed loads/saves, without presenting failures as empty records. | Rehearse database plus attachment backup/restore, fresh-machine setup, migration reconciliation and rollback. Counts alone do not establish clinical correctness. |

The first Daysheet observation and absence of a request-generation guard in
`index.html` support an asynchronous stale-response risk. A controlled regression
still needs to establish the exact mechanism before calling the defect fixed.
The four-versus-five comparison concerns bookings on one historical day, not the
number of patients imported or a missing patient history.

## Small UI improvements in the existing layout

- Show patient-opening progress and prevent late callbacks from unexpectedly
  replacing the screen the user selected while loading.
- Keep clinic, applied date range, doctor filter and patient context visible and
  consistent across Daysheet, reports and patient history.
- Group dense record-entry fields, make required fields explicit, and provide
  reliable save feedback and protection against losing unsaved edits.
- Present a patient timeline with clinic, recorded treating doctor, treatments,
  materials and documents. Keep appointments, planned treatment, performed care
  and finance visibly distinct.
- Replace legacy clinic-profile Group/copy/share concepts with real organization
  membership/settings only when that workflow is implemented; metadata is not
  authorization or patient sharing.
- Improve keyboard navigation, labels, responsive tables and print controls while
  retaining the current navigation and clinical form structure.

These are proposed refinements, not all verified defects or changes implemented
in this review. A broad visual redesign remains a separate phase.

## Backend work that supports later features

1. Add first-class visits linked to the existing organization patient identity
   and UHID, clinic and actual treating doctor. Keep appointment doctor separate.
   Permit historical passive links without forcing a new unified UI immediately.
2. Link performed procedures and material usage to visits, including quantity,
   unit and batch where applicable. Preserve unknown historical values and
   distinguish recorded care from inferred links. Full inventory is separate scope.
3. Map doctor/material/staff fields per historical form. Record clinical author
   separately from importing/updating account; corrections need an audit trail.
4. Make imports repeatable and idempotent with stable source IDs, raw-value
   provenance, checkpoints and exception reports. Compare raw workbook facts as
   well as the already-transformed rehearsal database.
5. Use shared server-side report filters and pagination for growing datasets;
   publish metric definitions and return applied clinic/date scope with results.
   Do not equate receipts with profit or scheduled doctors with performed work.
6. Add optimistic concurrency to edits and stable document/form-version links.
   Avoid long-term dependence on mutable sheet-row positions or whole-list writes.
7. Automate the shared test-database lock, or provision isolated test databases,
   before permitting concurrent test runs. Current tests must remain serial.

Tiers, external CRM integration, Sales Tracker and labs remain later scope.
Existing UHID remains the staff-facing patient identifier; internal relational IDs
support links without requiring patients to be registered again at each clinic.

## Acceptance gained during this follow-up

- One imported authored Treatment Plan exists independently of the financial
  opening estimates. All six procedure/tooth/price rows and other visible clinical
  controls matched the original UI; normalized full preview text matched exactly.
  No plan was created or saved on either site for this check.
- The two user-supplied PDFs are populated Restoration outputs, not Treatment Plan
  PDFs. Their selected recorded doctor/material fields match the prior reference.
- Explicit original Daysheet Refresh gives four snapshot-matching identities;
  one of the five snapshot bookings remains unmatched. No cause is asserted.

Earlier passing backend/API checks remain useful evidence, but do not close the
pending source discrepancies, actual PDF layout, full clinical-history mapping,
historical staff attribution or backup/restore gates. No new fixes or full-suite
run are implied by this follow-up inventory.
