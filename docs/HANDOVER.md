# Handover for the next tool (31 Oct 2026)

## UI integration, save reliability and local analytics — 7 November2026

Read REVIEW-2026-11-07.md and LOCAL-ANALYTICS.md. Integrated Viveyk's UI snapshot
31cfce0 while retaining Organization, native Security/roles, reports, clinic switch
and archiving. Added stale-load guards, native POST-only mutations, optional local
record versions and in-memory save/navigation guards. Dependency audit now reports
zero production advisories after jsPDF4.2.1. Migration0034 adds bill-address snapshots;
applied to the marked review, without backfilling historical bills or changing passwords.

All46 backend test files have passing results from serialized individual-file runs
(five older fixtures updated and rerun; new transport regression reproduced/fixed).
Strict unused-symbol TypeScript scan and build pass;198 focused upstream assertions,
113 report arithmetic assertions,34 read-only review API checks and10 actual local
analytics persistence/privacy checks pass. Browser tools both failed initialization
with "failed to write kernel assets"; no fresh visual acceptance or physical print
acceptance is claimed. Clinical test writes use fictional disposable DB records.

Umami3.4.1 production build runs on loopback8091 with its own marked DB/credentials;
replay disabled, no browser SDK, only allowlisted patient-free events. No public
analytics URL. Clinical review runs on loopback8300; old staff/Master passwords kept.
No new Cloudflare tunnel was started in this batch. Analytics startup is manual via
api/scripts/start-local-analytics.ps1; retention/backups are separate from clinical
archiving. Archive destination remains intentionally unconfigured/disabled.

Whole-day4-vs5 is reconciled read-only: all5 bookings match. Raw export5 Scheduled;
imported snapshot5 No Show due to historical inference; current source has1 Cancelled,
3 Completed,1 Scheduled and hides the cancelled row. Do not correct attendance from
assumptions: source-owner review/fresh export remains necessary. Keep ambiguous
provenance/opening estimates separate. CRM collection concurrency, cross-clinic shared
identity versioning, durable write idempotency, full print-layout QA and structured
visit/material recording remain follow-on work. No broad clinical UI redesign.

## Organization data archiving — 6 November 2026

Read DATA-ARCHIVING.md. Master → Organization → Data Archiving now has daily time,
daily-days/monthly-copy retention, direct Google Drive or personal synced-folder
destination settings, worker readiness and manual/history controls. Existing Master
password plus organization management permission gates the APIs. No live records
are purged. User chose both storage options with destination configuration later:
schedule saved disabled,23:00,30 daily days,12 monthly copies; no real-data upload.

Migration0033 applied only to the marked review, with a private database-only backup
role and hidden current-user Windows task `KB Dental Review Archives`. Worker online;
destination not ready as intended. Review server restarted; existing Cloudflare URL
and staff/Master passwords unchanged. No CRM UI access or patient-history edits.
15 archive regressions pass, including actual fictional two-clinic pg_dump/restore
and documents with backup-role privileges; existing storage14/organization13 pass
as separate file runs. TypeScript/build/browser policy save pass. No full suite run.
Configure the destination/account later, then enable schedule and verify first upload.

## Verification follow-up and improvement backlog — 6 November 2026

Read POST-TEST-IMPROVEMENTS-2026-11-06.md. A second, independently selected patient
has the one imported authored Treatment Plan: all six rows/visible clinical values
and normalized preview text matched the original UI. No source/local plan saves.
This closes the populated-plan check for that plan; the earlier reference patient
still correctly has an empty plan. Supplied root PDFs are populated Restoration
outputs, image-only and sideways on portrait Letter pages; actual PDF export
formatting remains open despite the in-page preview improvement.

Original Daysheet initially showed unrelated rows after a committed date; explicit
Refresh produced four snapshot-matching bookings. One of five snapshot bookings
remains unmatched. Missing stale-request protection is a code risk requiring a
controlled regression before a fix; neither issue is claimed resolved.

