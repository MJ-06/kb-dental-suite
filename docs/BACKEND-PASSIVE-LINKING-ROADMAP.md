# Backend foundations with the current UI and passive linking

3 November 2026. User direction: keep existing entry screens and passive linking.
A unified visit workflow can come later. This is a review roadmap, not evidence that
all items below are implemented, and not permission to introduce mandatory screens.

## UHID versus internal identity

Keep UHID as the visible identifier for staff and as an accepted API lookup key.
Patients must not receive another visible registration number merely to connect CRM.
The database already has UUID primary keys on patients and org_patients; these are
internal references, not a second registration or a security credential. Reuse the
existing canonical organization patient ID for durable links. Do not create another
CRM patient identity when an organization patient already exists.

UHID-only relationships are technically possible if UHID is unique and immutable
within an organization. Historical clinic books can reuse a UHID for different
people: migration0025 explicitly preserves clinic aliases and assigns a distinct
organization alias where required; it never merges by UHID/name/phone. Consequently
an unqualified historical UHID is not always a safe global foreign key. Resolve
organization + UHID (and clinic alias context when needed) at the API boundary;
reject ambiguity rather than choose the first match. Persist the resolved canonical
ID internally, preserving the displayed historical UHID and source provenance.
Authorization is checked independently of either identifier.

## Passive model

Preserve registration, appointment, clinical form, case/stage, procedure/notes/fee,
material and CRM entry paths. A new visit record is optional; no visit-first wizard
or required visit_id is introduced. Existing records remain valid while unlinked.

Use existing stable record IDs. Store optional typed relationships to patient,
clinic, actual doctor, treatment case/stage, visit, item usage and CRM entity. A
record can be explicitly associated later without re-entering it or rewriting its
clinical facts. Validate the identity/organization/clinic relationship on every
link. Patient + date proximity, an appointment or a visit counter alone is not
proof of the same actual visit. Preserve unknown attribution and unresolved matches.
Record who linked/unlinked/corrected what, when and why. Do not auto-confirm guesses.

Example: a procedure note and material entry saved through today's forms can later
be associated with one visit. The original records retain their IDs, clinic, dates,
recorded doctor, versions and audit history. An optional future unified screen
writes through the same backend services rather than becoming a second data store.

## Prioritized backend inventory

P0 = foundations for current correctness; P1 = connect existing data; P2 = later
capabilities/scale. Priorities are proposals; acceptance should be scoped per slice.

