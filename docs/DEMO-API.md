# Organization demo API (implementation contract)

All domain paths below start `/api/v1/organization`. JSON responses use database
snake_case fields; errors are `{error:{code,message}}`. All writes are POST JSON.
All protected requests carry host-only `org_session` cookie and the configured Host.
Optional Origin must equal configured origin. Every unit write carries `unit_id`
explicitly, never session-global selected-clinic state. UUID IDs are opaque strings.

## Authentication and bootstrap

- `GET /health` -> `{status:"ok",code}` (database and identity checked).
- `GET /api/v1/organization` -> `{organization:{id,code,name,hostname,timezone,currency}}` (public identity).
- `POST /api/v1/auth/login {username,password}` -> `{user,units}` plus cookie.
- `GET /api/v1/auth/me` -> `{user,units}`. User: `{id,username,display_name,permissions}`;
  units: `[{id,code,name,type,permissions}]`. Organization permissions exclude clinical
  by default. Doctor permissions live on explicit unit grants.
- `POST /api/v1/auth/logout {}` -> `{ok:true}`.
- `GET /units` -> `{units}`; `GET /staff` -> `{staff:[{id,username,display_name,permissions,grants:[{unit_id,permissions}]}]}` (access admin).
- `POST /grants {user_id,unit_id,permissions:[string]}` replaces explicit grant; access admin only.

## Patients and appointments

- `GET /patients?uhid=...` or `?phone=...&name=...` -> `{patients}`; exact UHID or
  exact phone plus case-insensitive literal partial-name confirmation. Name must
  contain a letter or number; symbol-only `%`, `_`, or backslash is rejected 400.
  Punctuation is matched literally, never interpreted as SQL wildcards.
  No unrestricted directory dump.
- `POST /patients {unit_id,name,phone,gender?,dob?}` -> `{patient,duplicate_warning:boolean}`;
  organization UHID assigned; phone can repeat. Patient has `id,uhid,name,phone,gender,dob,version`.
- `POST /patients/:id {unit_id,version,name,phone,gender?,dob?}` -> `{patient}`; stale 409.
- `GET /patients/:id?unit_id=...` -> `{patient}` (identity visibility, not history).
- `GET /patients/:id/history?unit_id=...` -> `{notes,submissions}` for that authorized unit.
- `GET /appointments?unit_id=...` -> `{appointments}`.
- `POST /appointments {unit_id,patient_id,doctor_id,starts_at,ends_at,chair?}` -> `{appointment}`;
  ISO timestamps, overlap rejection 409 across clinics for shared doctor.
- `GET /doctors?unit_id=...` -> `{doctors:[{id,display_name}]}` with explicit clinical grants.

## Notes and forms

- `POST /notes {unit_id,patient_id,text}` -> `{note}` immutable finalized note.
- `POST /notes/:id/addenda {unit_id,text}` -> `{note}` (new row with parent_id).
- `GET /forms?unit_id=...` -> `{forms}` assigned current versions; without unit requires forms admin.
- `POST /forms {key,title,fields:[{key,label,required:boolean}],unit_ids:[uuid]}` -> `{form}`;
  publishing same key creates next immutable version and replaces selected-unit assignments.
- `POST /forms/:id/assign {unit_ids:[uuid]}` -> `{ok:true}`; replaces assignments for this version.
- `POST /submissions {unit_id,patient_id,form_id,answers:{key:string}}` -> `{submission}`;
  assigned exact version required, mandatory fields checked.
- `POST /submissions/:id/addenda {unit_id,text}` -> `{note}` immutable correction referencing submission.

## Configuration and finance

- `GET /settings/defaults` -> `{settings:[{key,value,source:"organization",locked,version}]}`;
  requires organization `settings:manage`. `version` is the real organization-default
  row revision; `locked` here means unavailable through the generic default editor
  (identity/access/forms), rather than the clinic override lock.
- `POST /settings/defaults {key,value,version}` -> `{ok:true}`; `settings:manage` only.
  Checks current revision under a row lock (stale 409) and audits the change. Editable
  keys: `contact`, `opening_hours`, `chairs`, `doctor_availability` using the types
  below; `catalogue` is a unique array of 1–100 nonempty strings <=120; `fees` is
  1–100 `{code,name,amount}` rows with unique nonempty code <=40, name <=120 and
  finite nonnegative INR amount <=9999999 with at most two decimals.
  `identity`, `access`, `forms` use dedicated workflows and reject generic writes 403.
  New defaults immediately affect inheriting clinics; explicit clinic overrides
  persist. Resetting an override adopts the current organization default.