Newly noticed legacy import behavior changes past Scheduled to No Show and past
Checked In/In Chair to Completed. Raw-row impact/provenance audit is still needed;
do not treat those inferred outcomes as confirmed attendance or completed care.
No raw source, rehearsal or clinical data was rewritten by this follow-up.
Temporary review credentials were rotated after this follow-up; prior sessions
ended. The updated private demo-logins.txt is authoritative. No fresh HTTP suite
or full backend suite was run for this documentation-only backlog update.

## One-patient original/prototype UI check — latest 6 November 2026

Read UI-COMPARISON-2026-11-06.md. User approved keeping uncertain details separate
for Viveyk's later verification. Private packet under realdata-review/verification-pending
contains known inferred dates/descriptions, opening estimates, recovered identities
and source exception CSVs; no data sent or committed. Preserve the unrelated untracked
root test pdf.pdf; it was not used as comparison proof.

One patient with five cases/109 forms/83 register entries/13 appointments checked.
Original/prototype populated restoration sheets both show two tooth groups and match
recorded doctor/material values. No explicit historical assistant/staff attribution
was available; never substitute importing/demo accounts. Treatment Plan is empty in
both UIs for this patient, so populated-plan acceptance remains open. Committed Daysheet
date: prototype5 rows matches API5; selected patient1 row in original/prototype/API.
Live original whole day4 vs snapshot5 remains pending source review, cause unproven.

Clinical Sheets now opens existing PreviewModal instead of an unobservable popup;
populated preview matches selected doctor/material fields, A4 and no horizontal
overflow. No actual printing or original pixel parity claimed. Print Sample always
uses SAMPLE identity. Opening finance estimates excluded from clinical plan counts
and shown separately. New render and count/permission regressions cover these changes.
No real patient writes, external sends or schema migration in this work.

Final checks308 backend tests plus3 CRM identity regressions, TypeScript/build,
113 report math checks and34 public HTTP checks pass. Clinical plan count1 is
separate from219 unverified opening estimates. Later CRM check found two re-saved
pipeline storage IDs/order values and one changed pipeline stages payload; all
patient/clinical/finance fields and3 file hashes match, contact/lead data unchanged.
Preserved that newer configuration in the private packet; strict CRM comparison
remains pending, not a fresh clean fingerprint. See the Nov6 comparison report.
Credentials rotated again after the Nov6 checks; old sessions ended. Updated private
demo-logins.txt is authoritative;34 public HTTP checks passed with new credentials.

## Tabbed clinical reports — latest 5 November 2026

Read REPORT-TABS-AND-SOURCE-REVIEW.md. Fetched Viveyk's latest branch (still3389d7b,
already integrated); retained his report calculations under Summary and added Doctor
Details and Patient Details with search, pagination and day-book/appointment/receipt
drill-downs. These remain working-clinic reports; Master all-clinic summary is separate.
No new API, schema or data migration. Date changes require Show, and all tabs use the
same applied range. Unknown/later registration dates do not imply returning status;
registration estimates are disclosed and cohort milestones no longer claim drop-offs.
Doctor activity is not inferred from patient payments or scheduled doctor names.

Group in the legacy Other Clinic form is only clinic-profile JSON metadata, not real
organization membership/sharing; UI now clarifies it. Sales Tracker remains unimplemented;
removed its broken link and marked the placeholder honestly. Focused UI checks8/8,
upstream report math113/113, TypeScript and inline parsing pass. Synthetic browser checks
include all tabs/drill-downs and an empty applied range. See synthetic evidence screenshot.

## All-patient expansion — latest 5 November 2026

User explicitly approved expanding the protected Cloudflare review to all identifiable
source patients. Read REAL-DATA-REVIEW.md before using older 2,000-patient counts below.
Review and private full clone now hold 2,576 identities: 2,499 original accepted patients
plus 77 historical-record-only identities requiring review. Migration0032 allows unknown
patient types and adds private import provenance plus a shared review flag. No fictional
clinical histories or demographics were added. All original patient/clinical/finance fields and three file
checksums match; seven existing CRM UI transformations are explicitly preserved; recovered fields/provenance also match workbook extraction directly.
Some raw identifiers remain ambiguous/missing and are held for review, not invented.

