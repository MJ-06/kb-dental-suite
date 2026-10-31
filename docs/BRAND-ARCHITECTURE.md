# Organization architecture: backend contracts

> Current demo scope: Organization A has two clinics; Organization B has one.
> Labs are future scope. Any lab workflow/scenario below is future design, not a
> demo requirement. D01-D18 in [DEMO-DECISIONS.md](DEMO-DECISIONS.md) are approved.
> See [DEMO-VERIFICATION.md](DEMO-VERIFICATION.md) for current implementation/test status.


Date: 31 October 2026. Status: revised design proposal, not implemented or tested.
The user's corrected requirement supersedes the earlier clinic-instance design:
**organization is the deployment and isolation boundary; operating units share its DB**.
Read [HANDOVER](HANDOVER.md) and [the coordinating plan](BRAND-CLINIC-PLAN.md).

## Topology and terminology

Use one repository, dependency lockfile and immutable product artifact for all
organizations. Each organization has its own runtime deployment, database, runtime credentials,
sessions, storage scope, encryption-key reference, subdomain and protected config.
Each deployment opens one pool to its organization DB. Start with separately configured
processes/services on the laptop; containers can package this topology later.

Within an organization, operating units share customer/patient identity, defaults,
catalogues and organization-created forms. Use `unit` or `operating unit` internally, with
validated `type=clinic|lab` initially and room for future types. These are business
units, not OS processes or independent schema releases. The organization console IS the
organization admin panel in this application: it includes per-unit sections, metrics,
form assignment and authorized cross-unit customer workflows.

No separate management service/database is required for MVP. Configuration, grants,
reports and cross-unit records use local organization-DB transactions. A restricted
platform deployment inventory may record organization endpoints, release/schema and backup
status, but no patient index, records, document links, sessions or runtime passwords.
No per-unit DB router, config distribution or reporting federation is required.
No cross-organization patient store or distributed transaction is introduced.

## Existing behavior versus proposals

Evidence below comes from the working tree, including another workstream's
uncommitted forms/phone changes. It describes the refactoring starting point.

| Source evidence | Existing behavior | Required proposal |
| --- | --- | --- |
| `api/src/server.ts:5`; `api/src/db/index.ts`, `createDb` | One `DATABASE_URL` pool, maximum 10 by default | Retain one pool per organization deployment; budget connections across organizations |
| `api/migrations/0001_foundation.sql`, `clinics` | Clinic UUID/code/timezone; `database_url` placeholder; clinic context/RLS | Organization identity plus operating units; classify tables as organization-wide or unit-scoped |
| `api/migrations/grants.sql` | Privileges target literal `kb_app`; registry reads restricted | Refactor provisioning/grants for distinct organization login roles and narrow identity attestation |
| `api/migrations/0002_users_sessions.sql`, `begin_login`; `api/src/auth/login.ts` | Clinic-code login establishes clinic context | Organization-host login; authorized unit selection after authentication |
| `api/migrations/0020_roles.sql`; `api/src/db/index.ts`, `resumeSession` | Current active user/clinic and role permissions read on resume | Organization session with current organization/unit grants checked on requests |
| `api/src/http/context.ts`; `api/src/legacy/route.ts` | REST uses `asActor`; legacy directly calls login/resume | Common organization/scope checks across all retained paths, or replace old entry points |
| `api/migrations/0004_masters.sql`, `clinic_settings`; `api/src/auth/permissions.ts` | Clinic JSON settings and local roles | Typed organization defaults/rules and explicit permitted unit overrides |
| `api/migrations/0021_forms.sql` (uncommitted) | Versioned clinic forms; submissions reference exact definitions | Organization-owned immutable forms, unit assignments and unit-scoped submissions |
| `api/src/storage/index.ts`; `api/src/storage/local.ts:8`; `api/src/secrets.ts` | Clinic storage selection; process document root/key | Organization storage/key boundary with authorized unit document metadata |
| `api/src/routes/admin-reports.ts` | Clinic reports, including identifying exports | Organization/unit reports in one DB, with distinct aggregate/identity/export permissions |
| `api/src/app.ts`, `/health` | Only `SELECT 1` | Restricted identity/schema/config readiness |

