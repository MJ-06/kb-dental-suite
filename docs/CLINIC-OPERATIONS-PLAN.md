# Organization operations plan

> Current demo scope: Organization A has two clinics; Organization B has one.
> Labs are future scope. Any lab workflow/scenario below is future design, not a
> demo requirement. D01-D18 in [DEMO-DECISIONS.md](DEMO-DECISIONS.md) are approved.
> See [DEMO-VERIFICATION.md](DEMO-VERIFICATION.md) for current implementation/test status.


Date: 31 October 2026. Status: proposed design and source review, not implemented or
verified in a running system. This document retains its assigned filename but the
operational boundary is **organization**, following the user's corrected architecture.
Companion: [BRAND-CLINIC-PLAN.md](BRAND-CLINIC-PLAN.md).

## Operating model

Each organization has one runtime deployment, database, database credentials, session
namespace, storage boundary, configuration and subdomain. Multiple operating units
inside that organization share the database, organization defaults and an organization-wide customer/patient
identity. Use `unit` internally, with `type=clinic|lab` and room for future types.
An operating unit is a business entity, not an OS process or independent deployment.

The organization console is the organization's admin panel in the same application. It manages
unit sections, metrics, defaults, allowed overrides, staff scopes and organization-created
forms assigned to selected units. Unit metrics and cross-unit customer handling
use queries within the organization database, subject to explicit permissions. No separate
management database, database router, reporting federation or distributed per-unit
configuration rollout is required for MVP. Platform operators may keep a non-secret
inventory of organization deployments; that inventory is not a customer-record service.

One repository, lockfile and tested immutable release support all organizations. A release
is built once and deployed separately to organizations. App/schema canaries, migrations,
backups and recovery apply to an entire organization. Form assignment, unit configuration
and feature activation can be narrower, but all units use the organization's schema.
An organization outage therefore affects its units together; organizations on one physical host
also share host/disk/PostgreSQL-administrator failure risk.

The product is still in testing. The implementation may be refactored or replaced;
there is no requirement to preserve the legacy adapter solely for compatibility.
Existing applied migrations must remain unchanged unless a later explicit database
reset/rebaseline is authorized and planned. This design task makes no code changes.

## Reviewed evidence and required changes

Paths are relative to repository root and describe the inspected working tree,
including another workstream's uncommitted forms/phone-session changes. Existing
clinic-scoped code is evidence of current behavior, not proof of organization/unit support.

| Source | Existing behavior | Implication for the proposed organization boundary |
| --- | --- | --- |
| `api/src/server.ts` | One pool from `DATABASE_URL`; configurable `HOST`/`PORT`; signal shutdown closes app and pool | Reusable runtime shape for one organization; no expected-organization assertion exists |
| `api/src/env.ts` | Loads module-relative `api/.env` and a home-directory owner file or `KB_OWNER_ENV` | Working directory does not select organization config; runtime can load owner credentials. Replace implicit loading with explicit runtime/maintenance config separation |
| `api/scripts/bootstrap.ts` | Fixed `kb_owner`/`kb_app`, `kb_pms`/`kb_pms_test`; rerun rotates passwords and rewrites env files | Development machine bootstrap, not safe resumable organization provisioning |
| `api/src/admin.ts`, `api/scripts/seed-dev.ts` | Owner-side clinic/user creation, seeded `kbdev` and development users | Not organization/customer/unit onboarding; do not use development seed for real organizations |
| `api/src/migrator.ts` | Sorted migrations, SHA-256 history, transaction per file, then repeatable grants | Useful guards; no advisory lock or whole-release transaction; earlier files remain committed after a later failure |
| `api/migrations/grants.sql` | Fixed `kb_app` grants with audit/receipt/history restrictions | Requires reviewed grants for distinct organization runtime logins on a shared cluster |
| `api/src/db/index.ts` | Default pool 10; 30-second idle timeout; 15-second statement timeout; clinic transaction context | Add explicit pool budget and redesign request context for organization identity and authorized unit scope, not one isolated patient tenant per clinic |
| `api/migrations/0001_foundation.sql`, `0002_users_sessions.sql`, `0020_roles.sql` | Clinic RLS, registry, SECURITY DEFINER auth helpers; sessions have enabled but deliberately unforced RLS | Current clinic policies cannot simply be renamed: organization-shared customers and unit-scoped records need explicit policies and restored ownership verification |
| `api/src/app.ts` | `/health` only runs `SELECT 1`; proxy trust is loopback | Need organization/schema/readiness validation and reviewed production proxy trust |
| `api/src/routes/auth.ts` | Login accepts clinic code; session cookie has no Domain attribute | Replace clinic tenant selection with pinned organization and scoped unit selection; preserve host-only cookie isolation |
| `api/src/http/pages.ts`, `api/tsconfig.build.json` | Built API reads root HTML and `api/node_modules` assets | Current `dist` alone is not a complete release. Package required files or replace with a verified self-contained build |
| `api/src/storage/index.ts`, `local.ts`, `copy.ts` | Per-clinic provider config, document backend/ref, home-folder local default; checksum-verified copy | Design organization-owned storage and authorized unit access, explicit root, and migration mapping; copy is not backup |
| `api/src/secrets.ts` | AES-256-GCM, one process-wide `KB_SECRETS_KEY`, no key ID in sealed payload | Separate key per organization; design versioned recovery/rotation rather than replacing key in place |

