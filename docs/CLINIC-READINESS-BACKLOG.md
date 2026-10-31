# Clinic readiness backlog

> Current demo scope: Organization A has two clinics; Organization B has one.
> Labs are future scope. Any lab workflow/scenario below is future design, not a
> demo requirement. D01-D18 in [DEMO-DECISIONS.md](DEMO-DECISIONS.md) are approved.
> See [DEMO-VERIFICATION.md](DEMO-VERIFICATION.md) for current implementation/test status.


31 October 2026. Quality/security review of the current working tree on
`saas/multi-clinic`, including the other workstream's uncommitted forms and phone
session files. Design and acceptance deliverable only; no implementation changes,
tests, migrations, server startup, dependency audit, provider calls or restore
operations were performed. No secrets or `migration/data` were read. The historical
195-pass result in `docs/HANDOVER.md` is not a result for this tree.

Read alongside `docs/BRAND-CLINIC-PLAN.md` and
`docs/REVIEW-2026-10-31.md`. Source locations below are repository-relative;
line anchors describe this reviewed snapshot and may shift as forms work continues.

## Governing model — corrected user requirement

The organization is the deployment and isolation boundary: one runtime deployment,
database, credentials, session store, document storage boundary, subdomain and
configuration per organization. Multiple operating units share that database and organization
patient/customer identity. Use `unit` internally with `type = clinic | lab` and
an extensible type model. A unit is a business location/function, not an OS process.
The organization console is the organization admin panel, with unit sections and metrics.

Organization defaults and locked policies resolve with explicitly permitted unit overrides
inside the same database. Forms are organization-created, versioned and assigned to chosen
units. Cross-unit customer handling requires scoped permissions; knowing a shared
patient ID is not authorization to see every encounter or financial record.
Software releases, schema migrations, canaries and full restores operate per organization.
Form/configuration/feature activation can operate per unit without a schema release.
The MVP needs no clinic DB router, distributed configuration fan-out or federated
reporting. Earlier per-clinic deployment proposals are superseded. Current
`clinic_id` RLS is implementation evidence, not proof of the proposed organization/unit model.

## Corrections to the earlier review

| Earlier claim | Current source evidence and remaining scope |
| --- | --- |
| Forms directory absent; rules use role names (item 3) | Outdated in the working tree. `api/src/app.ts` registers `formRoutes`; `api/migrations/0021_forms.sql:23` uses UUID role arrays. `api/src/routes/forms.ts` (`formAccess`, `checkRoleIds`) combines stable role IDs with clinical permissions and validates IDs against tenant-visible roles. Runtime behavior remains unverified here. |
| No lost-update protection (item 4) | Too broad. `api/src/routes/patients.ts:95` requires a version predicate and returns 409; `api/src/routes/appointments.ts:107` also checks versions. `api/test/patients.test.ts:60` already specifies a stale-save test. Legacy whole-list writes and form draft updates still need work. |
| Password reset does not end sessions (item 8) | Outdated. `api/src/routes/access.ts:213` resets the password, clears lockout and deletes other sessions; own reset preserves the requesting session. Deactivation deletes sessions at line 201. `api/test/roles.test.ts:155` and `:284` specify these cases. Phone idle/absolute limits are now written in 0021, login and `resumeSession`; not rerun here. No device/session-management screen was established by this review. |
| Only server-folder document storage until storage work lands (item 14) | Outdated. `api/src/storage/index.ts:32`, `api/src/legacy/documents.ts` (`fileAway`) and `api/src/routes/storage.ts` implement per-clinic local/S3/Drive storage. `api/test/storage.test.ts` uses fake providers. Real-provider verification and an operator screen remain acceptance work. Delete currently soft-deletes metadata; it does not delete the underlying object. |
| No phone layout or photo reduction (items 5, 18) | Too broad for new forms: `forms.html:316` downsizes photos before calling the document adapter. It still sends base64. This does not establish mobile usability for the diary or old desk screens. |
| Dedicated clinic DB requires a router and central session DB (item 2) | Superseded requirement. `api/src/server.ts:5` creates one pool, suitable for a separately configured organization deployment; it does not implement expected-organization pinning or intra-organization unit grants. `clinics.database_url` at `0001_foundation.sql:49` is not routing support and is unnecessary for the chosen MVP. Sessions belong in each organization DB. |
| No permission-change tests | Too broad: `api/test/roles.test.ts` contains reassignment and existing-session checks. Forms-specific rename, access-list and mid-session revocation cases still need explicit coverage. |