`clinics.database_url` does not route connections. Do not activate it: select the
organization DB from protected configuration before startup. Retire the placeholder and
obsolete types through a planned new migration after reference checks. Applied
migrations remain untouched unless a later explicit development reset is authorized.
Choose migration numbers during implementation; 0021 is shared uncommitted work
and 0022 already exists.

This is a test product: refactoring/replacing old schema and `/exec` compatibility
is allowed where appropriate. Preserving an old clinic identity model is not a
product requirement. Conversion needs a coherent data/authentication plan rather
than indefinitely maintaining competing models. This document changes no code and
does not overwrite the other workstream's files.

## Organization pinning, credentials and storage

Provision stable organization UUID, deployment UUID, environment and canonical origin.
Organization ID survives hostname changes/restores; deployment ID identifies an installation.
Environment separates development/rehearsal/production. Names/codes/domains are
mutable labels, never authorization identities.

Proposed protected runtime settings: `EXPECTED_BRAND_ID`, `DEPLOYMENT_ID`, environment,
canonical origin, `DATABASE_URL`, explicit document root and key reference. Compare
these to an owner-managed singleton DB identity record through a narrow attestation
function. Startup refuses missing/mismatched organization/environment, unsupported schema
or unsafe storage config. Never derive expected organization from whichever DB opens.
Restrict Host/forwarded headers to approved origins; request headers never choose DBs.

Sessions, callbacks, administrative commands and jobs must match the pinned organization
before access. Scripts/migrators preflight explicit expected identity. A restored
test deployment has test-only service identity and cannot run production jobs,
send production notifications or claim production readiness.

Use a distinct runtime LOGIN per organization: no table ownership, superuser, BYPASSRLS,
CREATEDB, CREATEROLE or cross-organization role memberships. Permit CONNECT only to its own
DB; remove unwanted PUBLIC CONNECT and inherited privileges reaching other organizations.
Refactor literal `kb_app` grants instead of giving each login a common cluster role
with every organization's rights. Owner/migration credentials remain outside the runtime
and admin panel; provisioning/backup authority is separate and audited.

Each organization has protected config, DB secret, storage namespace/provider resource
scope and encryption key reference. Unit subfolders/namespaces organize records
within that organization and must use metadata authorization; they need not be separate
provider accounts. Different folders alone do not enforce isolation. Prefer separate
OS service identities; enforce DB grants, provider permissions and filesystem ACLs.
Organizations may share a PostgreSQL/OS host initially, accepting shared outage/admin risk.

## Proposed domain model

Organization-owned tables carry `brand_id`, housekeeping columns and audit history;
operational unit tables additionally carry `unit_id`. Composite foreign keys keep
referenced units, customers and roles in the same organization. Physical DB separation is
supplemented by forced organization RLS. Unit rows additionally require authorized unit
scope; missing organization/actor/scope fails closed. Do not mechanically rename every
`clinic_id` to `brand_id`: table ownership must be deliberately classified.

| Entity | Minimum contract |
| --- | --- |
| `brand_identity`, `brand_profile` | Singleton pinned UUID/environment; separately editable name/theme/legal metadata |
| `operating_units` | UUID, organization, type, unique organization/code, status, timezone, local contact/legal fields; IDs never recycled |
| `brand_users`, `sessions` | Organization identities, active flag, hashed tokens and expiry/idle policy; session is not all-unit access |
| `roles`, `role_permissions` | Stable IDs and named capabilities; mutable display names; optional template provenance |
| `brand_role_grants`, `unit_role_grants` | User/role, explicit scope, effective/expiry time, version and revocation history |
| `customers` | One organization-wide customer/patient UUID, organization number and demographic/contact identity |
| `customer_unit_links` | Customer/unit relationship, optional local display alias, status; unique organization/customer/unit |
| Encounters, appointments, lab orders, receipts | Organization/customer/owning-unit IDs, actors and historical business context |
| Config releases/overrides/activations | Immutable defaults/policy, permitted unit overrides, exact effective revision |
| Form definitions/assignments/submissions | Organization stable key and version, selected units/effective dates, customer and owning unit on submissions |
| Audit | Append-only organization actor, unit where relevant, operation, subject IDs and safe change metadata; secrets excluded |