The handover records no implemented backup job or restore drill. No organization provisioner,
fleet release automation or production service configuration was identified in the
reviewed operational paths. Historical tests do not verify this new architecture.
No tests, builds, migrations or provider probes were run here; no secrets or
`migration/data` were read. Other contributors' changes are preserved.

## Laptop-first layout and configuration

Start with two fictional organizations and multiple units per organization on the existing
Windows PostgreSQL 18 service. Docker is not installed. Illustrative resources:

| Resource | Fictional organization A | Fictional organization B |
| --- | --- | --- |
| Organization code | `demo-a` | `demo-b` |
| Units in its database | Clinic A1, Lab A2 | Clinic B1, Lab B2 |
| Database / runtime login | `pms_brand_a` / `pms_brand_a_app` | `pms_brand_b` / `pms_brand_b_app` |
| Schema owner | `pms_brand_a_owner` | `pms_brand_b_owner` |
| App listener | `127.0.0.1:8101` | `127.0.0.1:8102` |
| Browser origin | `demo-a.localhost:8101` | `demo-b.localhost:8102` |
| Mutable root outside checkout | `<ops-root>/organizations/demo-a/` | `<ops-root>/organizations/demo-b/` |
| Future production origin | `organization-a.<controlled-domain>` | `organization-b.<controlled-domain>` |

Units do not receive separate ports, databases or subdomains for this MVP. The
organization UI selects authorized units using validated IDs/routes. Organization-shared customer
identity is not silently copied or split when changing the active unit. Record
provenance such as the unit performing a visit/service remains explicit. The
permission contract determines who can view a customer across units and which
clinical/financial details are available; organization membership alone is not universal
access. Unit restrictions must be enforced server-side, including exports, search,
forms, documents and metrics.

Different ports on the same hostname do not isolate cookies. Use distinct hostnames
for the two organizations and verify resolution and browser behavior. Prefer trusted local
HTTPS. An explicitly disposable HTTP demonstration may set `COOKIE_SECURE=false`;
production requires HTTPS and secure host-only cookies. Unknown Host values are
rejected, never routed to a default organization. Preserve origin checks/CSRF defenses
across all state-changing endpoints.

A non-secret deployment manifest records organization UUID/code, expected database name,
port/origin, artifact digest, schema target, organization-config version, storage namespace,
secret references, backup policy and provisioning status. Store unit IDs/types in
the organization database, not as a fleet of runtime configurations. No connection URLs,
passwords, keys or patient records belong in fleet inventory or logs.

Proposed runtime configuration includes `DATABASE_URL`, expected organization UUID, `HOST`,
`PORT`, `COOKIE_SECURE`, explicit `DOCUMENT_DIR`, sealing-key reference and pool max.
Organization pinning and pool max require code changes; these are not already supported
settings. Startup must validate database identity, correct runtime role, expected
organization UUID, schema compatibility, key format and document-root ownership before
listening. Every login, session resume, legacy route retained during transition,
background job and export must stay bound to that organization.

Use one explicit runtime config source; do not silently fall back to development
`.env` or home owner credentials. `KB_OWNER_ENV` currently selects only an owner
file, not the running app's config. Provide maintenance credentials to short-lived
maintenance tasks only. Do not expose secrets through command lines, transcripts,
logs or shared shell environment changes between organization launches.

