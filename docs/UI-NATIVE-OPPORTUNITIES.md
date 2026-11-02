# Opportunities in the local clinical suite

3 November 2026. Recommendation document for user review, based on branch
`saas/multi-clinic` at `df7ab43`. The main chat owns implementation and is working
on organization-shared patient identity. This review does not authorize a redesign
or implement features.

## Recommendation

Keep the familiar patient search, folder, Records, specialty forms, three procedure/
notes/fee sheets, diary, registration and print layouts. First make those paths
reliable against the local backend. Then connect their existing records through
patient identity and actual visits, with clinic, treating doctor, treatments and
items used. Doctor and item histories should be views of those same records.

The migration changes what can happen behind these screens: bounded queries,
consistent validation, transactional saves, protected files and recoverable
operations. It does not require replacing the clinical interface.

## Scope and evidence limits

Read first: [HANDOVER](HANDOVER.md), [patient CRM direction](PATIENT-CRM-DIRECTION.md),
[clinic switching](CLINIC-SWITCHING.md), [prior clinical UI review](CLINICAL-UI-REVIEW-2026-11-01.md)
and [local baseline](LOCAL-CLINICAL-BASELINE.md). The latest clinic-switching note
supersedes the baseline's disabled selector and separate Organization password.
Master > Organization reuses the existing Master password; do not introduce another.

This is static source review, informed by the earlier review's explicitly recorded
browser observations. No fresh browser acceptance, timing benchmark, API/DB tests,
migration, patient lookup, live record edit or provider probe was performed here.
Source findings identify behavior to verify; they do not certify a running install.
Only this document was created. No real patient data or credentials were read.

Organization is the database, credential, session, storage, subdomain and deployment
boundary. Clinics are operating units with explicit grants. The preserved clinical
bridge still has clinic-scoped patients at this snapshot; the separate organization
admin demo does not establish complete clinical-screen integration. Demo scope is
A with two clinics and B with one; independent lab units remain future scope.

Classification used below:

- **Existing:** source or current handover evidence; verification scope is stated.
- **Parity:** visible legacy behavior whose local backend contract is incomplete.
- **UI fix:** reliability/accessibility correction within the current layout.
- **New feature:** new user capability or data relationship requiring implementation.
- **Feasibility:** separate investigation, not an approved requirement.

## Current-screen evidence

Source links are relative to this document. Searchable function/action names remain
useful as the main chat changes line numbers.