Identity is shared; clinical/financial ownership remains attributable to a unit.
Do not put encounters or balances on the shared demographic row. A lab order may
share the necessary customer information without exposing the clinic's full notes
or financial history. Unit type enables suitable workflows, not permissions itself.

Cross-unit handling uses the same customer UUID. Creating an encounter at another
unit requires target-unit write rights and records that unit. Shared demographic
editing requires a separate identity-edit capability. Search returns permitted
identity fields without disclosing restricted encounters, balances or unit activity.
Clinical row access is never implied solely by knowing a shared customer UUID.

Legacy migration preserves source `(legacy clinic/unit ID, patient ID/UHID)` mappings.
Equal names, phones or UHIDs must not automatically merge distinct patients. Use an
explicit duplicate-review/merge workflow with audited authority. Propose one organization
customer number plus preserved unit aliases. Receipt-number scope/legal identity
needs confirmation; local sequences can coexist. Cross-unit payments, balance
transfers and consolidated invoices need explicit rules: shared identity does not
silently pool balances. Orders/referrals within an organization can use one DB transaction.

## Authorization, sessions and SSO boundary

Organization/unit administrators are capabilities, not role-name bypasses. Proposed organization
permissions include `organization:access:manage`, `organization:units:manage`, `organization:config:publish`,
`organization:forms:publish` and `organization:reports:read`. Operational permission names such as
`patients:read`, `clinical:write` and `finance:read` have explicit unit scope. Organization
administration does not automatically grant clinical access. A deliberate all-units
operational grant can exist and must be visible in access review.

For each request: pin organization -> resume active session/user -> load current grants ->
authorize requested capability/unit -> set transaction-local RLS context -> execute.
Unit IDs in paths/bodies are requested scope, not authority. Switching units selects
among current grants. Apply this to exports, batches, attachments, jobs and live
feeds as well as ordinary REST. If retained, `/exec` must use the same enforcement.

Customer identity tables have explicit identity-visibility policies. Unit clinical
and finance tables check owning unit and any explicit record-sharing grants. Avoid
RLS that exposes every customer's records merely because identity is organization-wide.
Policies may consult grant tables/current actor; any server-derived allowed-unit
context must be constructed centrally and tested against bypass paths. Transaction-
local context must not leak between pooled requests. Record actor and acting unit.

Use version checks/locks for concurrent edits. Preserve one active organization access
administrator with serialized checks. Unit administrators cannot grant authority
beyond their delegation or promote themselves to organization administration. Disabling
a unit blocks new writes according to policy while preserving historical reads and
records; it does not delete patient history.

One host-scoped organization session serves admin and unit views. Use HttpOnly/Secure
cookies and no parent-domain session shared with other organizations. Protect mutations
with Origin/CSRF checks: SameSite alone does not separate sibling subdomains.
There is no inter-unit launch SSO exchange or distributed revocation requirement.
Read current active user/grants on each request; revoke a grant to deny its next
operation. Delete sessions on credential reset/sign-out-all. Reauthorize live feeds
and exports on grant changes. Already-running bounded transactions may finish;
serialize sensitive operations with revocation if stricter semantics are required.

Later external SSO validates issuer/stable subject, audience, state/nonce, approved
redirects and server code exchange, then creates a local organization session. Provider
login alone grants no unit rights. Another organization needs explicit membership and its
own session; shared SSO identity does not imply cross-organization patient access.

## Configuration, forms and feature activation

Resolve product defaults -> published organization defaults/rules -> explicitly permitted
unit overrides, locally in one organization DB. No per-unit credentials, delivery queues
or distributed acknowledgement is needed. Each key has stable ID, type/schema,
default, owner, permitted override policy and compatible app/schema bounds. Organization
settings cannot weaken product security invariants. Explicitly classify local legal
identity, counters and sensitive integrations rather than overwriting them by theme.