One read-only release can be shared across organization processes; mutable files, logs,
keys, temporary data and document roots remain separate. Build/package from a clean
staging checkout and the lockfile, excluding ignored data and secrets. Do not run
watch mode, install dependencies or edit shared release files during rollout.
Retain the previous artifact. Windows ACLs must explicitly protect secrets/data;
Unix file mode arguments alone do not establish a Windows security boundary.
Processes under the same desktop account can access each other's permitted files:
use fictional data for that demonstration. An unattended pilot needs reviewed
separate service identities, restart/backoff and reboot startup, not terminal windows.

## Organization database roles, RLS and pooling

Roles are cluster-wide. Each organization gets a distinct runtime login and distinct
schema owner/migration identity. Runtime owns no objects and has no superuser,
CREATEDB, CREATEROLE or BYPASSRLS privilege, nor membership enabling another organization
or owner role. Keep cluster administration separately controlled and audited.

Revoke unwanted PUBLIC database privileges; grant intended roles CONNECT only to
their own organization database. Audit every database's effective access, including
management/maintenance and template databases: an A-specific grant does not remove
PUBLIC access elsewhere. Restrict database/user/network authentication rules while
retaining explicit emergency administrative access. Keep laptop PostgreSQL on
loopback; production database ports stay private and remote connections require
verified TLS.

Replace the fixed-role grants mechanism with reviewed organization-specific runtime grants
that preserve audit append-only, receipt deletion, schema-history and other intended
denials. Review schema CREATE and PUBLIC function EXECUTE rights, SECURITY DEFINER
owners and search paths. No broad shared login/password or cross-organization owner role.
Applied numbered migrations remain immutable; add subsequent changes using the next
available number coordinated with the existing workstream. A test-data reset or
rebaseline is a separate later decision, never an implicit provisioning action.

RLS defense changes with the data model: organization-shared customers are available only
under authorized organization context, while unit-specific events/documents/finance/form
submissions also enforce the actor's explicit unit scope and permission. Organization admin
operations need defined authority; an arbitrary request-supplied unit ID must not
expand scope. Current clinic RLS is not evidence that these policies already work.
Verify no-context access, cross-organization rejection, scoped cross-unit reads/writes,
permitted organization-wide access and pooled-connection cleanup. Inventory deliberate
exceptions such as sessions instead of claiming every table has forced RLS.

Budget PostgreSQL connections across organizations, not units:

`sum(organization runtime pool maxima, including old/new overlap) + jobs + migrations +
backups/restores + operator reserve <= measured usable server capacity`.