| Area | Existing foundation | Improvement that preserves the entry workflow | Priority |
| --- | --- | --- | --- |
| Organization tenancy | Dedicated organization demo DBs; clinical organization/unit bridge, grants and context revisions | Consolidate the transitional clinic-local patient/account references into one organization identity and explicit clinic memberships, using additive migration and compatible adapters. Pin deployment/configuration/storage/session boundaries to one organization. Do not broaden clinical RLS for shared identity. | P0 |
| Patient and UHID resolution | Canonical org_patients UUID, clinic links, retained UHID aliases | One resolver for all APIs/CRM/imports; explicit unknown/ambiguous results. Central demographic field ownership, alias provenance, duplicate-candidate reports and reviewed merge/unmerge design. No automatic identity merging. Distinguish opening an internal clinic reference from a new patient/lead. | P0 |
| Stable source records | Most clinical tables already have UUID IDs; old APIs expose sheet-like row numbers | Return stable IDs as hidden response metadata, preserve original external keys, and map old row addressing to persisted records. Reuse IDs on edit. CRM storage-row UUIDs recreated during collection replacement are not durable CRM entity identity. | P0 |
| Passive relationships | Patient links, treatment-case stages and clinic-scoped references exist | Add nullable encounter links and typed relationship tables, with scoped FKs/validation, source/version, actor/time and correction history. Keep unlinked records usable. Prevent linking another patient's record or another clinic's care to a visit. | P1 |
| Shared backend services | /exec compatibility adapter and REST routes coexist | Extract common patient/case/clinical/finance/document/link services. Preserve request/response behavior through adapters; make both entry paths enforce the same transactions, validation and access. Complete merged Master/document/report parity before relying on absent actions. | P0 |
| Input and relationship validation | REST schemas and some legacy validation exist | Shared schemas, explicit missing-versus-clear semantics, safe date/time parsing, bounds and organization/clinic/patient/doctor checks. Do not silently invent or correct clinical facts. Stricter rejection of previously accepted data is a behavior change requiring a scoped decision. | P0 |
| Concurrent editing | Version columns, some REST version checks, case row locks | Extend base-version checks to legacy registration, charts, forms and CRM collections. Preserve drafts/inputs on conflict. Locking a row or serializing requests alone does not prevent a stale save. Hidden client version metadata can preserve layout, but conflict feedback is still necessary. | P0 |
| Retry safety | Transactions and limited frontend read retries | Persist operation/idempotency keys for create/save/finalize actions that may be retried. Return the original result for the same operation; never infer duplicates solely from identical amounts, payloads or timestamps. Thin client request-key changes may be needed without changing screens. | P0 |
| Clinical revisions and corrections | Audit rows; immutable notes/addenda in parts of the organization demo | Preserve prior source revisions and separate draft changes from corrections to finalized records. Retain author, treating doctor, clinic, source and correction reason. Prepare the backend first; do not impose a new finalize workflow silently. | P0/P1 |
| Doctor identity | Clinic doctors/staff, named form fields and mapped accounts | Canonical staff/doctor identity plus clinic memberships; actual treating doctor distinct from scheduled doctor and data-entry author. Keep historical name/registration snapshots. Map historical text only where unambiguous; unknown stays unknown. | P1 |
| Treatments and stages | Procedure library, treatment cases, stage outcomes and counters | Stable performed-treatment/outcome IDs, explicit procedure/site/doctor/clinic/date, optional case/stage/visit links. Preserve current multi-stage-per-sitting logic. Catalogue edits must not rewrite older cases or performed-care facts. | P1 |
| Materials/items | Specialty fields include material/brand/lot/quantity where applicable | Organization item vocabulary, clinic availability/allowed overrides, units and decimal quantities, manufacturer/lot identifiers and usage corrections. Usage can attach to an existing form/procedure before a visit exists. Keep unknown old quantities null; do not invent stock purchasing/inventory scope. | P1 |
| CRM entity links | Clinic CRM collections/inbox and existing external IDs | Stable CRM entities and canonical patient references; preserve legacy CRM IDs/UHIDs as aliases. Incremental saves and collection base versions replace destructive whole-list replacement internally. Organization-wide contact identity; clinic attribution on care/activity. Preserve current screens/pipelines until reviewed. | P1 |
| Finance integrity | Clinic receipts, counters, voiding and financial permissions | Central patient reference with clinic ledger ownership; immutable issued-receipt facts, explicit void/correction/reconciliation, retry protection and scoped numbering. CRM payment collections must not become a competing accounting source. Shared patient access does not grant financial access. | P0/P1 |
| History and search | Permitted paginated history, directory search, indexes | Stable cursor contracts, normalized source references, permitted filters, source detail endpoints and explicit empty/error/partial states. Profile query plans; index proven access patterns, avoid N+1 queries and unbounded reads. Stage legacy row-number and whole-list consumers compatibly. | P1 |
| Defaults and configuration | Organization settings/demo inheritance; clinic settings still used by older modules | One versioned settings resolver: organization defaults, allowed clinic overrides, source-of-effective-value and invalidation. Apply consistently to doctors/chairs/catalogues/fees/forms/letterheads where policy allows. Keep issued/historical document snapshots. Do not invent which financial/clinical settings may be overridden. | P0/P1 |
| Documents/storage | Local/S3/Drive adapters, checksums and metadata | Organization-owned storage configuration/boundary with scoped clinic/patient paths, stable document IDs, staged upload/finalization, checksums, orphan cleanup and metadata versioning. Add private binary transfer endpoints beside compatible base64 APIs; migration preserves old storage locations. No public document URLs. | P1 |
| Print/export | Several browser paths and a configured server-renderer path | Reusable versioned templates, source snapshots, font/image readiness and reproducible exports. Add backend rendering/queued export endpoints where useful; switching visible print behavior requires browser/printer comparison and approval. | P1/P2 |
| Integration/jobs | Existing synchronous local APIs | Transactional outbox for patient/link/care changes, versioned event contracts, retry/backoff, idempotent consumers, failed-job visibility and permission rechecks for exports. Prepare disabled connector interfaces; sending real data externally requires explicit integration authorization. Start simple; no microservices/message broker requirement. | P1/P2 |
| Authorization and sessions | Permission checks, RLS, Master unlock and stale-clinic rejection | Apply the same scoped checks to new relationship/lookup/export/job paths, avoid role-name assumptions, recheck revoked access and redact restricted aggregates. Retain the existing Master password. Move remaining writes/password submissions out of URLs without changing form layout. | P0 |
| Audit/observability | Audit/system logs and request logging | Correlation IDs, structured error categories, timing/query/job metrics, append-only relationship/revision audit, and credential/patient-data log redaction. Do not record clinical payloads or patient lookup strings in routine request logs. Audit is not the operational backup. | P0 |
| Operational recovery | PostgreSQL/local runtime and setup scripts | Repeatable start/stop/health checks, documented service profiles, environment/config validation, org-specific paths, dependency lockfiles, encrypted DB+document manifests and backup/retention/recovery procedures. Prove restore in an isolated target; credentials/keys stay outside Git. | P0 |
| Migrations/releases/tests | Numbered/checksummed migrations, synthetic fixtures and serialized DB tests | Additive expand/backfill/verify/contract migrations, idempotent count-only reconciliation, feature activation per organization, compatible rollout and forward recovery. Contract tests across old/new APIs, two-org isolation, clinic/role revocation, stale saves, retries, passive links, historical unknowns and restore acceptance. | P0 |