| Screen or path | Concrete evidence at the review snapshot | Implication |
| --- | --- | --- |
| Patient Search -> patient folder | `PatientSearch`, `FolderPicker`, `RecordsPicker` in [index.html](../index.html), around lines 8314-8410. Search waits 400 ms after typing; results open the folder. Records keeps Procedures, Notes & Fees / Clinical Records / Daily Register. | Preserve destinations. Add useful history through the folder after review; a new dashboard is unnecessary. |
| Search outcomes | `PatientSearch.doSearch` sets an empty result array for unsuccessful responses; it has no request-sequence check in that function. [Legacy search](../api/src/legacy/patients.ts), `searchPatients`, returns at most 20 substring matches ordered by registration date. | Separate error from no matches; test delayed responses before changing patients. A 20-row cap needs refinement/more-results messaging. |
| Patient context | Sidebar still says `Active Patient` in `index.html` around line 32131; the earlier review records open-patient tabs. | Consider `Patient in view` as a small label correction, not an active-patient classification. Verify patient-tab isolation in every embedded form. |
| Procedures, Notes & Fees | `TreatmentProgress` around line 11651 loads daily-register history and receipts separately; read errors already warn that history/balances may be incomplete. | Reuse these good error states consistently. Payment totals grouped by date are not proof of a specific clinical encounter. |
| Clinical Records | [clinical.ts](../api/src/legacy/clinical.ts), `getClinicalRecords`, returns complete patient/tab history using sheet-like `_rowIndex`; the inner query numbers all rows of the record type before the patient filter. | Replace sheet-row addressing gradually with stable record IDs. Profile this query before assuming indexed history is already efficient. |
| Tooth/specialty records | [Generated field definitions](../api/src/legacy/clinical-forms.ts), `RECORD_HEADINGS`: Implant Surgery has doctor, site, brand, reference and LOT; Crown & Bridge includes impression material; Implant Prosthetic includes material. | Preserve detail. These fields are ingredients for usage history, not a delivered structured item/lot ledger. Regenerate this file through its generator if implementation later changes it. |
| Multi-visit cases | [cases.ts](../api/src/legacy/cases.ts), `getCaseForUpdate` and `recordStageOutcome`, plus [case-stages.ts](../api/src/legacy/case-stages.ts). Case writes lock rows; outcomes can cover selected stages and update an appointment/counter. | Retain stage logic. A counter or appointment is not a first-class actual visit; one visit must not automatically advance one stage. |
| Registration | [legacy patients](../api/src/legacy/patients.ts), `saveRegistration`, carries forward blank demographics/history rather than clearing prior values. [REST patients](../api/src/routes/patients.ts) has schemas and version-checked PATCH with 409 conflict. | Server validation/concurrency exists in one route family; do not claim every clinical form uses it. Make intentional clearing distinct from an omitted value. |
| Documents | `PatientDocuments` in `index.html` around lines 27554-27760 reads files as base64 and uploads sequentially. `removeDoc` awaits deletion but does not inspect success before displaying Deleted. | A specific UI fix candidate: failed deletion must remain visible as failed. Treat this as source evidence, awaiting a failing regression reproduction. |
| File backend | [legacy documents](../api/src/legacy/documents.ts) limits uploads to 25 MiB and inline reads to 7 MiB; checks permissions, opaque IDs and stored checksums; deletion is soft. [storage routes](../api/src/routes/storage.ts) manage providers, not a binary document-download endpoint. | Reuse private-file foundations. Larger-file delivery and staff-friendly progress/retry remain opportunities. Do not describe provider copy as backup. |
| Print and export | `printFeeSheet` uses a popup and timed print; `renderHTMLToPDFBlob` around line 29587 rasterizes HTML and splits long images, potentially through rows. [pdf.ts](../api/src/pdf.ts) offers a separate configured headless-browser path; `createDocumentPDF` files output. | There are several rendering paths, each needing acceptance. Server PDF configuration is required; it is not universally available by installing the frontend. |
| Master/new merged actions | `index.html` calls `getOccupationsList`, `getSafetyFlagsList`, `getReferralSourcesList`, `saveAppPassword`; matching implementations were absent from [legacy modules](../api/src/legacy/registry.ts) at this snapshot. They exist in [live-source Code.gs](../apps-script/out/Code.gs), e.g. list functions around 572-669 and action dispatch around 943-950/1080. | These are local parity gaps, not requests for new features. Embedded and dynamically constructed actions still need a complete inventory. |
| Local delivery | [pages.ts](../api/src/http/pages.ts) serves the existing screens, rewrites API addresses, vendors major CDN libraries and patches embedded HTML/CSP. `index.html` is 2,924,186 bytes on disk. | Local serving is already implemented. Measure parse/load cost; progressively extract assets without replacing clinical workflows. Source size alone is not a measured network transfer size. |
| Clinic and Organization | [CLINIC-SWITCHING.md](CLINIC-SWITCHING.md) and [organization actions](../api/src/legacy/organization.ts) describe authorized switching, context revisions, reload, shared Master unlock and versioned profile save. | Retain existing safeguards. Complete clinical defaults/print inheritance and shared patient history are not established by the organization-profile editor. |

## First improvements within the current layout

Effort is relative: **S** one bounded flow; **M** several screens/API contracts;
**L** schema/access migration and coordinated acceptance. These are planning
estimates, not delivery dates. Impact describes staff benefit.

