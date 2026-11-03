# Basic launch: review, transfer and commercial tiers

3 November2026. Proposed launch sequence and tier design. No pricing, paid plan
limits, billing integration or production cutover is approved/implemented by this
document. The current release remains a synthetic prototype.

## Next steps, in order

1. Complete browser acceptance of registration, search, clinic switching, diary,
   Daysheet, Care/Treatment Plans, Records, finance, documents and reporting. Check
   admin, doctor, reception and accounts roles. Use `PUBLIC-CLINICAL-DEMO.md`.
   Confirm Add Record behavior against the original forms before further redesign.
2. Agree the basic paid-product scope and tier matrix below. Keep existing entry
   workflows. Do not advertise unfinished CRM sync, item stock or unified visits.
3. Rehearse real-data import in a separate organization database. Review identity
   conflicts, rejected rows, financial totals and attachment reconciliation. Verify
   importer compatibility with migrations0024–0029; older import tools are not
   automatically organization-ready because they exist in this repository.
4. Implement server-enforced entitlements, limits and integration gates; test direct
   API access, cross-clinic scope and downgrade behavior. Manual plan assignment is
   sufficient for an initial pilot; recurring billing automation can follow.
5. Provision permanent organization hosting/subdomains and protected storage. Run
   backup/restore and isolation checks. Cloudflare Quick Tunnel is review access,
   not permanent hosting or a backup service.
6. Run a limited pilot, then freeze source writes and perform a reconciled final
   import. Record release version, rollback criteria, operator and support owner.

## Documents to review

| Priority | Document | Decision / purpose |
|---|---|---|
| First | `PATIENT-CRM-DIRECTION.md` | Patient-centred scope, shared identity and clinic care ownership |
| First | `PUBLIC-CLINICAL-DEMO.md` | Hands-on acceptance journeys, demo setup and known limits |
| First | `SCREEN-API-DATA-GUIDE.md` | Per-screen APIs, tables, file storage, links and implementation gaps |
| First | This document | Launch sequence, migration gates and proposed commercial packaging |
| Next | `FAMILIAR-UI-IMPROVEMENTS.md` | Small UI changes and Add Record review still needed |
| Next | `BACKEND-PASSIVE-LINKING-ROADMAP.md` | Backend foundations; scope only the launch-critical subset |
| Technical | `HANDOVER.md`, `ANOTHER-LAPTOP.md` | Current implementation handoff and fresh-machine setup |
| Technical | `CLINIC-READINESS-BACKLOG.md`, `CLINIC-OPERATIONS-PLAN.md` | Readiness/operations inventory; historical findings need current verification |
| Historical | `MIGRATION-DB-PLAN.md`, `migration/README.md` | Earlier migration design and tooling; not a certified organization cutover runbook |

`HANDOVER.md` is the maintained handover document, not an executable transfer
script. `NEXT-CHAT-HANDOVER.md` is a copyable instruction prompt for the next agent.
Historical sections in older docs do not override the latest user decisions.

## Transfer path A: another laptop, synthetic demo

Clone/pull `saas/multi-clinic`, install the documented Node/PostgreSQL versions and
follow `ANOTHER-LAPTOP.md` plus `PUBLIC-CLINICAL-DEMO.md`. Provision and enrich a new
synthetic database. This creates new local credentials; Git does not carry the
database, uploads or secrets. For the latest familiar two-clinic prototype use the
dedicated public-clinical scripts, not just the older development seed.

If exact saved reviewer changes must move, use path B's database/file transfer
rather than reseeding. Never run reset/bootstrap commands over a database being kept.

## Transfer path B: preserve an existing PostgreSQL installation

Take a consistent PostgreSQL backup and a coordinated snapshot of the associated
document directory/object storage. Transfer both privately with protected runtime
configuration/keys; keep passwords out of Git and command history. Restore into a
new target database with mapped roles/ownership/grants, preserving UUIDs, UHIDs,
clinic links, counters, audit records and storage keys. Keep application writes
paused or use a coordinated snapshot so files and metadata agree. Do not transfer
live sessions as a promise that users remain signed in; revoke sessions at cutover.

Reconfigure environment paths, per-organization DB credentials, storage and hostname.
Apply migrations through the correct owner/runtime-role procedure, then validate
counts, patient histories, financial balances and attachment checksums/readability.
Test restoration before retiring the source. This is a planned transfer procedure,
not a new one-command backup/restore implementation.