## Release gates and actionable work

P0 gates the first hosted organization. P1 gates routine staff rollout and expansion
to more units/organizations. P2 is planned follow-up with an owner and trigger. These priorities
are proposals, not evidence that a control has been implemented or validated.

### P0 — Instance, database and document boundaries

**Evidence:** `api/src/server.ts:5`, `api/src/db/index.ts` (`createDb`,
`resumeSession`), `api/src/auth/login.ts`, `api/migrations/0001_foundation.sql`
(`enable_tenant_table`), `api/test/isolation.test.ts`. Existing tests cover selected
patient and app-role cases under current clinic RLS in one DB, not two deployed
organizations with multiple units sharing customer identity.

**Acceptance:** Provision two fictional organizations with separate DBs, runtime roles,
config directories, document roots/namespaces and hostnames. Pin each instance to
its expected organization UUID; wrong DB/config, wrong organization login and a resumed actor
for another organization must fail closed before business reads/writes. Runtime roles
cannot connect to or inherit access to the other organization DB. Host-only cookies from
A cannot authenticate B, even when manually replayed. Document ID guessing, role
IDs, patient IDs and provider references cannot cross the organization boundary. Within
each organization create two clinic units and a lab unit: unit membership and operation
permission are checked server-side on every unit-scoped request. A unit selector,
URL/header unit ID or shared customer ID alone grants nothing. Organization membership
does not implicitly confer every clinical permission. Failure of the optional
platform fleet tooling must not prevent an organization from operating.

**Test strategy:** Add two-organization/multi-unit fixtures and preserve equivalent
fail-closed coverage while changing current clinic RLS. Test wrong configuration,
cookie replay, forged unit context, missing grants, permission revocation and
provider calls (including asserting no foreign-object access). Extend
`api/test/isolation.test.ts` with a catalog-driven inventory of every tenant table,
forced RLS, policies, tenant FK integrity, no-context reads and cross-organization writes.
Classify organization-shared versus unit-owned tables explicitly; a blanket unit filter
must not split the shared patient identity. Test grants to a single unit, selected
units and all permitted units, including organization admin roles with limited clinical
permissions. Organization A must not read Organization B through reports, exports or attachments.
Explicitly review/allow-list `sessions`: `0002_users_sessions.sql:42` enables RLS
without forcing it so SECURITY DEFINER session lookup can work. Verify owner,
grants and fixed search path rather than blindly forcing every table. Catalog
checks must detect a deliberately unprotected fixture table, avoiding a vacuous pass.

### P0 — Usable backup, restore and cutover

**Evidence:** No application backup/restore job was found in the scoped source
inventory. `api/src/secrets.ts` seals credentials with one environment key and a
`v1` format; that is not key rotation. Import tooling exists in
`migration/import.js:142`, `migration/verify.js:102`, and
`api/scripts/rehearsal-check.ts`; a restore drill does not follow from their presence.

**Acceptance:** Name a responder and agree maximum data loss and restoration time
per organization. Back up the entire organization DB, document bytes, configuration,
release/migration identity and required
role definitions; keep recoverable keys separately. Prove complete forced-RLS
table coverage under the controlled backup identity. Restore to an isolated new
target, verify counts, receipt totals/sequences, attachment checksums, sessions and
permissions, and measure actual recovery time. Reject a wrong-organization backup or
missing/wrong key; document recovery from partial upload and unavailable provider.
Choose daily dumps versus additional WAL/PITR against the agreed data-loss target.
Do not switch a live organization until the drill passes. Unit-only restore is not a
database rollback: shared identities and cross-unit references require a separate
selective recovery design; do not overwrite the organization DB to recover one unit.

