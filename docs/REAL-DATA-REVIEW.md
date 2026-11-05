# Real-data review: 5 November 2026

Latest approved scope: all identifiable patients in the supplied 30–31 October
exports, exposed only through the authenticated laptop-hosted Cloudflare review.
This supersedes the earlier 2,000-patient limit. Basic launch retains the clinical
screens and new backend; tier controls/billing remain later work.

## Current review deployment

The protected review contains **2,576 patient identities**:

- 2,499 patients accepted by the original spreadsheet importer.
- 77 additional named identities recovered from historical workbook records,
  preserving their recorded identifiers. All require identity/registration review;
  they are not proof of 77 additional distinct, fully registered people.

Database `kb_realdata_review`, loopback8300; private full rehearsal
`kb_realdata_full_rehearsal` has the same patient cohort. Original `kb_rehearsal`
and workbooks remain unchanged. Application credentials, sessions and document
storage are separate from the original source. Runtime reports/credentials are
ignored under `api/.organization-demo-runtime/realdata-review/`.

Private login file: `demo-logins.txt` in that directory. Clinic code `kb-review`;
users admin/doctor/reception/accounts have distinct passwords. Share only with
an authorized reviewer. The Cloudflare URL is temporary; inspect the tunnel log
before sharing it. No patient values or passwords belong in Git or chat.

KB Main Clinic retains the source clinic's care. KB Second Clinic starts without
invented historical care; opening a shared patient creates a compatibility
reference, not a second registration or a copy of the original treatment history.

## Imported data and verification

| Data | Count |
|---|---:|
| Central patient identities | 2,576 |
| Recorded registration-history rows | 2,499 |
| Appointments | 306 |
| Daily register entries | 5,161 |
| Clinical form entries | 4,308 |
| Clinical charts | 25 |
| Treatment cases | 31 |
| Treatment-plan table rows | 220 (219 finance opening estimates; 1 other source plan) |
| Receipts | 1,683 |
| Expenses | 1,226 |
| Patient documents with matching checksums | 3 |
| Original CRM rows / inbox rows | 2,511 / 3 |

The existing review retains one additional CRM pipeline. The familiar UI had
already transformed six leads and one pipeline during its own migration; these
updated payloads were preserved under their original source row IDs. Seven
append-introduced collisions were removed without losing those UI changes.
Three duplicate CRM entity groups already exist in the source and remain a
separate review item. All original patient, master, clinical and finance fields
compare equal by stable source IDs. CRM comparison records explicit fingerprinted
exceptions for the seven preserved UI transformations. All three available copied attachments match source
checksums. The 77 recovered identities were separately compared directly against
workbook demographics and provenance in memory; no patient-bearing audit ledger
was written. Unknown patient type remains NULL; no registration-history row or
fictional clinical care was created for these identities.

Care Plans and consent tables have no saved source rows in this snapshot. Source
Care Plan tabs are empty. Existing IDs/UHIDs remain the passive links; external CRM
synchronization is not implemented. Historical rows with no patient UUID retain
that original state rather than silently rewriting clinical source records.

## What was derived, rather than recorded directly?

The earlier importer did transform data; an exact copy of its database does not
make every imported field an original confirmed fact:

- Registration dates: 506 came from source timestamps, 1,886 were estimated from
  the UHID year/month, and 107 used earliest available activity. These origins are
  retained in `patient_registrations.form.reg_date_source` and returned as
  `registrationDateSource` by patient APIs.
- Receipt descriptions: 1,326 were typed in source; 307 were suggested from a
  same-day register entry and 18 from a nearby register entry; 32 were blank.
  `receipts.service_source` preserves the distinction. Suggestions are not proof
  that a particular treatment was performed for that receipt.
- 219 treatment-plan table rows are opening estimates calculated from the Finance
  “Working for Balance” sheet, identified by `estimate.source`. They are not 219
  clinician-authored plans. Current plan-table counts must be interpreted with
  this limitation until the UI separates opening balances from authored plans.
- Older import code normalized identifiers, used technical UUIDs/counters/manual
  receipt references, and defaulted some missing classifications to Normal.
  Original exports and exception reports are retained for review.
- The 77 newly recovered identities use recorded names/identifiers and available
  unambiguous demographics. Missing data remains absent. Their technical database
  creation timestamp is explicitly not a registration date; APIs hide it as such.
  `patients.import_provenance` retains source references and recorded variants;
  `org_patients.import_review_required` keeps the flag visible across clinics.

No new diagnoses, treatments, payments, names or contact details were invented to
fill the recovered records. Internal UUIDs and audit timestamps are system metadata.

An earlier date-copy bug was found and corrected using exact source DATE values;
future imports preserve PostgreSQL DATE literals. Source dates were not modified.