## Proposed delivery order

1. Inventory/complete existing local API parity and stabilize patient/UHID/source-ID
   resolution, authorization, audit/log redaction and migration reconciliation.
2. Consolidate backend services and add retry/concurrency contracts, maintaining
   existing screens. Record compatibility results and necessary error behavior.
3. Add optional relationship metadata plus doctor/item/treatment identities and
   source revision provenance. No required visit_id, new forms or forced linking.
4. Connect CRM entities to central patients and improve permitted history/search/
   document/configuration read models. Existing flow remains the default.
5. Add outbox/connectors/export jobs and operational recovery acceptance where
   needed. A unified visit UI is a later, separately reviewed consumer of these
   services; desktop packaging/offline sync also remain separate decisions.

## What cannot be promised as literally invisible

Schema/IDs/services/indexes/aliases/optional links can be added without changing
screen layout or requiring new steps. Concurrency and validation protections must
occasionally refuse a stale/invalid save; the existing screen needs useful feedback.
Request IDs/base versions may require thin frontend adapter edits, not new workflow.
Streaming uploads, new print paths, stricter finalization or altered clinical rules
need separate acceptance; adding backend support alone is not proof they are ready
for staff. Do not promise a universal zero-behavior-change migration.

## Existing evidence, not new certification

Reviewed owning sources include migrations0025/0026 and shared-patient/history
modules, legacy cases/diary/clinical/CRM adapters, REST patient routes, storage
adapters, UI-NATIVE-OPPORTUNITIES.md and CLINIC-READINESS-BACKLOG.md. Historical
review findings may be superseded by later commits. This document adds no application
code, schema change, tests, dependency upgrade or measured performance claim.