Define missing/inherit, allowed null and override removal separately. Use field-level
patch semantics; catalogue arrays merge by stable ID, never label/position. Reject
unknown keys, duplicates, invalid references and secrets in published bundles. All
write paths enforce locked fields, including any retained legacy master endpoints.
Keep integration secrets outside versioned configuration payloads/history.

Publish immutable releases with UUID, sequence, hash, schema bounds, change note,
publisher/time and typed values/policies. Stable catalogue/form IDs are never reused.
Tombstones prevent future selection without deleting referenced history. Existing
lists need reviewed ID mapping rather than name matching. Keep override revisions,
activation history and effective provenance; display where each value came from.

Publication differs from activation: draft/diff/validate, select units, resolve
overrides, then activate affected effective pointers in one bounded local transaction.
Compare expected release/override versions and lock revision rows; return 409 without
partial activation on conflict. New locks over existing overrides need explicit
preview/acknowledgement; retain old values in history. Larger asynchronous local
batches can later expose per-unit progress/idempotency, but are not an MVP config
distribution system. Schedules specify an instant, timezone display and late policy;
business dates resolve in unit timezone, never host timezone.

Organization-created forms have stable keys and immutable published definition versions.
Assign exact versions to selected units/types with effective dates and fill/view
capabilities. Unassigned units cannot accept new submissions. Retiring assignment
preserves authorized historical reads. Submission IDs cannot bypass unit scope.
Unit customization is limited to explicitly permitted fields/defaults; organization-required
validation remains enforced. Submissions retain exact definition/config revisions
and needed display snapshots. A later definition never reinterprets old answers.

Feature flags enable already-installed supported behavior per unit; they do not
install code or independently migrate that unit. One organization runs one schema/product
compatibility range. Business writes bind one effective revision consistently and
save historical template/price/display values required to reproduce receipts/forms.
This is a requirement to verify during refactor, not a claim every current table
already snapshots them. Revert by new validated activation; never edit history.

## Proposed API contracts

Organization comes from pinned deployment/session, never caller-selected database. Any
explicit organization ID must match the pin. Mutations validate capability, scope, schema
and CSRF/Origin; versioned writes require expected revision/If-Match.

| Endpoint family | Contract |
| --- | --- |
| `GET /api/v1/organization` | Authorized profile/capabilities/app/config metadata |
| `/api/v1/units` | List allowed units; organization capability to create/change; creation does not grant operational access |
| `/api/v1/access/organization-grants`, `/api/v1/units/:unitId/grants` | Separate delegation boundaries, versions/expiry and audit |
| `/api/v1/customers` | Shared identity search/create/update with explicit field visibility and capabilities |
| `/api/v1/units/:unitId/customers/:customerId/encounters` | Unit-authorized operational records referencing shared identity |
| `/api/v1/organization/config-releases`, `/api/v1/organization/config-activations` | Immutable publication, diff and selected-unit activation |
| `/api/v1/units/:unitId/config` | Effective values/provenance and permitted versioned overrides |
| `/api/v1/organization/forms`, `/api/v1/organization/form-assignments` | Organization publication and exact-version selected-unit assignment |
| `/api/v1/units/:unitId/forms/...` | Assignment/capability checks for submissions and historical reads |
| `/api/v1/organization/reports`, `/api/v1/units/:unitId/reports` | Explicit aggregate scope; separate identifying-export authority |
| `/api/v1/organization/status` | Restricted release/schema/config/job/backup observations; no secrets |

Use 401 for invalid sessions, 403 for denied capability, consistent 404/403 behavior
for inaccessible IDs, 409 for revision/idempotency conflict and 422 for incompatible
configuration or semantic references. Redact secrets/patient payloads from errors
and logs. Retriable mutations with external effects require scoped idempotency key
and payload hash; duplicates return recorded results and changed payloads conflict.
Commit local effect/audit/idempotency receipt together. External notifications/storage
use local transactional outbox, deduplication and retries rather than a transaction
spanning database and provider. No admin-panel shell/SQL/migration endpoint is needed.

## Reporting freshness and correctness

Organization reports query one organization DB, applying authorized unit scope before aggregation.
Specify whether metrics count distinct organization customers, customer-unit links, visits
or orders. A customer attending two units is one distinct organization customer; summing
unit distinct-patient counts does not yield the distinct organization total. Attribute money
to owning transactions/units and explicitly handle reversals/transfers without double
counting. Organization report permissions do not implicitly allow patient-level exports.