| ID / class | Proposed change | Staff impact | Effort / prerequisites | Acceptance |
| --- | --- | --- | --- | --- |
| Q1 / Parity | Inventory top-level, dynamic and decoded embedded `/exec` calls; map to local actions, permissions, request/response shapes and live `Code.gs` behavior. Port missing Master lists, safety flags, referral rename, schedule breaks, document-password and report contracts in bounded slices. | High: existing buttons perform their advertised action locally. | M-L; main coordinator owns contracts and sequencing. | Every in-scope action maps to an implementation or an explicit unavailable state. Fictional registration, diary, Master, records, documents, CRM and finance round trips persist after reload; denied requests leave no partial writes. No redeploy-Apps-Script instruction for a local port gap. |
| Q2 / UI fix | Keep search position and result layout; add visible label, loading/error/retry/no-match states, keyboard selection and stale-response suppression. Explain capped results. | High: fewer wrong-chart selections and repeat searches. | S-M; stable patient/context identifiers from the identity work. | A delayed older query cannot replace newer results; failure never says no matches; Enter/arrow/focus behavior is predictable; DOB/UHID disambiguate fictional duplicate names. |
| Q3 / UI fix | Display save/saving/failed states consistently, check deletion responses, retain input after failure, prevent duplicate clicks. Use plain staff messages and a support reference. | High: staff can trust whether work was saved. | M across independent mini-apps; preserve their existing Save buttons. | A forced save/delete failure shows no success, keeps recoverable input and offers retry. A late result cannot update another patient's chart or another clinic. |
| Q4 / UI fix | Keep patient identity and working clinic visible; offer actual doctor/date/tooth/site context where recording care. Use `Patient in view` if approved. Replace clickable navigation divs with equivalent keyboard-accessible controls. | High: clearer recording context without retraining navigation. | S-M; visit doctor selection depends on N1 below. | Patient/tab changes, clinic switching, embedded records and keyboard navigation show the correct chart. Historical entries retain their original attribution. |
| Q5 / UI fix | Standardize field-level server errors and explicit clear actions; derive dates from clinic-local rules rather than browser UTC defaults (e.g. `TreatmentProgress.today`). | High: fewer rejected or wrongly dated entries. | M; compatibility decisions for carry-forward registration fields. | Invalid dates/quantities and doctor/clinic mismatches fail without partial save. Blank carry-forward remains intentional; explicit clearing is audited. Test around clinic midnight independently of browser timezone. |

Q1 is necessary baseline work, not an excuse to defer a small, reviewed patient
journey indefinitely. Clinical staff should review each completed slice using their
existing forms. Bug fixes must start with failing tests; this review has not run
or written those tests.

## Native API/database opportunities

### Faster patient finding without downloading the register

Use organization-shared stable patient IDs from the coordinator's work; retain
legacy UHIDs/aliases with explicit mapping. Do not auto-merge patients by name or
mobile. Rank exact UHID and normalized mobile matches first, then prefix/name
matches; expose only the demographics permitted for selection. A shared family
phone is not a unique patient identity.

