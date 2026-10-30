# Database structure and queries

PostgreSQL 18. One shared database serves many clinics. Every clinic table carries `clinic_id`, and row level security (forced, with `app_clinic_id()` set per request) hides other clinics' rows. Schema lives in `api/migrations/` (0001 to 0014); a changelog of the reasons sits in each file's header.

## 1. How a request sees the data

1. The browser sends the session cookie. The server hashes it and finds the session, user and clinic.
2. The server opens a transaction and sets `app.clinic_id` and `app.user_id` for that transaction.
3. Every query on a clinic table is filtered by the database itself (`clinic_id = app_clinic_id()`). A query written without a clinic filter still returns one clinic only.
4. A trigger writes each insert, update and delete to `audit_log` (password hashes and password settings are removed from the copy).

## 2. Tables by area

| Area | Tables | Purpose and key rules |
| --- | --- | --- |
| Tenancy and access | `clinics`, `app_users`, `sessions`, `audit_log` | Clinic settings (UHID scheme, timezone); staff logins and roles; hashed session tokens, 12-hour expiry; before/after rows of every change |
| People | `patients`, `patient_registrations`, `pending_registrations`, `uhid_counters`, `uhid_reservations` | One row per UHID (unique per clinic). The registration form is its own row each time it is taken, so history is kept. A shown UHID is reserved before saving, so numbers can leave gaps but never repeat |
| Staff and resources | `doctors`, `staff`, `chairs`, `panels`, `panel_rates` | Named lists, unique by lower-case name per clinic; panel rate cards per panel |
| Diary | `appointments`, `blocked_slots`, `daily_register` | An exclusion constraint stops two live bookings overlapping on one chair; a cancellation needs a reason; check-in, engaged and checkout times must be in order; one daily-register row per patient per day |
| Money | `receipts`, `receipt_counters`, `expenses` | `receipt_no` is a per-clinic running integer from `next_receipt_no()`; `legacy_receipt_no` keeps an old printed number; the app never deletes a receipt; an expense is voided, not removed |
| Treatment | `treatment_plans`, `treatment_cases`, `procedure_library` | A plan's `estimate.total` is what balances are measured against; cases carry their stages as JSON; the library is each clinic's own copy |
| Clinical | `clinical_records`, `clinical_sheets`, `care_plans`, `consents` | Flat forms are one row each with the form's own headings in `fields` (jsonb); tooth charts per sheet type; consents are append only |
| Files | `patient_documents` | Metadata only (name, type, category, size, storage key). The file lives in storage, see section 5 |
| Settings and masters | `clinic_settings` (key to jsonb), `pick_lists`, `treatments`, `medicines`, `implant_brands`, `appointment_reasons`, `holidays`, `signatures` | Screen passwords are stored hashed |
| CRM | `crm_records` (collection, position, jsonb), `crm_lead_inbox` | Each CRM list is saved whole |

Housekeeping columns on every clinic table: `version`, `created_at`, `updated_at`, `created_by`, `updated_by`. Foreign keys to tenant tables include `clinic_id`, so a row can never point at another clinic's row.

## 3. Relations (short form)

`clinics` 1-n everything. `patients` 1-n `patient_registrations`, `appointments`, `receipts`, `daily_register`, `clinical_records`, `clinical_sheets`, `treatment_plans` (one per UHID), `treatment_cases`, `care_plans`, `consents`, `patient_documents`. `panels` 1-n `patients` and `panel_rates`. `doctors` and `chairs` 1-n `appointments`. A clinical row stores the UHID as text as well as `patient_id`, so a row loaded for a patient who is not registered yet is kept and can be linked later.

## 4. The queries behind the main screens, and their indexes

| Screen | Query shape | Index used |
| --- | --- | --- |
| Open one patient | `patients WHERE uhid = ?` | unique `(clinic_id, uhid)` |
| Patient search | `lower(uhid), lower(full_name), mobile LIKE %x%`, limit 20 | none (leading wildcard); fine to many thousands of patients, then add a trigram index (`pg_trgm`) |
| Diary for a day | `appointments WHERE starts_at >= day AND < next day` | `appointments_day (clinic_id, starts_at)` |
| A patient's visits | `appointments WHERE patient_id = ?` | `appointments_patient` |
| Daily register | `daily_register WHERE visit_date = ?` | `daily_register_day` |
| Receipts for a day | `receipts WHERE receipt_date = ?` | `receipts_day` |
| A patient's receipts and balance | `receipts WHERE upper(uhid) = ?` | `receipts_patient_upper` (0014) |
| Finance summary and collection | `GROUP BY date_trunc(...)` over receipts | sequential scan, a few ms at this size |
| Outstanding list | plans left-joined to receipts grouped once by `upper(uhid)` | one pass over receipts (was one lookup per plan) |
| Clinical record list | `clinical_records WHERE tab_name = ? AND upper(uhid) = ? ORDER BY recorded_at` | `clinical_records_patient` |
| Treatment case | `treatment_cases WHERE upper(uhid) = ? AND procedure_code = ?` | `treatment_cases_patient` |
| Documents | `patient_documents WHERE upper(uhid) = ? AND deleted_at IS NULL` | partial index `patient_documents_patient` |
| Expenses | `expenses WHERE expense_date BETWEEN ...` | `expenses_day` |
| Audit | `audit_log WHERE table_name = ? AND row_id = ?` or by time | `audit_log_row`, `audit_log_time` |

## 5. Attachments

Metadata in `patient_documents`; the bytes in a storage module (`api/src/storage.ts`). Today it writes to a folder per clinic on the server. The agreed direction is a per-clinic storage setting: local folder, S3-compatible bucket, or the clinic's existing Google Drive folder (K.B. Dental keeps Drive). A key is always `<clinic uuid>/<document uuid>`, so nothing a user types becomes a path. Reads go through the API, which checks session, role and clinic first.

## 6. Rules worth knowing before changing anything

- Add every new clinic table with `clinic_id DEFAULT app_clinic_id()`, the housekeeping columns, and `SELECT enable_tenant_table('t')`.
- Dates are the clinic's local days; use `clinic_today()`, never the server's timezone.
- Do not edit an applied migration once a real deployment exists; add a new file.
- A `{success:false}` result from a screen action rolls back the whole transaction.
