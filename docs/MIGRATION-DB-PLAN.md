# Data migration and database plan (30 Oct 2026)

Status of the data: **I could not find the Sheets exports or the Drive folder.** They are not on this laptop (I searched `D:\Projects`, Desktop, Downloads and Documents) and the project library is empty. So nothing below is based on the real rows yet. It is based on the Apps Script code and the schema already built. Where the data may differ, I say so.

## 1. Why a separate reviewer found what we did not

- **Same author, same blind spot.** I checked what I knew to ask: SQL injection, headers, secrets in git, uploads. The three findings were questions I had not asked: *what does the audit trigger copy?*, *what rides in a URL?* and *can a doctor change someone else's signature?*
- **They came from inherited design.** The audit trigger was written once for every table. The login-in-the-URL pattern came from the old Apps Script protocol. The signature action was ported as-is, with a role check but no check on whose object it is.
- **My tests proved what I built, not what an attacker would try.** Passing tests said nothing about those cases.
- **Why a second reader helps.** A reviewer starts from the attacker's side (every input, every secret, who can touch which row) rather than from the feature.

What changes from now on:
1. A written checklist for every module before commit: secrets in logs or audit, credentials in URLs, input size limits, object-level permission (whose record is it?), and what the generic triggers copy.
2. A test for each checklist item, written first.
3. The independent review runs on every push, and its findings are fixed before I report a module done.
4. I will not say "no more issues". Reviews keep finding things, and the honest claim is "checked against this list".

## 2. Routes and transitions: what I verified, and what I did not

Verified today by script:
- The four screens call 89 distinct actions. Every one is implemented, or is auth (`staffLogin`, `staffLogout`, `authStatus`, `ping`, `batch`), or is a generated list action (`get...List` and `save...List`, password saves). None answers "Unknown action".
- Treatment-case stage rules are pure functions with unit tests, and booking and resolving use their own permissions.

Not verified, so I cannot say it is complete:
- That each action behaves correctly when a real screen drives it. Only the flows listed in STATUS.md were clicked through; the rest are tested through the backend only.
- The treatment-case transitions against `docs/ClinicalSuiteTreatmentCaseSpecV2.md`, line by line. I will do that comparison.
- I am not sure which "path transitions" you mean beyond these. If you mean something else, such as the patient journey from registration to billing, tell me.

Known missing: a screen for the audit trail, a public patient chatbot, a phone layout, two-factor sign-in, and the shared REST API beyond auth, patients and appointments (the screens use `/exec`).

## 3. Database plan

**Schema (built).** 38 tables in `api/migrations`: clinics, app_users, sessions, panels, doctors, chairs, staff, pick_lists, treatments, medicines, panel_rates, clinic_settings, holidays, signatures, patients, patient_registrations, appointments, blocked_slots, daily_register, receipts, expenses, treatment_plans, clinical_records, clinical_sheets, care_plans, consents, procedure_library, treatment_cases, patient_documents, crm_records, crm_lead_inbox, audit_log, and counters. Every clinic table has `clinic_id`, forced row level security, version and audit columns.

**Mapping from the Sheets**

| Sheet or tab | Goes to |
| --- | --- |
| Registrations (main and panel books) | `patients` plus `patient_registrations` (a panel patient keeps the panel and the billing book) |
| Pending | `pending_registrations` |
| Appointments, Blocked Slots | `appointments`, `blocked_slots` |
| Daily Register | `daily_register` |
| Patient Fee Receipt (finance) | `receipts` (the receipt number series continues from the highest imported number) |
| Expenses (finance) | `expenses` |
| Treatment Plans | `treatment_plans` |
| Treatment Cases, Procedure Library | `treatment_cases`, `procedure_library` |
| Care Plans, Consents | `care_plans`, `consents` |
| Clinical flat tabs (Restoration, Prescriptions and so on), Clinical Sheets tabs | `clinical_records`, `clinical_sheets` |
| Masters (doctors, chairs, panels, medicines, treatments, lists, timings, holidays) | their own tables, `pick_lists`, `clinic_settings` |
| Signatures | `signatures` |
| CRM tabs and CRM Lead Inbox | `crm_records`, `crm_lead_inbox` |
| Patient Documents plus the Drive folder | `patient_documents` plus object storage |
| Old registration book | read only, folded into patients where the UHID matches |

**Importer.** Viveyk's `migration/import.js` targets the older `database/schema.sql`, not this schema. I will write a new importer that:
- reads the .xlsx files directly (no Apps Script run needed);
- runs as the owner under the new clinic id, in one transaction per module;
- is idempotent (upserts keyed on UHID and receipt number);
- keeps every UHID as it is, because `next_uhid()` never goes below the highest one imported;
- converts dates to the clinic's timezone;
- reports every row it cannot place (a CSV of rejects) instead of dropping it;
- prints a count check per tab against the sheet.

Passwords are not migrated. Sheet screen passwords become new hashed settings, and staff sign-in accounts are created fresh.

**Indexes.** I have not yet reviewed the existing indexes against the screens' queries. What I know is in place: unique per clinic on UHID, receipt number and username; `appointments (clinic_id, date, chair)` for the diary; `receipts (clinic_id, patient, date)` for balances; `audit_log (clinic_id, table, row)` and `(clinic_id, time)`. After the real data loads I will run `EXPLAIN` on the slowest screens (patient search, outstanding list, daily collection, clinical records list) and add indexes only where they show a scan. Patient name and phone search should use a trigram index if the rows run past a few thousand.

**Queries I will check once data is in:** patient search by name, phone or UHID; today's diary; outstanding balances per patient; the daily collection and P&L; the clinical record timeline for one patient.

## 4. Attachments

Private S3-compatible object storage (Cloudflare R2, Backblaze B2 or AWS S3 Mumbai), with only metadata (key, size, type, checksum, clinic, patient) in `patient_documents`. About 0.5 to 2 rupees per GB a month. It keeps database backups small, uses versioning plus a second copy for backup, and is never public. The API checks session, `clinical:read` and clinic, then streams the file or gives a link that expires in minutes. Keys are prefixed `clinics/<clinic_id>/`. Until hosting is chosen, files stay in the laptop folder. The Drive files are copied across once at migration time, with a checksum for each. Details are in STATUS.md.

## 5. What I need from you

1. **Where the files are.** Put the .xlsx files and a zip of the Drive folder in `D:\Projects\kb-dental-suite\migration\data\` (git-ignored) or upload them to the project library, and tell me which book is which.
2. Whether the Script Properties `FINANCE_SHEET_ID` and `CLINICAL_SHEET_ID` point elsewhere.
3. A yes on the object storage recommendation, and which provider and region.
4. What you meant by "path transitions", if it is not the treatment-case stages.
