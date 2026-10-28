# Multi-clinic PMS: status and handover

Branch `saas/multi-clinic`, pushed to the fork `MJ-06/kb-dental-suite`
(the account has no write access to `kbdental/kb-dental-suite`).
Last updated 28 Oct 2026. Review, design and decisions:
https://claude.ai/artifact/Eb4jkEuheuLYFabAXjUYXV (main tab), with every UI
flow and its test result in its "Flow test report" tab.

## What this is

A new backend in `api/` for today's screens (`index.html`, `register.html`,
`chatbot.html`, `expense.html`), replacing Apps Script plus Google Sheets.
It is hosted centrally for many clinics; each clinic's rows are isolated by
PostgreSQL row level security.

- TypeScript on Node 24 LTS, Fastify, Kysely (typed SQL), PostgreSQL 18.
- `api/src/routes/`: the new REST API (`/api/v1/...`).
- `api/src/legacy/`: the `/exec` adapter. Today's screens send `?action=...`
  exactly as they did to Apps Script, and get the same response shapes back.
- The API also serves the HTML pages. `api/src/http/pages.ts` injects
  `window.KB_SCRIPT_URL_OVERRIDE`, so the pages call `/exec` on the same origin.
- `index.html` sign-in asks for clinic code + username + password when the
  page is served by the API, and only the password on the old backend.

## Done (159 tests pass)