Important provenance: original registration dates include 1,886 UHID-month estimates
and107 earliest-activity dates;325 receipt descriptions were register-derived;219 of220
plan-table rows are finance opening estimates rather than authored clinical plans.
The original source database/workbooks remain untouched. The all-patient expansion
report is current; initial verification-summary financial values describe the old subset.

Independent GPT-6 Luna verification chat:01a1abc8-f2dc-7823-8df7-41a99cb28f91.
Its report is docs/QA-REAL-DATA-REVIEW-2026-11-05.md. Rotate temporary review credentials
after its password-dependent tests finish; user already authorized temporary use and
rotation. Private login path stays api/.organization-demo-runtime/realdata-review/demo-logins.txt.
No patient-bearing candidate ledger should be created. Audit emits aggregate counts only;
private migration payloads are streamed in memory directly to marked databases.

Final coordination checks: backend300/300, TypeScript/build and four inline scripts pass;
33 expanded public HTTP checks pass after credential rotation. Independent Luna finished
its password-dependent testing. Temporary staff and screen passwords were rotated and
old sessions ended; use the updated private demo-logins.txt. UI acceptance still has
an inconclusive historical Daysheet date filter and only partial populated-history
coverage; see the QA report. Do not call this completed production acceptance.

## Latest user scope and real-data review — 5 November2026

Read `REAL-DATA-REVIEW.md`. User authorized existing exports and the latest2000
patients with linked records/files; basic launch is existing screens plus migrated
data/new backend. Three tier categories accepted; backend foundation now full-access,
tier UI/billing later. Roles must be native in the clinical UI, not an iframe.
Viveyk branch3389d7b merged locally with CGHS bill APIs and updated clinical fields.
New migrations0030/0031. Native staff/role component is `roles-access.js`.

New private database `kb_realdata_review`, loopback8300, org codekb-real-review.
It has exactly2000 migrated patients and2000 central links. Main clinic keeps source
history; second clinic has no invented care. CRM linked contacts and available files
were copied. Credentials/reports/documents are ignored under
`api/.organization-demo-runtime/realdata-review/`. Never expose8080 or print source
values. Read the private aggregate reports if needed, not source rows in chat.
Cloudflare link changes; inspect the dedicated log before sharing. User was asked
to sign in for browser verification and to choose a simpler verification-chat model.

Independent original-field comparison and all3 file checksums passed after fixing
DATE JSON serialization drift; source was untouched. Preserve literal PostgreSQL
DATE values in future imports. Original source exception reports remain unresolved
production acceptance work; do not equate the demo subset with full cutover.
Full suite297 tests passed before adding the native render regression, which passed
separately; see current test output for final suite count.33 real-data HTTP checks
passed before date repair; repeat after final server restart. A separate verification
chat requested by the user should independently check basic flows/data and document
limits. No concurrent DB test runs; never write fictional care into real patients.

Final checks:298 tests across27 files passed, plus the added PostgreSQL DATE codec
regression passed separately; TypeScript/build pass.33 public HTTP checks passed
after date correction and distinct credential setup. All original fields in clinical,
financial and master tables match for both the2000-patient review and a newly copied
full2499-patient private rehearsal (`kb_realdata_full_rehearsal`). All3 files match
original checksums. Native role controls were verified in the authenticated browser;
evidence `docs/evidence/native-roles-review.png` contains review accounts only.
User approved GPT-6 Luna for the independent verification chat and explicitly
authorized temporary password use followed by rotation AFTER testing. Rotate with
`scripts/rotate-review-credentials.ts --apply`, update the private login file and
verify new credentials; do not publish passwords in chat. Source remains untouched.

## Viveyk UI merge — 3 November2026