**Test strategy:** Operations owns a recorded drill, first with synthetic fixtures;
later authorized rehearsal uses protected data outside git/chat. Follow
`docs/CLINIC-OPERATIONS-PLAN.md` when available. Exercise key rotation/recovery and
restore one organization without altering another. Verify all restored units and their
shared patient links. Record sanitized results, artifact
identity, timestamps and failures, not clinical rows or credentials.

### P1 — Finish forms access and storage integration

**Evidence:** `api/src/routes/forms.ts` (`formAccess`, publish route,
submission route), `api/src/forms/definition.ts:126`, `forms.html:346`.
Photos already travel through `uploadPatientDocument` -> `fileAway` -> `storeFor(tx)`;
submission checks require tenant-visible documents belonging to the selected
patient. Signatures remain PNG data URLs in submission JSON (`definition.ts:132`),
and therefore can be copied into audit rows. The publish route checks
`masters:write`, while `api/test/forms.test.ts:84` says “only a role manager”; the
default admin/doctor fixtures do not distinguish these policies. A `roles:manage`
holder also bypasses form access lists and clinical permissions in `formAccess`.

**Acceptance:** Product explicitly approves publishing permission and administrator
bypass semantics; code, labels and tests agree for custom roles. Renaming a role
preserves access; removing clinical permission takes effect on the next request;
foreign-organization role IDs are rejected and roles cannot widen unit scope. Organization-created
forms appear only in assigned units; direct API calls cannot bypass assignment or
permission checks. Changing assignment or access rules affects the next request,
with explicit authorized handling for historical records. Define whether old-version drafts retain old
access lists after a new version restricts access, and test that decision. Move
signature bytes to organization-managed storage with authorized document references,
patient and encounter/unit scope checks and checksums; keep submission/audit JSON
free of bytes. A patient shared by two units does not make all attachments shared.
Prove photo and signature save/read paths on local, S3 and Drive, including provider
failure, DB rollback after upload and orphan cleanup. Clarify document deletion
when a finalized form references that attachment; a clinical record must not
silently lose its evidence. Final submission and any retained clinical write-through
remain atomic; legacy duplication is not a required future architecture.

**Test strategy:** Extend `api/test/forms.test.ts` and `api/test/storage.test.ts`
with custom permission combinations, selected-unit assignments, clinic/lab applicability,
renamed roles, mid-session revocation,
foreign/deleted/wrong-patient attachments, final immutability and old-version drafts.
Real-provider smoke follows fake-provider tests with a synthetic patient only.

### P1 — Stale-save protection through the screens

**Evidence:** `api/src/legacy/masters.ts:34` deletes/replaces list contents;
`api/src/legacy/patients.ts` and legacy finance/case writes lack client version
predicates. `api/src/legacy/cases.ts:90` and the draft submission query in
`api/src/routes/forms.ts` lock rows; locking serializes transactions but cannot
detect input based on an earlier screen snapshot. Draft request/response schemas
do not carry a row version. Form definition versions are separate from edit tokens.

**Acceptance:** Every retained or replacement mutable edit flow supplies its base
row or collection version, including organization defaults and unit overrides.
First save succeeds, stale save returns a stable conflict result without mutations,
and the screen retains unsaved input while offering reload/reapply. Whole-list
replacement uses a collection revision, including empty lists; missing versions
cannot bypass checks. Draft edits and concurrent form publication have explicit
conflict handling. Preserve equivalent stale-save protection in replacement
patient/appointment flows. Financial
append-only rules remain enforced; do not introduce receipt editing to add versions.

**Test strategy:** Start each fix with a failing two-client test in the relevant
legacy/forms test file; interleave reads then saves, inspect unchanged winning
rows and audit output after rejection. Include empty collection and publish races.
Browser acceptance confirms visible recovery and retained user input.

### P1 — Organization rules, shared customers and unit reporting

**Evidence:** `api/migrations/0001_foundation.sql` scopes identity/settings through
`app_clinic_id()`, `api/src/db/index.ts` returns an actor with one `clinicId`, and
`api/src/routes/access.ts` checks permissions inside that tenant. These are useful
building blocks, not an implemented organization-wide identity or unit grant model.
`api/src/routes/forms.ts` publishes tenant-local forms, not organization forms with unit
assignments. The organization admin panel and override enforcement are proposed work.