## Source exceptions still requiring review

Coverage scanned 82 patient-identifier tabs and 57,474 nonempty rows. Beyond the
accepted cohort, recovery found 39 standard-format and 38 legacy-format named
identities. Five other standard identifiers remain unresolved (one conflicting
name, four without a name); 24 other nonstandard named identifiers and 13 named
rows without identifiers also need review. Many other tokens are malformed or
unnamed references and cannot safely be treated as additional people.

Do not split combined identifiers, merge by phone/name, or manufacture missing
names to force these rows into patients. The original private exception reports
and exports remain the reconciliation source. Inventory/assets/attendance are
outside the current clinical-screen migration scope. This is a migration rehearsal
and review deployment, not completed production cutover or proof that every raw
spreadsheet row has been accepted.

## Updated UI and backend

Viveyk branch3389d7b merged: CGHS Records stages, endorsement/prescription/bill
flow, finance CGHS bill register, tooth regions/bridge ranges, Treatment Plan save
correction, RCT sealer/accessory cone and implant second-stage fields.

Local `saveCghsBill` / `getCghsBills` now persist clinic-scoped bills with atomic
monthly counters. Finance permission is required. Migrations0030/0031 supply tables
and housekeeping. Existing Treatment Plans already upsert one row per clinic/UHID,
so the old Sheets first-row/last-row mismatch does not apply to this backend.

Roles & access is a native React component in the familiar Master UI. It supports
staff creation, role assignment, activation/deactivation, password reset, grouped
role permissions and activity history using the existing server permission gates.
It no longer embeds the separately styled roles page. Browser acceptance remains
distinct from API tests and the native component render regression.

Backend tier foundation: `/api/v1/capabilities`, stable feature catalogue and three
plan definitions. Organization `subscription_policy` is enterprise/full here.
No tier UI or billing is added. Enforced mode can gate organization reports, CRM,
custom forms, storage integrations and AI entry points independently of staff
permissions. Clinic/staff/storage quotas and billing lifecycle automation are not
implemented and must not be sold as completed. External AI/provider calls remain
disabled/unconfigured in the public review; this does not reduce staff permissions.

## Reproduction and verification

From `api/`, with prerequisites and the private original rehearsal available:

```powershell
node --import tsx scripts/provision-realdata-review.ts --apply
node --import tsx scripts/provision-realdata-review.ts --all --apply
node --import tsx scripts/migrate-realdata-review.ts
node --import tsx scripts/migrate-realdata-review.ts --all
node --import tsx scripts/import-additional-patients.ts --apply
node --import tsx scripts/expand-review-all.ts --apply
node --import tsx scripts/reconcile-review-crm.ts --apply
node --import tsx scripts/verify-review-data.ts --review-all
node --import tsx scripts/verify-review-data.ts --all
node --import tsx scripts/verify-recovered-patients.ts
node --import tsx src/realdata-review-server.ts
```

Provisioning creates marked targets and preserves completed targets. Expansion is
append-only from the private full clone and preserves existing reviewer records.
The current final aggregate report is `all-patients-expansion-summary.json`;
`verification-summary.json` retains the initial financial snapshot for historical
comparison. Use current original-field verification for the expanded cohort.
Do not run the Python migration-payload mode directly: it is consumed privately
in memory by the importer/verifier and must never be printed or saved as an audit
ledger. Install the existing Python/openpyxl prerequisites on a fresh laptop.

Run official cloudflared against `http://127.0.0.1:8300`, then:

```powershell
node --import tsx scripts/verify-realdata-review.ts https://YOUR-URL.trycloudflare.com
```

The 33 HTTP checks pass for the expanded cohort, including login, anonymous denial,
patient counts, clinical contracts, full capabilities, role APIs and permission
boundaries. The full backend suite passes 300/300, including the incomplete-import regression;
TypeScript passes. Independent Luna QA owns `QA-REAL-DATA-REVIEW-2026-11-05.md` and distinguishes
browser/API checks from synthetic write tests. Real patient histories are read-only
during verification; all invented write journeys use the separate synthetic demo.

Temporary staff/screen credentials have now been rotated after independent QA;
prior sessions were ended and all 33 public HTTP checks passed with the new logins.
Use the updated private login file and sign in again. For later authorized rotations:

```powershell
node --import tsx scripts/rotate-review-credentials.ts --apply
```

The private login file is rewritten; do not paste its contents into chat.
Remaining launch gates: review source exceptions and inferred values, accept each
clinical screen and printed output, rehearse backup/restore and final cutover,
resolve any independent QA findings. Tier billing/quotas and external integrations
are not implied by the current full-access backend capability mode.