Fetched and merged `origin/claude/kb-dental-sheet-structure-mlfjr0` at5f2af9a
(previous integrated UI eac924d). Automatic merge retained local clinic switching,
organization reports, dashboard/date fixes and passive clinical workflows. New UI
work adds CGHS endorsement as Treatment Plan Document3, a standalone endorsement
flow, panel/card propagation, editable medicine lists and bounded Master widths.
There were no additional multi-clinic/report-specific changes in this upstream delta.
The local `getPatient` adapter now returns patientType/panel/panelCategory/cardId
to match the updated Apps Script contract; its missing-fields regression was
reproduced before fixing. No schema migration or real-data transfer is needed.

Root UI test runner is not green:163 suites reported1745 checks passed,20 failed,
86 crashed, including missing root Playwright dependency and source-pattern errors.
The panel-reaches-the-patient source check passed19/19. Do not report the upstream
browser endorsement/layout suites as verified. Post-merge backend suite293/293
across24 files, TypeScript check, inline-script parse and33 local synthetic demo
smoke checks passed. Dedicated demo API was restarted for panel-field compatibility.
Logs remain ignored at
`api/.organization-demo-runtime/ui-merge-tests.log`; browser acceptance and triage
of the root suite remain outstanding.

## Launch, transfer and tier planning — 3 November2026

Read `LAUNCH-REVIEW-AND-TIERS.md` for the prioritized review list, three distinct
data-transfer paths, open launch gates and proposed organization subscription model.
`NEXT-CHAT-HANDOVER.md` is a copyable agent handover prompt. HANDOVER is a document,
not an executable backup/import script. Earlier migration plans predate the current
organization architecture and must not be treated as certified cutover instructions.
Tier names, prices/allowances and add-ons remain proposals; entitlements/billing are
not implemented. Enforce future tiers on the server as well as tabs, independently
of staff permissions and clinic grants. No live transfer or production launch was
performed as part of this planning update.

## Clinical review fixes and API/data guide — 3 November2026

Read `SCREEN-API-DATA-GUIDE.md` for screen actions, PostgreSQL tables, file storage,
central UUID/UHID links and limitations. Read `FAMILIAR-UI-IMPROVEMENTS.md` for the
small UI backlog. Existing Add Record forms/save contracts are preserved; a full
layout redesign still needs side-by-side user review.

Implemented recent20 patients/sort, actual dashboard plan counts and today's
appointments; patient total is organization-wide, not a clinic registration count.
Diary/Daysheet/register default to clinic-local date, avoiding UTC-midnight blanks.
Unassigned-chair bookings have their own visible section rather than appearing
under an invented first chair. Treatment Plan retains historical departments and
procedures missing from current masters. Procedure/Progress doctor setup is replaced
by a read filter; doctor maintenance stays in Master. Nested Sheets removes duplicate
headers. Roles & access is embedded in Master with same-origin framing only.
Administrators with reports permission auto-open Reports; server permissions remain.
Master > Organization > All-clinic Reports aggregates only clinics whose mapped
account has reports+finance permission; it does not mutate the working session.
Migration0029 implements that target-grant check. Applied in the dedicated public
demo only; other DBs need their usual migrations.

Demo enrichment adds fictional care/treatment plans, staged receipts, expenses and
appointments without replacing reviewer edits. The dedicated migration helper
skips default kb_app grants and grants only the new reporting function to the
existing synthetic runtime role. No extension-function/owner privilege expansion
was performed. Credentials and Cloudflare logs remain ignored.

Verification: full serialized suite293/293 across24 files; TypeScript/build and
inline-script parse passed;33 public HTTP checks passed before the tunnel expired.
Browser confirmed organization count and matching clinic date/appointments in the
diary. Original Treatment Plan crash was reproduced; historical procedure regression
tests pass. Authenticated final browser acceptance of all edited screens and all17
Add Record forms remains review work. Tunnel is temporary; latest link is in chat.

## Public synthetic clinical review — 3 November2026

User requested Cloudflare sharing. See `PUBLIC-CLINICAL-DEMO.md` for access,
review journeys, runtime commands and limitations. A dedicated synthetic database
`kb_public_clinical_demo`, private runtime roles/config/storage and loopback8200
serve the familiar UI with Riverside/Orchard clinics. Only8200 is tunneled; never
publish8080 or reuse existing patient data. Credentials/tunnel logs remain in ignored
`api/.organization-demo-runtime/public-clinical/`. Public URL is temporary, in chat.