## Transfer path C: old Google Sheets / Drive data

1. Inventory source sheets, versions and Drive files privately; retain untouched
   source snapshots and a manifest. Do not expose real data through the demo tunnel.
2. Build/review mapping from sheet headings to tables/JSON fields and from source
   clinic/UHID to central patient UUID plus retained aliases. Preserve provenance.
3. Dry-run import into a staging database for the target organization. Reuse/adapt
   existing tools only after testing their schema/grant compatibility. Imports need
   stable source keys and repeat-run protection; never silently merge by phone/name.
4. Review conflicting UHIDs, duplicate people, orphans, malformed dates/money and
   missing doctors/files. Unknown attribution stays unknown until resolved.
5. Reconcile source/import/rejected counts per sheet and clinic; receipt/payment
   totals and balances; clinical samples; attachment counts/checksums. No silent
   exclusions or automatic finance corrections. Record explicit sign-off.
6. Freeze the old system, capture the final export/delta, import and repeat the
   checks. Switch writes only after acceptance. Keep the old system read-only and
   retain backups. A rollback must account for new writes after cutover to avoid
   losing or duplicating care/payment records.

Production source reconciliation, final importer readiness and a restore rehearsal
remain open launch gates. Current synthetic test results do not certify real imports.

## Proposed selling model

Sell a subscription to an **organization**. Included clinic/staff/storage allowances
and paid additions are commercial decisions. A personal practice is one organization
with one clinic; a chain is one organization with several clinics. Keep the same
organization isolation boundary in every tier. Do not create a code branch per tier.

| Proposed tier | Packaging direction | Readiness caveat |
|---|---|---|
| Essential | Patient directory/history, registration, appointments/Daysheet, clinical records, Care/Treatment Plans, documents and basic finance/reporting; allowance suited to one clinic | Core browser acceptance and real-data migration still needed |
| Growth | Essential plus additional clinic capacity, organization reporting, configurable forms and selected CRM/communication connectors | Some foundations exist; external connector workflows require implementation/verification |
| Enterprise | Growth plus agreed advanced integrations, SSO, advanced analytics, service/support and storage options | Future capabilities; do not present SSO or advanced integrations as delivered |

Possible add-ons: extra clinics, staff seats, storage, messaging usage or selected
connectors. Set actual allowances/prices after scope and operating costs are known.
Keep minimum data protection, permissions, audit integrity, backup and a defined
patient-data export/offboarding route available across all tiers.

## How tiers should work technically

Use a stable feature catalogue (`organization.reports`, `forms.custom`,
`integration.crm`, `integration.messaging`, etc.), plan definitions and versioned
organization entitlements. Effective access is the intersection of **plan feature,
staff permission, clinic grant and configured/healthy integration**. A subscription
never grants a doctor finance access or broadens clinic access automatically.

The server should expose effective capabilities to build navigation and must check
the same capabilities on REST routes, `/exec`, exports, jobs and integration calls.
Hiding a tab alone is not enforcement. Maintain required clinical paths and access
to historical records when packaging modules; do not strand patients on downgrade.

Organization deployment stores its entitlement snapshot and integration secrets.
A future platform billing/control service may distribute signed/versioned plan
updates and hold organization/subscription IDs; it need not contain patient data.
For an initial pilot, controlled manual assignment avoids making billing-webhook
availability a prerequisite for clinical work. Audit every plan/override change.

Enforce clinic/seat/storage quotas transactionally at creation/upload, including
concurrent requests. Separate included usage from provider charges and explicit
overages. Define grace periods and outages: an unavailable billing service must not
silently erase access to clinical history. Expired/downgraded integrations should
stop new external jobs cleanly while preserving existing records and exports.

If recurring billing is added, verify webhook signatures, deduplicate/reconcile
events, handle out-of-order updates and never trust a browser payment-success flag
to enable features. Test upgrades, downgrades, cancelled subscriptions, quota races
and direct API bypasses. These mechanisms are proposed work, not implemented today.

## Launch acceptance record

Before a first paying clinic, record pass/fail, evidence and owner for: browser
journeys; role/clinic isolation; import reconciliation; file retrieval; restore test;
permanent deployment; tier/API enforcement; external integration tests where sold;
operating/support ownership; cutover and rollback. Set the pilot scope explicitly.