**Acceptance:** Model customer identity at organization scope and encounters, appointments,
lab work, payments and documents at explicit ownership/visibility scopes. Define
unit-specific timezone/date windows and currency treatment for metrics. Decide
UHID and receipt numbering scope explicitly; do not infer it by renaming `clinic_id`.
Cross-unit referral/transfer preserves provenance, avoids duplicate customers and
requires authorized source and destination operations. Access to identity search
returns only approved demographics; clinical and financial access is separately
checked. Audit records identify organization, actor, relevant unit(s) and operation.

Resolve product defaults -> organization defaults/locked values -> allowed unit overrides
server-side. Reject forbidden fields, forged unit IDs and incompatible template
versions even when sent directly to the API. Clearing an override resumes inheritance;
locking a formerly overridable field takes effect predictably with an audit trail.
Historical documents retain their template/price snapshot. Unit type constrains
available workflows without conflating a lab with a clinic. Organization admin panel
sections show only permitted units and metrics, with clear reporting windows and
aggregation rules that avoid counting a shared customer twice in organization totals.
Use same-DB authorized queries for MVP metrics and configuration; no remote unit
configuration acknowledgements or report federation are required.

**Test strategy:** Two organizations, each with two clinics and one lab; create one customer
seen in multiple units, including a referral and lab result. Exercise no grant,
single-unit grant, selected units, authorized organization reporting, clinical-only and
finance-only permissions. Assert foreign-organization denial, restricted identity search,
unit-filtered totals and unique-customer organization totals. Test allowed/locked overrides,
clear-to-inherit, concurrent edits, locked-policy changes, unpublished forms,
selected-unit assignments and historical snapshots. In browser acceptance, direct
navigation and stale UI state cannot bypass server grants or locked settings.

### P1 — POST writes and action metadata

**Evidence:** `api/src/legacy/route.ts` sends both GET and POST to the same handler;
only staff login explicitly refuses GET. `api/src/legacy/types.ts` makes `read` and
`write` identical metadata, while batch relies on action names starting with `get`.
GET forms reads also call lazy `seedClinicForms`.

**Acceptance:** Classify mutating actions explicitly, including logout and number
reservations; GET requests cannot mutate business state. Retire or replace `/exec`
where useful; compatibility is not an acceptance requirement. If retained, move its
callers to POST and validate read-only batches from metadata. Move form seeding
into a controlled organization provisioning/write path. Define and
test same-origin/CSRF policy for JSON and legacy text/plain with host-scoped cookies.
No credentials or clinical write payloads appear in URLs.

**Test strategy:** Add a table-driven registry check and GET/POST matrix, including
misnamed actions, mixed batches, failure rollback and cross-origin requests.
Run page flows to catch old callers that still send GET writes.

### P1 — Fair rate limits and bounded expensive work

**Evidence:** `api/src/app.ts` sets an IP-based ceiling;
`api/src/routes/auth.ts` limits login to 10/minute; legacy login uses
`attemptCounter(req.ip)`. `api/src/legacy/route.ts` allows 25 batch reads with
`Promise.all`; `api/src/db/index.ts` defaults to ten connections and a 15-second
statement timeout. Account lockout remains in `api/src/auth/login.ts:47`.

**Acceptance:** Authenticated budgets are keyed by validated session/account and
organization; retain a coarse IP backstop. Changing units cannot reset an account's budget.
Login combines normalized organization/account
limits with IP abuse limits without exposing account existence. Document lockout
recovery (password reset already clears locks). Invalid arbitrary cookies cannot
mint unlimited buckets; counters have bounded memory/lifetime. Cap batch fan-out
(proposed four) and report/export concurrency; give reports an explicit longer,
bounded timeout and cancellation policy. Size pools across organization deployments
against DB capacity; units do not each require their own pool.