Migration0027 persists patient safety flags. Migration0028 preserves visible UHID
format, fixes sequence100 truncation and shares allocation across linked clinics.
Ported missing patient-type/occupation/referral/safety master lists from live source,
including intentional empty lists, and clinic timing breaks. Individual staff login
is retained; the obsolete shared app password editor points to Roles & access.
These migrations are applied in the synthetic public DB; do not assume development
or other organization databases are already migrated. Existing data reconciliation
and the broader backend roadmap are not complete.

Verification: TypeScript typecheck/build passed; serialized backend suite288/288
(22 files) passed;23 public HTTP checks passed. Public sign-in page opened in browser.
Authenticated browser journeys remain the explicit reviewer checklist; do not claim
all UI flows passed. No new approval questions block synthetic review: use latest
user decisions over superseded per-clinic proposals; research proposals are not
automatically approved production migration rules.

## Latest planning direction — passive linking, unchanged entry flow

User clarified on3 November2026: keep current recording screens and passive linking;
records can be associated later, and a unified flow is a future UI improvement.
Do not impose mandatory visit-first entry or required visit IDs. Keep UHID visible;
reuse existing internal canonical/source IDs and retain historical aliases. See
`docs/BACKEND-PASSIVE-LINKING-ROADMAP.md` for the backend-only review inventory and
proposed sequence. This roadmap is not an implementation/completion claim.


## Latest correction and delivery — one central patient, clinic care (3 November 2026)

Read `docs/CENTRAL-PATIENT-HISTORY.md`. User explicitly clarified that the patient is
created once centrally; treatment, actual doctors and item use belong to clinics.
The old Add to clinic prompt is removed. Search opens the central identity directly,
with compatibility references handled internally. Patient History is now in the
existing folder: permission-scoped, paginated source summaries across clinics, with
clinic filters, recorded-doctor labels and selected historical material/lot fields.
Payments/fee fields are excluded; this does not yet create a structured visit/item
ledger. Organization patient UUID is exposed for future CRM linking; existing embedded
CRM contracts have not been migrated. Old local foreign-key reference rows still
exist; do not claim full physical schema consolidation. Migration0026 applied locally;
synthetic browser acceptance and283-test API suite pass. Next work: actual visits,
treatments/material usage and their correction/finalization flow. UI redesign deferred.


## Latest implementation — shared patient identity (3 November2026)

Read `docs/SHARED-PATIENT-IDENTITY.md`. Migration0025 adds links between existing
clinic patients and the existing org_patients canonical identity. Main Patient
Search now searches the organization directory in linked local runtimes; an explicit
Add to this clinic and open creates a local shell with the same identity. No
medical/clinical/financial history is copied, and old matching records are never
automatically merged. Existing local identities were published with count-only,
idempotent backfill; a fictional Orion Shared Demo journey passed in the browser.
Full API suite282/282 passed. Complete longitudinal history/visits/material ledger,
legacy registration duplicate/concurrency parity and remaining identity read-path
consolidation are still next work. UI layout remains familiar.
The user also requested a separate review chat: Clinical UI improvements and native
backend opportunities (01a19dd2-afc1-7a32-9348-fdb8e38f1d7d). Its recommendations
are in `docs/UI-NATIVE-OPPORTUNITIES.md`; it performed no application edits/DB tests.


## Latest implementation — clinic switching and Organization (3 November 2026)

Read `docs/CLINIC-SWITCHING.md`. The user explicitly chose the EXISTING Master
password for Organization; a separate password is superseded. The familiar clinical
UI now has authorized bottom-left clinic switching and Master > Organization details.
Migration0024 and the opt-in local linker connect kbdev and a synthetic East clinic
to the existing organization identity/unit model. Server context revisions reject
stale-tab writes; switching reloads the UI and clears Master unlock. Organization
profile saves are audited/versioned and require an explicit management grant plus
the shared Master unlock. This bridge keeps old patient records clinic-scoped;
shared longitudinal patient identity/history migration is still next work.