- `GET /settings?unit_id=...` -> `{settings:[{key,value,source,locked,version}]}`.
- `POST /settings {unit_id,key,value,version?}` -> `{ok:true}`; allowed keys only
  `contact` (nonempty string <=300), `opening_hours` and `doctor_availability`
  (nonempty string <=1500), `chairs` (unique list of 1–30 nonempty names <=60).
  `version` is required for existing overrides; inherited values use version 0.
- `POST /settings/reset {unit_id,key,version}` -> `{ok:true}` reset override to inherit.
  `fees`, `identity`, `forms`, `access`, `catalogue` are locked organization settings.
- `GET /receipts?unit_id=...&patient_id=...` -> `{receipts,balance}`;
  balance is this clinic's total non-void charges less payments.
- `POST /receipts {unit_id,patient_id,charge:number,paid:number,description}` -> `{receipt}`;
  nonnegative INR values, clinic-prefixed sequence; no cross-clinic balance allocation.
- `POST /receipts/:id/void {unit_id,reason}` -> `{receipt}`; no delete/edit endpoint.
  Returns 409 `negative_balance` when removing the receipt would leave clinic credit
  (for example, a charge already settled by a later payment). Correct/void the later
  payment first. Receipt creation and void serialize on the same clinic/patient
  balance lock; a rejected void changes neither receipt nor audit history.
- `GET /metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&unit_id?=...` ->
  `{from,to,timezone,currency,generated_at,unique_patients,registrations,appointments,collections,units:[{id,name,active_patients,registrations,appointments,collections}]}`.
  Scoped unit totals, distinct organization patients, dates inclusive Asia/Kolkata, INR.
  `unique_patients` counts registered identities in scope/date window;
  `unique_active_patients` deduplicates patients with activity across selected clinics.
  Additional fields: `source_as_of`, per-unit `active_patients`.
- `GET /audit` -> `{events}` safe action metadata, access-admin only.

## Fictional documents (D15)

- `GET /documents?unit_id=...&patient_id=...` -> `{documents:[{id,unit_id,patient_id,filename,mime,bytes,sha256,created_at}]}`; clinical read.
- `POST /documents {unit_id,patient_id,filename,mime,base64}` -> `{document}` with same metadata; clinical write.
  Base64 bytes capped at 1 MiB; MIME is `text/plain`, `application/pdf`, `image/png` or `image/jpeg`.
- `GET /documents/:id/download?unit_id=...` -> attachment bytes; clinical read and
  exact issuing unit required. Random server key selects file, never submitted name.
  Organization-local document root, checksum validation, no external integration.

## Seed contract for operations

`seedOrganization(ownerUrl,{code,name,hostname?,clinics?:[{code,name}],password?:string})`
exported from `api/src/organization/seed.ts`. Idempotent by organization code and
stable username/unit code; refuses a different existing organization. Returns
`{organization,units,users,patients}` without hashes/password. `password` is required on first
seed (caller chooses synthetic demo credential, not committed). Default clinic list
is two clinics for code `org-a`, one otherwise. Usernames: `admin`, `clinic-admin`,
`doctor`, `doctor-one`, `reception`, `accounts`. `doctor` spans all clinics;
`doctor-one`, reception/accounts and clinic-admin use first clinic. Admin has config,
access, forms and aggregate reporting capabilities but no patient/clinical grant.
Seed includes two fictional shared-directory patients, one immutable form assigned
to first clinic, patient two continuity notes at each clinic and default settings;
patient one starts with zero money balance. No real data or external integration.
Apply migrations through 0023 first, then seed with owner credentials; runtime uses
non-owner privileges. New tables are `org_*`; no legacy clinic/user rows are required.

## Verification ownership

Security tests are authored before implementation and intended initially to fail
because the module/schema do not exist: host isolation, anonymous denial, unit
denial, admin clinical denial, stale edit, shared-doctor overlap, immutable history,
unassigned form, locked override, local receipt void/balance and unique metrics.
Main chat serializes execution. No database tests were run in the backend chat.
