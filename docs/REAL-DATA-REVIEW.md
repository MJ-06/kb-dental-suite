# Real-data review: 5 November2026

User-approved scope: existing30–31 October exports; latest2000 patients by
registration timestamp, with all available linked records and files. Basic launch
retains current screens and new backend storage. Essential/Growth/Enterprise are
accepted as tier categories; all capabilities are enabled now, tier UI/billing later.

## Current review deployment

Dedicated PostgreSQL database `kb_realdata_review`, runtime/owner roles, sessions,
configuration and local document root. Source `kb_rehearsal` is read-only during
copy/verification and remains unchanged. The original2499-patient rehearsal and
workbook snapshots are retained. A new independent full migration rehearsal is in
`kb_realdata_full_rehearsal`:2499 patients,5161 register entries,4308 clinical form
entries,306 appointments,220 Treatment Plans,1683 receipts,1226 expenses and2511
CRM rows. All compared source fields and the3 file checksums match in that database
as well. It is private and is not tunneled. The demo subset is not the production
cutover or acceptance of unresolved original spreadsheet exceptions.

Server: loopback8300. Cloudflare URL is temporary and is shared in the main chat.
The application requires a staff login before reading patients. Private credentials:
`api/.organization-demo-runtime/realdata-review/demo-logins.txt`. Clinic code
`kb-review`; review users admin/doctor/reception/accounts have distinct passwords.
Share credentials only
with the authorized reviewer; no credentials, source rows or documents belong in Git.

The source has one clinic's care history. KB Main Clinic retains that attribution;
KB Second Clinic starts without historical clinical rows. Opening a central patient
there may create its internal reference; no historical care is copied or invented.

## Reconciled selected data

| Data | Imported |
|---|---:|
| Patients and registration-history rows | 2000 each |
| Appointments | 252 |
| Daily register entries | 4280 |
| Clinical form entries | 3581 |
| Clinical charts | 22 |
| Treatment cases | 25 |
| Treatment Plans | 200 |
| Receipts | 1491 |
| Clinic expenses | 1226 |
| Patient documents | 3 |
| CRM contacts linked by explicit UHID | 2000 |
| CRM leads / pipelines / companies | 6 / 2 / 1 |

Doctor/chair/panel/treatment/medicine/procedure masters are copied. Existing entity
IDs and visible UHIDs are retained. CRM source IDs remain passive links; this is
not external CRM synchronization. Expenses are clinic-level, not filtered by patient.
Care Plans and consents have no saved source rows in this snapshot. Source workbook
Care Plans tabs were checked and are empty. Do not add fictional clinical facts to
real patients merely to fill an empty screen.

Financial totals match the selected source rows. Independent verification compares
the original fields by stable IDs for patient, registration, appointment, register,
form, chart, case, plan, receipt, expense and document records. It also checks exact
patient selection and all3 original/copy document checksums. Private count-only
reports are under the ignored runtime folder.

The independent comparison caught a date-only conversion defect in the initial
copy. A read-only diagnostic proved every discrepancy was the same one-day shift,
with zero other field differences. The exact source DATE values were restored in
the marked review, transactionally, without removing or merging records. The
importer now preserves PostgreSQL DATE literals instead of JSON-serializing local
midnight Date objects. A full independent comparison then passed for every field
checked and all documents. Original source dates were never modified.

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

From `api/`, after local prerequisites and private source rehearsal are available:

```powershell
node --import tsx scripts/provision-realdata-review.ts
node --import tsx scripts/provision-realdata-review.ts --apply
node --import tsx scripts/supplement-review-crm.ts
node --import tsx scripts/verify-review-data.ts
node --import tsx src/realdata-review-server.ts
```

Provisioning creates a new marked target only and refuses incomplete/unmarked
targets; it retains a completed existing review rather than wiping reviewer edits.
Database/source credentials are read privately and never printed. Source table
and record differences are reported as counts, not patient values.

In another terminal, run official cloudflared against `http://127.0.0.1:8300`, then:

```powershell
node --import tsx scripts/verify-realdata-review.ts https://YOUR-URL.trycloudflare.com
```

That script checks authenticated patient access, exact2000 count, screen contracts,
full capabilities, native role APIs and permission boundaries without printing
patient values. Independent browser QA should use CUA on the signed-in page and
record pass/fail per screen. Use synthetic test DBs for destructive/write journeys;
do not add invented clinical histories to migrated real patients.

## Remaining launch gates

For the separate full-data rehearsal, run
`node --import tsx scripts/provision-realdata-review.ts --all --apply` then
`node --import tsx scripts/verify-review-data.ts --all` from `api/`.

After independent verification finishes, run
`node --import tsx scripts/rotate-review-credentials.ts --apply` to rotate temporary
staff/screen passwords, end old sessions and update the private login file. Do not
rotate while verification is still using those credentials.

Independent browser/basic-flow review and source-to-workbook reconciliation must
distinguish accepted imported records from original duplicate/orphan/rejected rows.
The existing ignored `migration/data/out` reports retain those unresolved source
exceptions. Their existence is not silently treated as production data acceptance.
The2000-patient review is ready for verification, not proof that every original
workbook row is accepted or that production cutover is complete. Inventory, assets
and attendance exports remain outside the current clinical-screen migration scope.
Keep originals privately; no source workbook has been deleted or overwritten.