## Latest decision — 3 November 2026

Read `docs/LOCAL-CLINICAL-BASELINE.md` first. Preserve Viveyk's existing clinical UI.
The standalone redesign proposal is deferred. His active feature branch at eac924d
has been merged into saas/multi-clinic. Local frontend/API/PostgreSQL is the immediate
baseline. Bottom-left Clinic replaces the Google Sheets status; currently it shows
only the session's clinic (disabled until organization adapter/grant integration).
Historical plan for a separate Organization password is superseded by the latest implementation above. Full parity for newly merged Master/document/report actions remains.
This supersedes the layout-review checkpoint below as the immediate priority.


## UI / UX review checkpoint (1 November 2026)

The user requested review of the familiar8080/live clinical UI before implementation.
Read `docs/CLINICAL-UI-REVIEW-2026-11-01.md`. The existing UI was inspected locally
and on the published site, with read-only authorized reference-patient navigation.
No live clinical record or credential was copied into the design. Existing local
kb_pms migrations0020-0023 were applied (no reset) to make dev sign-in work.
An independent static prototype is at `design/clinical-review-v1/`, served locally
on8090. It retains the familiar blue clinical-suite shell and folder/forms structure,
adds proposed patient/visit/doctor/item history views, and uses fictional records.
Application screens are unchanged. User review of this UI/UX proposal comes before
application UI implementation; prior D01-D18 approval is not approval of a new layout.

## Latest priority: portable handoff and patient-centred clinical CRM

Read `docs/PATIENT-CRM-DIRECTION.md`: keep familiar clinical screens and organize
care around the patient's longitudinal history, visits, clinic, treating doctor,
treatments and items used. Doctor/item histories and care-history metrics follow
the same records. The contact-centre analogy is inheritance only, not the product UX.
The current admin demo is not the finished clinical CRM. Before redesigning, inspect
the existing suite and Apps Script behavior. Labs remain future scope.

The user requested relevant code be committed/pushed so BOTH versions can run on
another laptop. `docs/ANOTHER-LAPTOP.md` is the fresh-install/run/agent handoff guide.
Generated credentials, databases, real spreadsheets and patient files are not in Git.

## Current implementation milestone

Organization demo vertical slice is implemented and running locally: A at
http://org-a.localhost:8101 (two clinics), B at http://org-b.localhost:8102 (one).
See `docs/DEMO-VERIFICATION.md` for actual checks: final suite 269/269 tests in
21 files, typecheck and JS syntax pass, plus 33 live HTTP/database checks.
Organization A admin browser acceptance now passes (including two rendering fixes);
clinical/accounts-role and organization B browser checks remain pending. Do not
infer those from API tests. Generated credentials/documents stay in ignored directories.
New modules and screens preserve the original clinic code during transition.

## Latest accepted direction: organization tenancy

Demo scope now confirmed: Organization A with two clinics and Organization B with
one clinic. Labs are future scope. All D01-D18 in `docs/DEMO-DECISIONS.md` are now
approved and implementation is authorized. Existing source data/files may inform
realistic synthetic examples through read-only pattern/aggregate inspection.

The user's later clarification supersedes the per-clinic database/instance proposal
below. Each ORGANIZATION has its own database, credentials, sessions, storage, subdomain and
configuration. An organization contains operating units (clinics, labs, other types), with
shared customers and organization defaults plus only permitted unit overrides. The organization
console is its admin panel with unit sections/metrics and centrally authored forms
assigned to units. Releases, migrations and baseline recovery are per organization.
Read `docs/BRAND-CLINIC-PLAN.md` for the revised target and implementation sequence.
This is a test product and implementations may be refactored/replaced for the target;
existing uncommitted work, data safety and applied-migration safeguards remain intact.
The sections below describe historical decisions and current code, not a competing
requirement to retain per-clinic databases.

Written so OpenAI Codex, or anyone, can continue without the chat history. Rules and
commands are in `AGENTS.md`; the long-form status and decisions are in `STATUS.md`.
The root `HANDOVER.md` is the older Apps Script handover and is out of date for this branch.
Branch: `saas/multi-clinic` (PR 138). People: Diya (product owner), Viveyk (the clinic's
doctor and owner, supplies data and decisions).