Use a consistent snapshot for multi-query reports. Return metric definition version,
requested/included unit scope, timezone/date boundaries, currency, generated-at,
source-as-of and completeness/truncation metadata. Distinguish unit-local trading
days from a common UTC interval. Sum only compatible periods/currencies. Missing
computations are explicit, not zero. Limited authorization coverage must not reveal
restricted unit details. Detailed exports require scope checks and export audit.

MVP uses live SQL: source-as-of denotes its snapshot, not confirmation that staff
finished entry. If materialized summaries are later needed, expose refreshed-at,
source watermark, configured freshness threshold and stale/failed state. Backdated
edits, voids and corrections invalidate/recompute buckets; reconcile against source
periodically. No inter-unit replication/federation or second patient store is needed.

## Staged implementation and concrete acceptance gates

These are future tests, not results executed here. Coordinate serialized shared DB
test runs with the workstream owner. No tests/migrations were run, no code changed,
and no secrets or patient-data files were read for this design.

1. **Plan schema conversion.** Classify every current table as organization identity,
   unit operations or product metadata; map customers, foreign keys, auth/session
   paths, settings, documents, counters, reports and audit. Preserve legacy IDs and
   review duplicate identities. Use new migrations or separately authorized reset.
   Acceptance: no clinic context silently becomes organization context and no concurrent
   forms work is overwritten; all ownership and conversion gaps are listed.
2. **Prove two organization boundaries.** Fictional Organization A has two clinics and a lab;
   Organization B has a clinic. Use separate DBs/logins/roots/keys/origins. Swapped DB URL,
   expected organization UUID or environment fails readiness. A cannot connect to B, assume
   its roles, open files or decrypt protected credentials. A token/cookie fails at B;
   guessed customer/unit/form IDs reveal no B data. Pool reuse leaks no actor/scope.
3. **Prove shared identity and unit access.** One A customer has two clinic encounters
   and a lab order with one customer UUID. A clinic-one-only user cannot read clinic
   two notes/finance via search, IDs, attachment, batch or export. Lab users see only
   permitted assigned work. A multi-unit grant enables cross-unit handling without
   identity duplication. Config admin alone cannot read clinical records. Shared
   demographic edits require authority and reject stale versions.
4. **Activate organization rules/forms.** Verify inheritance, permitted override, locked
   denial on every write path, lock acknowledgement and concurrent revision conflict.
   Assign one organization form to clinic one/lab but not clinic two. Only assigned supported
   units accept new submissions; authorized old submissions survive retirement.
   Rename, price change, tombstone and rollback preserve historical rendering.
   Idempotent retries produce one effect. Config/features activate per unit without
   independent runtime deployment or schema migration.
5. **Validate admin reports and revocation.** Known fixtures cover per-unit totals,
   distinct-organization-customer counts, shared customers, voids, backdated changes,
   timezone/currency differences and restricted scope. Check stale/truncated labels
   when caching is introduced. Revoked grants deny the next request and reauthorize
   live feeds/exports; concurrent admin removals cannot leave zero organization admins.
6. **Release/restore per organization.** Follow operations plan: tested immutable artifact,
   backup/preflight, canary organization, full-organization migration/smokes, then remaining organizations.
   Restore all units/shared identities/history/documents coherently into an isolated
   target. Failed A update leaves B operational. Unit flags cannot substitute for
   migration compatibility. App rollback requires compatible schema; otherwise use
   rehearsed restore/forward fix. Production promotion is explicit after validation.

Units share the organization's outage/migration/recovery boundary. In exchange, shared
customer handling, grants, configuration and reports remain local transactional
operations. Physical separation between organizations allows independent releases and
recovery without building a distributed system inside each organization.

Remaining decisions: unit-only staff's shared-identity visibility; customer numbering
and merge authority; receipt/financial ownership rules; permitted overrides;
lab workflows; report definitions; optional identity provider; hosting/recovery
targets/responder. None changes the organization isolation boundary.