Existing migration 0003 has clinic/name and clinic/mobile B-tree indexes. Both
legacy and REST search include substring predicates; those indexes alone do not
establish fast arbitrary substring lookup. Consider exact/prefix queries first,
then benchmark an optional trigram index for names. PostgreSQL documents GIN/GiST
trigram support for LIKE/ILIKE, including non-left-anchored patterns; patterns
without extractable trigrams can still scan the index. See the primary
[PostgreSQL 18 pg_trgm documentation](https://www.postgresql.org/docs/18/pgtrgm.html).
This is an option to profile with real access policies, not a promised speedup or
an instruction to install an extension in this review.

Use synthetic datasets, the actual app role/RLS and realistic simultaneous desks.
Proposed initial targets for agreement: 100,000 fictional patients; p95 search API
under 300 ms and visible results within 1 second of the final keypress on the
agreed laptop/LAN, including debounce. Record cold/warm runs, hardware, payload,
query plans and concurrency; these numbers are targets, not measurements.

### Bounded histories and stable records

Return a first page of 25-50 entries with date/type/clinic/doctor filters, stable
IDs and a deterministic date+ID cursor. Apply patient/access predicates before
expensive history numbering where compatible; load original specialty payloads
only on opening them. Keep older pages reachable and label restricted/incomplete
history truthfully without leaking hidden counts or clinical details.

Do not quietly change existing `_rowIndex` consumers. Map them or migrate each
viewer to IDs with regression coverage. A timeline response may combine several
record types, but it must preserve source links and distinguish appointment,
actual visit, historical form and payment-only event.

Acceptance: traverse 10,000 fictional entries without missing/duplicated records
in an unchanged dataset; document behavior during concurrent insert/correction.
Proposed first-page p95 API target is 500 ms on the same declared setup. Export
all permitted matching records through a separate bounded process, not just the
visible page.

### Consistent writes, conflicts and retries

Reuse existing REST validation/version-check patterns. Extend to the familiar
save paths instead of assuming version columns alone prevent lost updates.
`saveClinicalSheets` currently upserts the whole chart without a submitted base
version; `saveRegistration` similarly lacks a client base-version predicate.
Case row locks serialize case operations but do not make all stale browser
forms safe.

Give editable records a base version and return an actionable conflict: preserve
the operator's input, show what changed where permitted, and allow explicit
reload/reapply. Do not silently merge clinical narratives. Use request identifiers
for retryable create/finalize operations so a timeout followed by Retry creates
one visit/receipt/document, rather than relying only on disabled buttons. Validate
relationships and permissions within the same transaction. External storage writes
need staged finalization/orphan cleanup because a SQL rollback cannot undo an
already uploaded object.

Acceptance: two fictional desks edit one chart; the stale save cannot overwrite
the first. Repeat a timed-out request and obtain one committed result. Clinic
context revision rejection remains effective through every new endpoint.

### Private uploads and reliable outputs

Retain Documents categories, permissions and preview placement. Add authenticated
binary/multipart upload and streaming download routes, with per-file progress,
cancel/retry, size/type validation, integrity checks and safe response headers.
Avoid public storage URLs. If direct object upload is later selected, use short
authorization plus server-side finalization and patient/unit permission checks.
Do not hold a long database transaction open for an entire large transfer.

Acceptance: a permitted 20 MiB fictional scan can be downloaded despite the old
7 MiB inline limit; unauthorized guessed IDs and cross-organization links fail;
failed/cancelled upload is not listed as complete. Permission revocation applies
to new reads. Verify provider failures and cleanup, not only happy-path local files.

For print/export, keep current forms and letterhead dimensions. Establish shared
templates and readiness checks for fonts/images instead of fixed delays. Evaluate
the existing server renderer for longer documents; preserve a useful print fallback
and an explicit unavailable/busy error. Add queued exports only if measured demand
justifies them, with permission recheck and expiring private output.

Acceptance: preview, printer and PDF agree for long procedure histories, receipts,
specialty sheets and daysheets; no clipped tooth chart, split unreadable row or
missing signature/letterhead. A failed history/receipt read cannot yield a seemingly
complete balance statement. Reprints retain the intended historical identity and
clearly distinguish a corrected version. Real printer/browser/provider acceptance
remains necessary; source review cannot establish it.

## New feasible clinical features

These extend the accepted product direction; placement and detailed behavior
remain recommendations for review, not delivered functions.

| ID | Capability and familiar entry point | Impact / effort | Prerequisites and acceptance |
| --- | --- | --- | --- |
| N1 | Actual visits linked from the folder and existing procedure/forms workflow: date/time, clinic, actual treating doctor, tooth/site, treatments and case stages. Planned appointment doctor remains separate. | Very high / L | Shared patient identity, authorized clinic/doctor relationships, transaction/retry/conflict contracts. One fictional sitting can cover multiple treatments/stages; an unscheduled visit is possible; cancelling an appointment does not erase completed care. Historical unknowns remain explicitly unknown. |
| N2 | Overview/history shortcut within the patient folder; chronology linking original specialty forms, visits, documents and permitted finance. | Very high / L | N1 plus legacy mapping and paginated access-scoped read model. One fictional patient visits A1 then A2; authorized staff see the permitted chronology, restricted staff see no protected payload, and B remains isolated. Old forms remain reachable and unchanged. |
| N3 | Item usage within the relevant visit/form: item identity, quantity/unit and applicable lot/batch; patient/doctor/treatment links retained. | High / M-L | Item vocabulary/unit rules, mappings from existing specialty details, N1 and correction policy. A known lot can be traced to permitted visits/patients; unknown legacy quantities are not invented. Usage is clinical consumption, not stock purchasing or warehouse accounting. |
| N4 | Doctor History and Item History as authorized drilldowns under an agreed existing Records/Reports location. | High / M after N1/N3 | Same underlying records, filters and indexes; historical identity snapshots/reference policy. Renaming/deactivating a doctor/item does not reattribute past care. Selecting a result opens the original visit. Define visits vs procedures vs units consumed so counts do not multiply through joins. |
| N5 | Clinical corrections/addenda and an understandable record history beside the original form. | High / M-L | Existing audit/version foundations, authorship and finalization rules. A correction records author, time, reason and superseded version; finalized original remains inspectable. Routine roles cannot silently rewrite provenance; finance retains its own void/correction rules. |
| N6 | Recoverable server drafts while keeping explicit final Save/Finalize. Show Draft saved at / Finalized distinctly. | High / L across embedded forms | Stable patient/visit/form IDs, permissions, version checks and retention policy. Draft scope includes organization, clinic, patient, author and form version. Refresh/crash recovery restores only the authorized draft; switching patients never reuses it. Logout/shared-PC behavior, expiry and revoked access are tested. No unreviewed clinical payload cache in localStorage; encryption at rest alone does not authorize another operator. |
| N7 | Organization defaults and explicitly permitted clinic overrides in existing Master sections and print settings. | Medium-high / M-L | Resolve with the current organization model; avoid a second settings store. Show effective value, inherited source and allowed override/reset. Master > Organization keeps the existing Master unlock plus server grants. Test A1 override, A2 inheritance, reset, audit/conflict and historically correct printed attribution. Organization profile text alone is not full inheritance. |

For N1-N5, distinguish actual treating doctor, author entering the record and later
correcting author. Preserve legacy free text alongside validated links; uncertain
matching needs review rather than guessing from the signed-in user or a typed name.
Do not infer a new encounter for every imported row or merge all same-day care into
one encounter without approved mapping rules. Audit logs are useful foundations,
not a staff-readable correction workflow by themselves.

## Local operations and recovery

The local frontend/API/PostgreSQL baseline does not depend on Sheets for every
request. That is different from a verified offline-capable product: remote Drive,
fonts, messaging and other integrations can still have dependencies. Vendor or
remove remaining external assets only after checking the actual paths. Measure
startup, login, first chart, first embedded form and print readiness; extract the
large shell/embedded assets progressively with cache versioning and unchanged
field/print behavior.

Before operational use, deliver a documented organization-level backup and restore
routine covering database, private documents, configuration and separately protected
keys. Existing provider-copy utilities and demo provisioning are not proof of a
scheduled, complete recovery system. The handover records no backup script/restore
drill and an unresolved Drive account choice; verify current implementation with
the coordinator before assigning work.

Agree recovery point/time objectives, retention, backup destination and operator.
Expose last successful backup and actionable failure to authorized operators;
keep technical health details out of routine patient screens. Include predictable
service startup/restart, disk-space checks, schema/release compatibility, safe
upgrade/rollback instructions and support references. Re-bootstrap/reset/seed is
not an upgrade procedure for an existing installation.

Acceptance: restore one synthetic organization's database and documents into an
isolated target; verify patient history, receipts, file checksums, grants and key
availability; record duration and achievable data-loss window against agreed
objectives. Restore must not alter another organization. Practice recovery after
a simulated interrupted upgrade and remote-storage outage. A backup job reporting
success is insufficient without the restore exercise.

## Separate feasibility choices

| Choice | Potential value | Investigation required before any commitment |
| --- | --- | --- |
| Desktop packaging | Easier launcher/service status and controlled local installation. | Compare a browser shortcut plus managed services with a packaged shell. Decide installer signing, update ownership, complete asset/runtime packaging, PostgreSQL lifecycle and document/backup paths. A desktop wrapper does not provide data sync or recovery. |
| Multi-device offline recording/sync | Continued entry when a device cannot reach the organization server. | Separate substantial product/architecture decision: approved data subset, device trust/encryption, authentication expiry/revocation, queue/idempotency, identifier issuance, conflicts, clinical finalization and reconnect behavior. Do not cache all charts or silently replay writes into a different clinic. |
| Optional note search, reminders or analytics | Faster retrieval/follow-up after core history is trustworthy. | Review need, permissions, definitions and external-message authorization first. Full-text clinical search can reveal sensitive material; metrics must derive from recorded care. No AI, new consents, inventory, lab-unit workflow or contact-centre queue is approved by this document. |

No framework, wrapper or sync engine is selected here. These options have no
delivery estimate until requirements and deployment conditions are reviewed.

## Suggested phases and review gates

1. **P0: reliable familiar baseline.** Q1 inventory and highest-impact Q2/Q3 fixes;
   registration/diary/records/finance/document/print acceptance using fictional data.
   Identify validation/concurrency gaps and establish backup/restore ownership.
   User reviews the proposed small changes before application work in this chat.
2. **P1: one complete care journey.** Integrate with the coordinator's patient
   identity work; N1/N2 plus consistent validation, concurrency and bounded history.
   Prove a fictional A1 -> A2 journey with actual doctor, one multi-stage treatment,
   original specialty record and an explicitly unknown legacy attribution.
3. **P2: reusable clinical histories and resilience.** N3-N5, upload/download and
   print reliability; agree safe draft behavior before N6. Complete N7 where
   inheritance is needed. Benchmark with synthetic volumes and complete the
   isolated restore drill before operational reliance.
4. **P3: optional convenience.** Asset/build extraction guided by measurements,
   additional history summaries and optional feasibility investigations. Desktop
   packaging/offline sync require separate decisions and are not phase promises.

Across every phase: permission checks cover search, history, documents, exports,
drafts and aggregates; hiding a button is insufficient. Test clinical, reception,
accounts and organization-management grants, stale tabs/context revisions, revoked
access, cross-organization requests, patient-tab isolation, keyboard use and clinic
midnight. Do not expose finance merely because identity is organization-shared.

Implementation tests must be coordinated through the main chat and run serially
on the shared test database. This review ran none. Each phase needs a recorded
acceptance result, remaining gaps and staff review; a menu entry, schema column or
passing API check alone must not be reported as a delivered clinical workflow.

## Decisions for the implementation coordinator after user review

- Confirm the first parity slice and the proposed search/save/delete corrections.
- Agree where Overview/history and doctor/item drilldowns fit within existing
  navigation; keep the deferred redesign out of the immediate work.
- Set visit finalization/correction rules, legacy-attribution review and draft
  retention/recovery behavior with clinic staff.
- Agree synthetic benchmark setup/targets and operational recovery objectives.
- Keep desktop packaging/offline sync as separately scoped choices.

The first reviewable result should be the same recognizable clinical suite with
trustworthy local actions, followed by one complete patient care journey.