## Goal

Replace the clinic's Apps Script + Google Sheets system with a hosted, multi-clinic
practice management system. Plan: about 10 clinics; K.B. Dental is the first. Staff use
desk PCs and tablets, and also phones for the diary and forms (a separate phone website is
future scope). It must work over mobile data. For now it is built and run on Diya's own
laptop; hosting comes later.

## Architecture and stack

- `api/`: TypeScript, Node 24, Fastify, Kysely, PostgreSQL 18. No Docker yet.
- Clinics are isolated by forced row level security (`clinic_id = app_clinic_id()`). The app
  connects as `kb_app`, which owns no tables and cannot bypass RLS. Each request is one
  transaction; `session_resume()` sets the clinic and user for that transaction. No clinic
  set means no rows. Sessions live in the database, not in memory.
- `api/src/routes/`: REST `/api/v1/...`. `api/src/legacy/`: the `/exec?action=...` adapter
  that returns the old Apps Script response shapes so the existing HTML screens keep working.
- `api/src/http/pages.ts` serves the HTML screens with a nonce CSP and vendored libraries.
- Storage: `api/src/storage/` (server folder, S3-compatible bucket, Google Drive, chosen per
  clinic); `api/src/drive/client.ts`; `api/src/secrets.ts` seals credentials with `KB_SECRETS_KEY`.
- Migrations `api/migrations/0001`-`0022` plus `grants.sql`; tests in `api/test/` (about 200).
- Schema reference: `docs/DATABASE-STRUCTURE.md`; migration plan: `docs/MIGRATION-DB-PLAN.md`;
  plain-words security summary: `docs/how-we-protect-the-app.md`; multi-visit treatment
  specs: `docs/ClinicalSuite*.md`, `docs/MultiVisitTreatment.md`.

## How to run and test

See `AGENTS.md`. Key warning: `npm test` rebuilds the shared `kb_pms_test` database per file,
so **one run at a time**, and check no other agent is running one. A full run takes about
5 minutes. `STATUS.md` records 195 passing at the last full run; the review thread did not
re-run it.

## Decisions made

From `STATUS.md`, the migration answer files and the review thread (Diya, 31 Oct):

- Port from the live `apps-script/out/Code.gs`, not from Viveyk's `server/` copy.
- UHID scheme: two letters for the year (AA = 2015), month, running number (`AE0117`).
  `getNextUHID` reserves numbers; gaps allowed, duplicates never.
- Receipts: `yy-yy/n` per financial year (April start), continuing from the highest imported
  number. Receipts cannot be deleted; expenses are voided.
- Duplicate UHIDs: the latest row wins; only pairs differing in name, gender or date of birth
  go to review. Money history from April 2024 only; patients from all eras.
- Panel patients are one list with panel, category and card ID fields.
- Roles are customisable per clinic (admin, doctor, reception, accounts to start); permissions,
  not role names, gate features. Doctors do not see patient payments on progress notes unless
  the clinic turns it on.
- Each clinic chooses its document storage. K.B. Dental keeps its Drive folder
  "KB Dental - Patient Documents".
- Backups: daily to Drive (14 daily and 12 monthly copies proposed) plus a monthly restore test.
  Encrypted; the key kept apart from the backups (password manager plus a printed copy).
- Phone sessions lock after about 1 hour idle and end after 1 day, set per clinic.
- Out of scope: consents (stay on paper), care plans, treatment plans, AI consents, Inventory,
  Attendance and the other books.
- Diya's review answers (31 Oct): accepted nearly all of `docs/REVIEW-2026-10-31.md`. Lost-update
  protection with `version`, forms gated by permission not role name, rate limits keyed per
  session/account, move state-changing calls to POST, upgrade jsPDF, move letterhead and
  signature lines into clinic settings, longer separate limit for reports. Extra security work
  waits until the product is ready to ship. Cleanup of `nul` and the old nested copies: back up,
  delete, then delete the backup. The earlier per-clinic database requirement was
  superseded by the brand-level database decision at the top of this handover.