| Module | Legacy actions ported | Notes |
| --- | --- | --- |
| Foundation | - | clinics, forced RLS on every tenant table, `kb_app` role cannot bypass it, audit trigger, version column |
| Sign-in | staffLogin, staffLogout, authStatus, ping, batch | HttpOnly SameSite=Strict cookie, hashed tokens, 5 failures pause the account for 15 min, per-IP limit |
| Masters | ~45 get/save list and settings actions, screen passwords, signatures | named lists deactivate entries left out of a save, never delete them |
| Patients | getNextUHID, checkDuplicate, saveRegistration, getPending, getPatient, getAllPatients, searchPatients, getTodaysBirthdays, patientLookup, patientCompleteRegistration | a save never blanks a field it left empty; each history taken is its own row |
| Diary | getAppointments, saveAppointment, updateAppointmentStatus, updateAppointment, deleteAppointment, get/save/deleteBlockedSlot, getDailyRegister, saveToDailyRegister, getFollowUps | no overlapping bookings per chair; a cancellation needs a reason |
| Finance | saveReceipt, getReceipts, getRevenueByPatient, getDailyCollection, getFinanceSummary, getProfitLoss, getExpenses, saveExpense, deleteExpense, getPatientOutstanding, getOutstandingList, plus getTreatmentPlan and saveTreatmentPlan | per-clinic receipt series (`next_receipt_no()`), receipts can't be deleted by the app, expenses are voided not removed, balances measure receipts against the plan estimate total |
| Clinical | getClinicalRecords, the 15 flat form saves (Pathology, Radiology, Radiograph, Local Anesthesia, Intra Oral, Prescription, Scaling, Minor Surgery, TMJoint, Restoration, Orthodontics + Progress, Denture, Pedo, Lab Log), get/saveClinicalSheets, get/saveCarePlan, saveConsent, getTreatmentProgress, generateSOAPNotes | the flat forms are generated from the live code (`api/src/legacy/clinical-forms.ts`, rerun `py api/scripts/gen-clinical-forms.py` from the repo root rather than edit); consents are append only; the narrative needs `ANTHROPIC_API_KEY` in `api/.env`, is capped at 20 per person per 10 min, and uses the clinic's own name (the live prompt said K.B. Dental). It sends the case details to Anthropic, so it stays off until Diya decides |
| Treatment cases | getProcedureLibrary, saveProcedureLibrary, startTreatmentCase, getOpenCase, getCaseState, resolveStageOutcome, appendCaseStage | each clinic's library starts as a copy of the live standard list (274 rows, `procedure-defaults.json`) and is theirs to edit; stage rules are pure functions in `case-stages.ts`; booking and resolving use `appointments:*` permissions, saving the library needs `masters:write`; an empty library save is refused |
| Documents | uploadPatientDocument, getPatientDocuments, getPatientDocumentContent, deletePatientDocument, createDocumentPDF | files in a folder on the server (`DOCUMENT_DIR`, default `~/.kb-pms/documents`), one sub-folder per clinic, stored under a random id (a typed name never becomes a path); only safe types keep their type, anything else is stored as an opaque download; delete hides the document and keeps the file; PDFs use the machine's Edge/Chrome (`PDF_BROWSER`), with the page locked down by CSP and a dead proxy, and PDF export is off until that is set. Permissions: list/view `clinical:read`, upload/delete `clinical:write`, PDF `patients:write` (confirm with Viveyk) |
| CRM and chatbot | getCrmData, saveCrmCollection, queueCrmLead, getCrmLeadInbox, markCrmLeadsTaken, findAppointmentsByPhone, saveChatbotAppointment, chatbotReply | each CRM list saves whole (empty allowed, missing or damaged refused); the lead inbox queues a patient once; the chatbot needs a signed-in session for every call (Diya's rule), books through the desk's own diary rules, and relays to the model through `src/llm.ts` (needs `ANTHROPIC_API_KEY`, 60 turns per person per 10 min). CRM reads need `patients:read`, writes `patients:write` (my default) |
| REST | /api/v1/auth, /patients, /appointments | |

Checked in a browser (28 Oct, made-up patient AL1001, results in the Flow test
report tab): sign-in, Master gate, quick registration, dashboard, booking and
check-in, a receipt and the Finance dashboard/collection tabs, a Restoration
form save, CRM and chatbot screens opening. Document upload and PDF export were
checked by calling the actions from the page, not through their screens.
Not yet clicked through: register.html, chatbot.html and expense.html as
standalone pages, Profit & Loss (behind the finance password), prescriptions,
consent printing, phone width (375px).

## Left, in this order

1. Run every flow in the Flow test report in a browser (Playwright), against
   the new backend, and record works / breaks / conditions in the report.
2. Data migration from the Sheets. Diya will share view access or .xlsx
   files; no edit access is needed. Viveyk's `migration/` folder is a
   starting point only.
3. Hosting, domain, backups (Google Drive is future scope), Windows-service
   or server setup.

To find the actions a screen still lacks, call each one with `apiDirect`
from the browser console. Missing ones answer `Unknown action: X`.

## How to run (Windows, this laptop)

The PostgreSQL 18 service `postgresql-x64-18` starts at boot.

```bash
cd api
npm install
npm run db:bootstrap   # once per machine: roles kb_owner/kb_app, DBs kb_pms + kb_pms_test, writes .env
npm run db:migrate
npm run db:seed        # dev clinic "kbdev" with one account per role
npm run dev            # http://127.0.0.1:8080 (tsx watch)
npm test               # vitest against kb_pms_test; each file rebuilds the DB
npx tsc --noEmit
```

- `npm run db:reset-dev` wipes and rebuilds the dev DB. It refuses anything
  not on localhost. Reseeding reuses the existing dev passwords.
- Secrets, none of them in git:
  - `api/.env` holds the app's `kb_app` credentials.
  - `~/.kb-pms/owner.env` holds the schema-owner credentials, used only by
    migrations, tests and admin scripts.
  - `~/.kb-pms/postgres-superuser.txt` holds the PostgreSQL superuser password.
- **Test logins** (clinic code `kbdev`; dev-admin, dev-doctor, dev-reception,
  dev-accounts) are in `~/.kb-pms/dev-logins.txt`.
- Gotcha: stopping the background task can leave a stale node process on
  port 8080. Find it with `Get-NetTCPConnection -LocalPort 8080` and stop it.

## Key decisions and gotchas

- **Port from the live Apps Script (`apps-script/out/Code.gs`), not from
  Viveyk's `server/`.** His copy returns the wrong shapes in places, for
  example reasonSteps, panel rates and saveSignature's parameters.
- **UHID scheme** (KB): two letters for the year (AA = 2015, so AL = 2026),
  then the month, then that month's running number: `AE0117`. The number is
  2 digits and grows to 3 after 99. `clinics.uhid_scheme` also supports
  `sequential` with a prefix. `next_uhid()` locks a per-period counter and
  never goes below the highest UHID already issued, which keeps imports safe.
- The registration screen shows a UHID before saving, and saves under it.
  `getNextUHID` therefore reserves the number (`uhid_reservations`). A new
  patient can only be saved under an unused reservation, so unused numbers
  leave gaps but never duplicates.
- Dates of birth travel as `dd/mm/yyyy`. Appointment dates and times are the
  clinic's local time and are converted with `clinics.timezone`. Never use
  the server's timezone; use `clinic_today()`.
- **Every new clinic table:** add `clinic_id ... DEFAULT app_clinic_id()`,
  the housekeeping columns (`version`, `created_at`, `updated_at`,
  `created_by`, `updated_by`), then `SELECT enable_tenant_table('t')`.
  Foreign keys to tenant tables include `clinic_id`.
- Legacy actions declare a permission (`read(fn, perm)` / `write(perm, fn)`).
  A `{success:false}` result rolls back the whole transaction.
- Migrations are not yet deployed anywhere, so 0001-0006 have been edited in
  place. Freeze them at the first real deployment and add new files after that.
- Panels are created only in Master. Registration refuses an unknown panel.
- `index.html` loads React from a CDN, so the screens need internet.

## Open items

- **The live site exposes patient data.** The live Apps Script reports
  `authRequired:false`. Someone with script access must set the script
  property `REQUIRE_AUTH=true`. Until then the live Documents screen also
  shows "no documents" because those calls fail with AUTH_REQUIRED.
- **Security notes from the module work.** Two automatic reviews of the new modules found real bugs, now fixed: a malformed treatment-plan total could break every balance query, and PDF input could redirect the headless browser with an obfuscated `<meta refresh>` (all `<meta>` is now stripped). Watch for backslash escapes inside `sql` templates: JavaScript removes the backslash (`'\D'` becomes `'D'`), so write `[^0-9]`, `[.]` and so on.
- **Manual security review of the branch (28 Oct).** Looked at SQL building,
  headers and CSRF, secrets, uploads and the PDF path. No SQL injection (the
  few dynamic column names come from fixed lists); `X-Frame-Options`, `nosniff`,
  `Referrer-Policy` and `no-store` are set; the `.env` files are git-ignored and
  no patient data is tracked. To do before real use: (1) set `COOKIE_SECURE=true`
  behind HTTPS; (2) `chatbot.html` loads `react@18` and `@babel/standalone` from
  unpkg *unpinned and without integrity hashes* on a page that now carries a
  staff session, and `index.html` loads cdnjs scripts without hashes: pin exact
  versions and add `integrity`, or serve them from the API; (3) there is no
  Content-Security-Policy on the pages (they use inline scripts), so a stored
  script in any patient field would run: a nonce-based CSP is the next hardening
  step; (4) state-changing `GET /exec` relies on the SameSite=Strict cookie
  alone, which is fine for same-site use but means no cross-origin embedding;
  (5) the per-address limit on `/exec` is 3000 a minute, loose for a public
  address; tighten it once the clinic's own IPs are known.
- **Automatic reviews** failed with HTTP 429 earlier in the build (see `~/.claude/security/log.txt`); they are working again and caught the issues listed above.
- **Roles are a working default** (`api/src/auth/permissions.ts`). Viveyk
  has not confirmed them; the proposal and open questions are in the
  design doc.
- **register.html and chatbot.html** now point at the clinic's own server and, like everything on `/exec`, need a staff session on the device (sign in once in the main app; they say so when it is missing). `expense.html` has its own sign-in, which now asks for clinic code + username when served by the API. A *public* chatbot (patients booking without a login) would need its own clinic-scoped endpoint with rate limits: not built, needs a decision from Diya and Viveyk.
- **UX findings so far:**
  - The year-of-birth list stops at 2021, so children under 5 can't be registered.
  - The greeting ("Dr. Viveyk") and the letterhead are hard-coded, which is
    wrong for other clinics.
  - The balance pill shows "Paid Up" whenever a patient has no treatment
    plan, whatever was done.
  - Live calls take 2-4 seconds each.