**Test strategy:** Same-IP distinct users remain usable; one noisy account is
limited across rotating IPs; invalid sessions, proxy headers, restarts and bucket
expiry behave as specified. Assert batch concurrency ceilings and report timeout
without starving ordinary patient requests. Existing test helper
`api/test/setup.ts` uses different IPs for sign-in and does not cover CGNAT fairness.

### P1 — Browser, mobile, uploads and release dependencies

**Evidence:** `index.html` is 2,777,259 bytes on disk. `api/src/app.ts` defaults to
`no-store`; no app compression is registered. `api/src/http/pages.ts:110` serves
unversioned vendor URLs with a one-year immutable cache. `api/package.json` pins
jsPDF 2.5.1 and includes browser Babel. `api/src/legacy/documents.ts` accepts 25 MB
decoded uploads through a 40 MB JSON route; MIME handling uses caller-declared
types with an opaque fallback, not content inspection. No current advisory status
was checked here; the earlier jsPDF advisory claim needs a fresh audit.

**Acceptance:** Signed-in browser pass covers CSP, embedded frames, popups, reports,
PDF/print, diary and forms. Verify Chrome/Edge desktop, Android Chrome and iOS
Safari/touch widths, camera/file selection, signature drawing and session expiry
without losing unsaved input. Measure compressed transfer and usable-load time on
an agreed constrained mobile profile; propose a <=600 KB compressed initial desk
HTML budget, to be confirmed by measurement. Precompile chatbot JSX. Cache only
safe static assets with versioned URLs; release upgrades cannot strand old vendors
under immutable URLs, and patient responses remain uncached. Align proxy/app limits,
show upload progress/retry, prevent duplicate final saves on network retries, and
preserve drafts on failure. Establish file-content validation and download behavior;
safe MIME fallback alone is not malware detection. Evaluate direct/resumable upload
if supported clinical file sizes remain impractical over mobile links.

**Test strategy:** Keep a repeatable synthetic browser matrix with console/network
evidence and throttled/failed uploads. Run dependency audit at implementation time,
record date/lockfile and reachable issues, then upgrade jsPDF with print/PDF visual
regression checks. One shared tested release/lockfile serves every instance; record
artifact digest and applied config/schema version per organization. Exercise stale browser
cache across a release and canary organization rollout before releasing to other organizations.
Unit feature flags or form activation must not imply an independent unit schema.

### P1 — Import reconciliation and first-week ownership

**Evidence:** Import is transactional (`migration/import.js:142`); verification
checks receipt counts/totals (`migration/verify.js:102`). Rehearsal helpers and
`api/scripts/fix-doctor-names.ts` exist; their presence is not a completed cutover.

**Acceptance:** Resolve handover decisions on duplicates, malformed/orphan UHIDs,
receipt services, freeze/cutover date and sign-off owner. Rehearse on an isolated
organization copy with pinned release/migrations; reconcile shared patient identity,
unit-owned encounter/document/financial links, rejected records,
receipt/expense totals by period and next receipt/UHID sequences. Document safe
retry behavior so rerunning import cannot duplicate financial history. Run doctor
normalization dry-run then authorized apply; reconcile again. Reconcile documents
and form backfill, not only relational counts. Define rollback after new writes
begin and who checks the first week's totals. No raw rejects or patient rows enter
git or chat.

**Test strategy:** Use fictional importer fixtures for failure rollback, retry,
duplicates, sequence continuation, timezone boundaries and attachment mapping.
Test one customer attending two clinic units and a lab: one organization identity,
distinct scoped encounters and authorized handoff; never silently merge customers
between organizations. Define legacy UHID collision resolution and numbering scope before
importing multiple units; retain stable source-to-organization/unit identity mappings.
Authorized real-data rehearsal and cutover sign-off are separate protected evidence.
Consult `migration/README.md` before executing any importer command.

### P2 — Owned operational follow-up

Plan audit growth/archival without losing required clinical history; configuration
override visibility, key rotation and backup failure alerts; optional session/device controls;
and organization letterhead/signature settings replacing fixed clinic text. Review
`api/migrations/0001_foundation.sql` audit triggers, `api/src/secrets.ts`, and
`api/src/legacy/masters.ts` signature/profile actions. Define thresholds, owners and
tests before release expansion. Leave applied migrations untouched; future changes
use new numbered files unless a later explicit reset is authorized and planned.
Keep cleanup of ignored legacy copies and
`nul` separate, with the backup procedure required by the handover.