Current default is 10 connections per app, not per unit. As a measurement hypothesis,
two organization processes capped at three each consume at most six application connections
before operational overhead; this is not tested sizing. More units increase load
within an organization and may need more capacity, without creating automatic extra pools.
Expose a bounded pool setting, reserve emergency connections, limit job concurrency,
and measure pool waits, report/upload latency, CPU, memory, disk and WAL growth.
Rolling overlap can double an affected organization's pools. Increasing connection limits
uses server resources; see [PostgreSQL connection settings](https://www.postgresql.org/docs/18/runtime-config-connection.html).
Introduce a pooler only after transaction-scoped organization/unit authorization is verified.

## Repeatable provisioning and unit onboarding

Implement a manifest-driven **organization provisioner** with states planned, allocated,
migrated, configured, verified, activated and failed. Journal step postconditions,
resource IDs, timestamps, artifact/config hashes and redacted failures atomically.
The organization admin panel must not receive PostgreSQL superuser credentials.

1. **Dry run:** read-only validation of identifiers, existing resource ownership,
   port/origin uniqueness, directory containment, artifact completeness, migration
   checksums, storage namespace, key references and capacity. Show actions/conflicts;
   do not rotate credentials, create folders/databases, probe provider writes or
   alter routing.
2. **Allocate:** lock the organization operation and reserve host/port atomically. Generate
   secrets once and store securely before dependent changes. Create distinct roles,
   database and storage namespace; journal resource IDs. CREATE DATABASE is its own
   resumable step, not part of one cross-resource transaction.
3. **Migrate:** assert database identity and hold a per-database advisory lock on the
   same connection through history inspection, migrations and final grants. Set
   reviewed maintenance timeouts; the runtime's request timeout is not this policy.
   Verify schema, ownership, grants and RLS postconditions.
4. **Configure:** create one expected organization, first administrator and initial units
   with type, organization defaults, allowed override definitions and unit-scoped grants.
   Use secure credential handoff/change, no development users. Configure organization
   storage, seal integration credentials and perform a synthetic scoped probe.
5. **Verify privately:** start the pinned artifact with explicit organization config; check
   readiness, sign-in, organization/unit permission boundaries, admin sections and synthetic
   storage. Keep routing disabled until acceptance succeeds.
6. **Activate:** publish the organization host routing, verify TLS/cookies and manifest
   acknowledgement; enable backup scheduling and demonstrate isolated restore before
   accepting real records.

Retry reconciles the journal with actual identity/ownership and resumes only missing
steps. It must not rotate existing credentials, duplicate organization/admin/units,
overwrite operator settings, take another organization's ports, or adopt an unrelated
matching-name database. Recover crashes between resource creation and journal
write by checking ownership/operation IDs; ambiguous resources require review.
A failed organization stays unrouted. Cleanup is a separate operation restricted to
resources proven to belong to that run, never an automatic drop of an existing DB.

**Adding a unit is a different workflow inside the existing organization:** preview its
type/settings/permissions; transactionally create its identity and allowed overrides;
assign forms/features; verify scoped access and metrics. No database, runtime,
credentials, migration or DNS entry is created. Use idempotency and optimistic
version checks for retries. Deactivate rather than silently deleting historical
unit provenance. A unit's configuration cannot bypass organization-enforced rules.

Organization defaults and unit overrides live in this same database. Validate the allowed
fields and locks on the server, version changes, audit actor/affected units, support
preview/effective dates and invalidate caches after commit. Unit forms reference
organization-managed immutable published versions and assignments. Changes must preserve
historical submissions/price/template snapshots. These are local data/config
operations, not distributed per-clinic deliveries.

## Releases, canary and recovery decisions

Build dependencies and application artifact once. Record desired/observed artifact,
schema and configuration versions per organization. All units of an organization share its app and
schema release. A selected unit can trial a feature or form assignment only when
the already-deployed schema supports it; this is not an independent schema canary.

For a product release across organizations:

1. Record target organizations, digest, checksums, compatibility ranges, maintenance window,
   stop thresholds, responder and recovery decision. Rehearse on isolated restored
   organization data with multiple units and representative permission scopes.
2. Check capacity and a verified recoverable backup. Take a fresh coherent checkpoint
   where migration risk requires it; coordinate conflicting storage moves/jobs.
   Acquire a per-organization deployment lock and database migration lock.
3. Select one agreed canary **organization**. Drain requests/jobs, and block writes when
   compatibility requires maintenance. Apply migrations via a separate task, then
   switch the organization runtime. All units of that organization are in the canary blast radius.
4. Verify organization identity, schema, auth, admin panel, authorized unit switching,
   cross-unit customer handling, unit/organization metrics, assigned forms, document access
   and representative finance flows. Use synthetic writes in rehearsal; production
   checks must not fabricate patient/financial history.
5. Observe for the agreed interval and record acceptance before bounded batches of
   other organizations. Halt remaining organizations on migration/readiness/security failures or
   agreed error thresholds. Unaffected organizations remain on their compatible versions.

Use expand/contract where useful: additive schema, compatible application, resumable
backfill, then separately reviewed removal. Never edit applied files/checksums.
The current migrator commits each file independently; after failure inspect history
and grants state rather than assuming the entire release rolled back. Serialize
migrations on each organization DB even if updates to different organizations later run concurrently.

Roll back an app only when the old artifact supports the resulting schema/config.
Prefer a reviewed forward fix when compatible. Destructive recovery restores a
whole organization to a new target, reconciles post-backup activity and requires an explicit
switch. Do not independently rewind a unit's schema/data in a shared organization DB:
customers, references and configuration span units. A unit-level data correction
requires a separately designed business repair/import with reconciliation.
Publish a new compatible configuration/form assignment version for reversal;
do not rewrite historical submissions. Report app/schema failure at organization level
and feature/form/config activation status at the affected unit level.

## Backup set and consistency

The handover's proposed baseline is daily encrypted off-host sets, 14 daily and
12 monthly retained copies, plus monthly restore drills. Apply retention per organization
and obtain owner-approved recovery point objective (maximum lost work), recovery
time objective (time until usable records) and named responders. Daily dumps alone
can lose roughly a day; stricter targets need designed WAL/PITR and document-version
recovery. Laptop sleep, updates and disk failure are not an availability strategy.

Back up one complete organization, including every unit and shared customer:

- Database schema/data, identities, relationships, sequences, migrations, functions,
  policies, ownership and grants; capture versions and snapshot time.
- All referenced documents from every active and historical backend, including form
  photos/signatures; maintain protected mappings of keys/provider IDs, sizes,
  checksums and provider versions where available. Documents remain under the organization
  boundary with unit access authorization, even where separate prefixes help organize.
- Matching artifact, non-secret deployment/config manifests, unit definitions,
  permitted overrides, form versions/assignments and role/grant reconstruction data.
  Database dumps do not include cluster roles; protect any role exports as sensitive.
- Separately escrowed versioned sealing keys, backup decryption keys and integration
  recovery procedures. Backup manifests contain references, not plaintext keys.

A custom-format database archive should have verified exit status/warnings, inventory,
encrypted-object checksum and a completion marker. A successful upload alone is not
proof of recovery. Current app/owner credentials cannot be assumed to export all
forced-RLS rows. Use a controlled non-runtime backup identity with reviewed read
privileges and necessary RLS bypass; restrict and audit its reach. BYPASSRLS alone
does not grant table reads. Do not enable row-security filtering to obtain a seemingly
successful partial dump. See [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
and [PostgreSQL row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).

Database snapshots do not automatically synchronize external documents. For the
first reliable procedure, pause writes for the whole organization, drain uploads/jobs and
storage moves, then capture DB and referenced documents while stable. A later online
protocol can use immutable/versioned objects and a snapshot reference inventory
with retention protecting those references; implement and prove that protocol before
claiming online consistency. Include documents referenced by shared customers and
unit-specific events without duplication or omission.

Keep encrypted copies off-host and protect against deletion by compromised runtime
credentials through independent backup access/offline or immutable retention where
available. Live storage and backups in the same provider account share a failure
boundary. Personal Drive OAuth versus Workspace Shared Drive/service account still
needs the owner's decision and actual provider verification. Encrypt before upload;
test expired/revoked provider credentials. Retention cleanup must preserve newer
verified recovery coverage and unresolved-incident requirements.

Keys belong in a controlled password manager plus the separately held offline copy,
not beside the ciphertext. Retain old keys until retained backups expire or are
re-encrypted and verified. Current sealed payloads have no key IDs: safe rotation
needs versioned keys, atomic resealing and cache/restart validation; changing only
`KB_SECRETS_KEY` breaks old credentials. Alert on stale/partial backups, missing keys,
capacity problems and failed drills. Record each organization's last verified restore,
not merely its last upload.

On shared PostgreSQL, physical PITR recovers a cluster, not an independent organization DB.
Recover into an isolated cluster, then extract/recover the affected organization; do not
rewind other organizations in place. A restore of one organization includes all its units.

## Verified isolated restore and incident switch

Monthly and before risky schema changes, restore an organization backup into a new isolated
database and document namespace, preferably on a disposable host/cluster. Never
restore over real organizations, `kb_pms`, rehearsal DBs or shared `kb_pms_test`.

1. Verify encrypted backup integrity, manifest completeness, compatible tool versions
   and availability of required historical keys. Rebuild only required roles/grants
   through reviewed definitions, not blind cluster-wide password/role import.
2. Restore all schema/data under a controlled restore identity. Check every error,
   ownership remapping, function owner and migration checksum.
3. Restore all referenced objects and map changed provider IDs if necessary. Point
   every adapter at isolated copies; block live integration writes/notifications at
   the network boundary. Restored sealed credentials must not contact live buckets
   or Drive. Functional probes use isolated provider credentials.
4. Reconcile organization-wide and per-unit counts/totals, shared customer identities and
   relationships, sequences, timestamps, form assignments/submissions and referenced
   document checksums with the protected snapshot inventory. Missing/unreadable
   objects fail the drill. Publish redacted outcomes only.
5. Verify RLS enabled/forced flags, policies, runtime attributes, grants and function
   ownership against the approved organization/unit inventory, including intentional session
   exceptions. Prove no-context access fails closed and pooled requests do not retain
   another actor's scope. A role cannot CONNECT to the other organization or assume its roles.
6. Start the matching release with the restored organization pin. Test fresh sign-in,
   authorized unit switching, scoped cross-unit customer handling, unit/organization metrics,
   selected-unit form assignments and document access. Synthetic fixtures prove
   forbidden cross-unit and cross-organization operations are refused. Verify allowed shared
   customer workflows without creating duplicate patients per unit.
7. Revoke restored sessions and replace drill credentials before any real switch.
   Record backup age, duration, measured lost-work window, reconciliation and failures;
   demonstrate owner-approved recovery targets rather than assuming them.

For an incident, fence writes and routing to the failed organization, preserve evidence,
and restore to a new target. Reconcile post-backup work across all units with the
owner. Switch database, document namespace and runtime/routing coherently, keeping
the old organization target fenced against writes. Verify business flows before reopening.
Other organizations stay routed to their original targets. Losing sealed integration keys
may require provider reauthorization; it cannot recover absent document bytes or a
lost backup decryption key.

## Later production path: Linux / Compose

After choosing hosting, build one pinned image with all required app/assets/migrations.
Use a separately named Compose project per **organization**, one common reviewed reverse
proxy and distinct secrets/volumes/networks. There is no container per operating
unit in the MVP. Project names help separate resources ([Docker documentation](https://docs.docker.com/compose/how-tos/project-name/));
they do not replace database grants, provider boundaries or host security.

Run as non-root, keep release files read-only and explicitly mount required writable
storage/temp areas. Runtime never mounts migration/backup/admin credentials. Publish
only HTTPS via the proxy; keep app and database ports private, validate allowed
hosts, manage certificates and trust forwarding headers only from the actual proxy
network. Current loopback-only Fastify trust requires review for container networking.

Choose shared PostgreSQL with distinct organization DBs/roles or separate PostgreSQL services
per organization based on isolation/cost/capacity. Shared server failure affects its organizations;
separate services add memory, backup and patching cost. Either way, backups leave
the host and include documents, not just container metadata. Verify reboot recovery,
certificate renewal, disk/connection alarms, log rotation and restore duration.
Assign host/PostgreSQL patching separately from app release responsibility.

Production requires a named primary/backup responder, controlled emergency access,
accepted recovery targets, maintenance windows and tested alert delivery. These are
requirements, not installed services or verified scripts. Host choice, budget,
provider account type and operational ownership remain open decisions.

## Implementation sequence and acceptance gates

Implement in this order: settle organization/customer/unit permission contracts; refactor
schema/auth/storage and artifact/config boundaries; add organization grants/pool settings;
prove two organizations with multiple units; implement resumable organization provisioning and
transactional unit onboarding; prove coherent backup/restore; add staged releases;
then package production services/Compose for the selected host. Code can be replaced
where simpler; migration/reset decisions must be explicit and protect needed data.

All gates below are future work. Tests were not run for this document. Coordinate
existing suites and run them serially because the shared test database is rebuilt.
Infrastructure proofs use explicitly isolated fictional databases, never real organizations
or the shared test/rehearsal targets.

| Gate | Concrete acceptance criteria |
| --- | --- |
| Two-organization boundary | A and B run the same artifact with different DB/logins/origins/keys/storage; wrong DB/organization/schema fails startup; A cannot connect to B DB, use B cookie/token, read B files or assume B roles; unknown Host refused; B remains usable while A is stopped |
| Multiple unit types | Each organization has a clinic and lab; adding a unit creates no DB/process/port/DNS resource; admin sees accurate sections/type/metrics; all units share organization schema release |
| Shared customer with scopes | Authorized user accesses the same organization customer from two permitted units with preserved event provenance; restricted user cannot retrieve forbidden records via search/export/document/metrics/form endpoints; B never sees A customer; pooled reuse cannot retain prior actor scope |
| Organization defaults and forms | Allowed unit override accepted, locked/unknown override rejected server-side; direct API bypass fails; organization-created form assigned to A1 cannot be filled at unassigned A2; versioned historical submissions remain intact; per-unit feature activation needs no migration |
| Provisioning | Dry run mutates nothing; repeat apply is no-op; failure after each step resumes without password rotation/duplicate resources; concurrent same-organization run serialized; unrelated matching-name resources refused; unit onboarding retries are idempotent |
| Grants/migrations | Migrators serialize per organization; checksum edits refused; failure preserves accurate history/journal; grants stage safely retries; runtime remains non-owner/NOBYPASSRLS; auth helpers, audit/receipt restrictions and organization/unit policies verified |
| App/config packaging | Clean packaged artifact serves required screens/assets; explicit runtime config contains no owner secrets; organization pin covers every retained login/session/background path; version and compatibility status accurate |
| Canary | Organization A upgrade covers A1/A2; failure halts organization B rollout; B continues on compatible release; incompatible rollback refused; per-unit feature rollback preserves shared schema and history |
| Backup/restore | Whole organization restored with shared customers and all units/documents/keys/config/forms; forced-RLS completeness reconciled; missing key/object/partial dump visibly fails; drill cannot contact live integrations; other organization unchanged; measured recovery meets accepted targets |
| Production | Service restart/reboot, TLS/host/proxy controls, ACLs, capacity headroom, provider failure, alerts and responder access verified; off-host recovery and key rotation rehearsed |
