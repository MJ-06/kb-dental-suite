# Central patient access and permitted clinic history

3 November 2026. Latest user clarification: create a patient once at the organization
level; clinics own the care, treating-doctor attribution, treatments and items used.
CRM should link to the organization patient identity, not create a second identity
for each clinic. This supersedes the earlier explicit Add to clinic workflow.

## Steps 1 and 2 now available

1. Search the organization patient directory and open the patient directly. There
   is no Add to this clinic confirmation or second patient-registration workflow.
2. In the existing patient folder, choose Patient History. View permitted clinical
   source records across clinics, newest first, or filter to a permitted clinic.

History includes medical/registration snapshots, care-register entries, selected
clinical form fields, chart-update summaries and treatment-case openings. Each entry
shows its source clinic/date and the recorded treating doctor when the source has
one. Missing doctor attribution is labelled, never inferred from the logged-in user
or record author. Date-only register entries display only a date, not a fabricated
visit time. Selected material/lot fields from older forms are shown under their
source clinic. They are not a structured consumption ledger or inventory system.
Saved forms, register rows and charts may describe the same care; they are not
counted or presented as independent completed visits. Full specialty-form bodies,
attachments, payments and every prior chart revision are not exposed in this summary.

## One identity, clinic references

org_patients is the central identity. The organization patient UUID is available in
search, openOrganizationPatient, getPatient and the patient UI context, for future
CRM integration. Use organization ID + organization patient UUID for integration
keys; clinic-local UHIDs may be historical aliases and are not global person keys.
This change does not migrate the legacy embedded CRM's current data contracts.

Migration0026 adds a permission-checked open helper. Older clinical tables require
clinic-local patient foreign keys, so the backend creates an internal reference if
needed, linked to the existing central identity. Opening again reuses that reference;
it does not create another organization identity, copy clinical history or let a
read-only user edit demographics. Clinic-local registration/detail snapshots remain
part of the transitional schema. Complete physical schema consolidation is future
work; do not describe local compatibility rows as fully removed.

New Registration still uses the older clinic-facing entry form and publishes the
identity centrally. Existing ambiguous duplicates are never automatically merged.
Staff should search for returning people rather than enter them again. Organization
registration duplicate review and base-version protection for legacy registration
writes remain explicit backlog items from the previous identity milestone.

## Access and pagination

History requires patients:read in the active context, then patients:read AND
clinical:read on each source clinic's currently active mapped account. It derives
source clinics from the authenticated session principal's explicit grants. Organization
management alone does not bypass clinical permissions. Each clinic's records are
read under its tenant context; the original context is restored before returning.
No unrestricted patient/clinical RLS policy was introduced. Invalid/foreign patient
IDs and unauthorized clinic filters are refused. Revoked grants/permissions are
re-evaluated on every request, including pagination.

Only permitted clinic names and records are returned. A generic scope note avoids
exposing hidden clinics or counts. Payments and fee fields are excluded; clinical
form details use a scalar-field allowlist rather than returning whole untyped JSON.
Narrative notes remain clinical content under the source clinical-read permission.

Pages contain up to30 entries, using source timestamp + clinic + type + record ID as
the keyset cursor. Thirty-one rows per permitted source clinic bound page gathering.
The cursor is patient/filter-bound and access is checked again. Pagination was tested
on an unchanged fictional dataset. Reload for new entries/corrections; this is not a
cross-request database snapshot or a benchmark proving large-history latency.

## Try the local demonstration

Open http://127.0.0.1:8080. Search Orion Shared Demo, open it directly and choose
Patient History. The labelled fictional examples show Dr Rowan Example/material A
at the first clinic and Dr Morgan Example/material B at East. Switch the History
Clinic filter to see only that clinic's entries. Existing real/source charts were
not opened or edited for browser acceptance.

After pulling on another laptop, from api/ after the existing setup/linker:

```powershell
npm run db:migrate
node --import tsx scripts/publish-clinical-patient-identities.ts --apply
node --import tsx scripts/seed-shared-patient-demo.ts --apply --history
npm run dev
```

The history fixture is opt-in and limited to the named local development organization.
It writes only clearly labelled fictional care/material examples for Orion Shared
Demo, preserves other patient records and is idempotent. The separate Org A/B demo
servers remain separate runtimes and were not reconfigured by this local fixture.

## Verification and remaining work

The serialized API suite passed283 tests in22 files. The final13-test integration
file also passes after adding read-only-reference and empty-doctor-field fallback
checks. It covers pagination without duplicates, source clinic/doctor attribution,
material fields, excluded fees, unknown IDs, denied/revoked history access, and
read-only patient opening without edit permission. Typecheck/build and inline-script
syntax checks pass. Browser acceptance verified direct opening, the folder History
entry, both-clinic examples and filtering. Evidence:
evidence/central-patient-history-2026-11-03.jpg.

Next is structured visit recording and completion/correction behavior: visit -> clinic
+ actual treating doctor -> performed treatments/stages + item usage. Existing case
stages, clinical forms and print behavior must be mapped into that flow rather than
replaced. Doctor/item histories and metrics then derive from those records. The
separate UI/native-opportunities review remains recommendations, not redesign approval.