## Workstreams

| Workstream | State |
| --- | --- |
| Roles and access | **Done**: `f080c43`, `607fc42` (migration 0020, roles page, password reset ends other sessions). |
| Document storage | **Done**: `98c438e`, `1153a0b` (migration 0022, `/api/v1/storage`, `scripts/copy-documents.ts`). Fake S3/Drive servers in tests; not tried against a real bucket or Drive. No screen yet. |
| Custom forms and mobile entry | **Code written, not committed.** Existing uncommitted form/phone work preserved. Main coordinator ran tests after implementation authorization: forms17/17 pass after correcting test helper tenant context; final full suite269/269 pass. Current forms use stable role IDs rather than the older review's role-name finding. Real-provider/browser acceptance remains separate. |
| Drive backup | **Waiting on Viveyk**: is his Google Drive personal Gmail (use OAuth, one-time approval) or Workspace with a Shared Drive (use a service account)? Defaults agreed otherwise. There is no backup script or restore drill in the repo. |
| Data import and hardening | Importer and rehearsal tooling are in `migration/` and `api/scripts/` (rehearsal database `kb_rehearsal`, never committed). Waiting on Viveyk's answers (below). Demo checklist: screen share first; run the final import, then `api/scripts/fix-doctor-names.ts --apply`; check receipt totals against the sheet. Hardening still open: signed-in browser pass for CSP breakage, precompile chatbot JSX, `npm audit`, tighten rate limits. |
| Review findings | `docs/REVIEW-2026-10-31.md` (20 items, severity-ranked). High: no ops artefacts (nginx, service, `pg_dump`, restore); per-clinic DB not wired (`clinics.database_url` unused); form role names; no `version` checks (lost updates); 2.7 MB uncompressed `index.html` and base64 uploads. |

### Historical proposal, superseded: one app instance per clinic

Diya wants a router or, better, one app instance (own database, config folder and subdomain)
per clinic, possibly in Docker. Claude's analysis: it fits 10 clinics, removes the need for a
router and central login database, keeps RLS as a second layer. It needs a "create clinic"
script (database, settings, first admin, nginx entry) and an "update all clinics" script, and
loses the cross-clinic view unless a small operator tool is built. Docker is not installed
here; the plan was plain processes with a per-clinic config folder and a Dockerfile later.
Not decided. Next step proposed: write the technical person's rulebook (setup, checklist,
backups, key rotation, updates), then the create-clinic script. Build for Diya's laptop first.

## Open questions

For Viveyk (full list: `migration/data/VIVEYK-DECISIONS-AND-QUESTIONS-2026-10-31.md`):
1. Personal Gmail Drive or Workspace Shared Drive (backup and Drive storage sign-in).
2. Stub patients for 17 well-formed UHIDs with no registration; review of 63 malformed UHIDs
   and 27 duplicate-UHID pairs (who signs).
3. Accept the filled-in services on 357 receipts; require a service on new receipts?
4. Cutover date, who checks the first week's totals, Google Form freeze date and who types
   clinical entries afterwards.
5. Hosting and who is on call; passwords for Finance, Master, Reports; does the second Reports
   password holder become admin or accounts; is Dr. Manika Mittel admin or doctor.
6. Clinic timings, slot length, weekly off, holidays, doctor signatures; which roles fill and
   view each clinical form; do manual receipts carry printed book numbers.
7. On the live site set `APP_PASSWORD`, then `REQUIRE_AUTH=true` (it currently exposes patient data).

For Diya:
1. Go-ahead to run `forms.test.ts` on the shared test DB, then commit the forms work.
2. Brand instances are decided; hosting and Docker timing remain to be selected.
3. Bucket provider and region for attachments; whether the AI consent narrative
   (sends case details to Anthropic) and a public chatbot stay off.
4. Hosting target and who restores a backup at 9 pm, and how long the clinic may be without records.
5. Drive access scope: full-Drive (sees the existing hand-made folder) or app-created files only.