## Implementation sequence and proof points

1. Agree the organization/unit schema and access matrix before migration code. Inventory
   each existing `clinic_id` table as organization-shared, unit-owned or intentionally
   platform-only; map current data, patient identity and numbering collisions.
   Product approves override fields, cross-unit visibility and customer merge rules.
2. Implement organization provisioning and expected-organization validation, then unit memberships
   and scoped authorization. Add failing two-organization/multi-unit boundary tests before
   adapting handlers. Use new numbered migrations; this design authorizes no reset.
   Code/screens can be refactored or replaced; preserve required business behavior,
   data integrity and equivalent tests rather than legacy API compatibility itself.
3. Introduce shared customer identity and scoped encounter/document ownership, then
   organization defaults/locks, unit overrides and form assignments. Prove cross-unit
   customer handling and direct-API denial before building the admin panel views.
4. Build organization admin unit sections and authorized metrics on the same database.
   Finish stale-save handling, uploads, session/rate controls and browser flows on
   the retained/replacement product paths; remove obsolete paths deliberately.
5. Rehearse import and whole-organization backup/restore, including all units and keys.
   Publish one tested immutable release; canary one organization, verify schema/health and
   business flows, then update other organizations. Enable unit features/forms separately
   from schema deployment. App rollback requires schema compatibility; otherwise
   use a rehearsed forward fix or whole-organization recovery with agreed write handling.
6. Execute the exclusive verification queue below and collect acceptance evidence
   for the exact release candidate. No historical test total substitutes for it.

## Serialized verification schedule — proposed, not executed

`api/test/setup.ts:40` drops the public schema; `api/vitest.config.ts` disables file
parallelism only inside one Vitest process. It does not prevent another process,
chat or CI worker from resetting the same database.

1. One named coordinator reserves `kb_pms_test` for a time window and confirms all
   other test runners are stopped. Freeze/record the exact working-tree snapshot
   being validated with the forms owner; do not overwrite or commit their files.
   Add an interprocess/CI mutex before routine multi-worker testing. Release the
   reservation only after the process and DB connections have ended.
2. Run `npm run typecheck` and `npm run build` from `api/`; fix failures before DB
   tests. Build success is not a functional test. Dependency audit is a separate
   dated check, not a replacement for tests.
3. Within the exclusive window, run **one command at a time**:
   `npx vitest run test/<file>.test.ts`. Suggested order: `auth`, `roles`,
   `permissions`, `isolation`; then `forms`, `storage`, `legacy-documents`; then
   `patients`, `appointments`, `legacy-patients`, `legacy-masters`, `legacy-cases`,
   `legacy-finance`, `legacy-clinical`, `legacy-diary`; then `reports`, `pages`,
   `system-log`, `legacy-crm`, `fix-doctor-names`. Stop on failure; record and fix
   the failed case before proceeding. Confirm the reservation still holds before
   every subsequent run. New organization/unit test files join this same queue; retire or
   replace legacy suites only when their required business assertions are covered.
4. After relevant regressions pass, run one exclusive `npm test` for the candidate
   snapshot. Record actual counts, command, time and snapshot; never carry forward
   the historical count as current proof. If code changes afterward, rerun the
   affected checks and final candidate gate as justified by the change.
5. Run importer fixtures per `migration/package.json` under the coordinator's
   schedule after checking their DB targets. Run two-organization/multi-unit, provider, browser,
   upgrade and restore exercises on explicitly isolated fictional targets; do not
   repoint shared test helpers at organization databases. Do not run these concurrently
   with shared-DB tests until their resource independence is established.
6. Collect sanitized evidence for each acceptance gate. Unrun or failed gates stay
   open. First hosted organization requires P0 evidence; normal staff/fleet rollout
   additionally requires P1 sign-off or a specific owner-approved scoped exception.

Every implementation bug fix starts with a failing test per `AGENTS.md`. This
document specifies those tests; it neither creates them nor claims they passed.
