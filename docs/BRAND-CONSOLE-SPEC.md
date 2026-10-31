# Organization admin console specification

> Current demo scope: Organization A has two clinics; Organization B has one.
> Labs are future scope. Any lab workflow/scenario below is future design, not a
> demo requirement. D01-D18 in [DEMO-DECISIONS.md](DEMO-DECISIONS.md) are approved.
> See [DEMO-VERIFICATION.md](DEMO-VERIFICATION.md) for current implementation/test status.


Date: 31 October 2026. Status: revised proposed product contract; no implementation
or live integration. The user's corrected model supersedes the earlier per-clinic
instance design: **one runtime deployment and database per organization**, containing
multiple operating units (`type=clinic|lab`, extensible to future types). Organization is
the isolation boundary for credentials, sessions, storage, subdomain and runtime
configuration. Units share organization defaults and an organization-wide customer/patient identity.

The console is the organization admin panel within that organization's application. It has
per-unit sections and permission-scoped cross-unit workflows. Units are business
locations/functions, not OS processes. There is no separate clinic database router,
report federation or distributed configuration fan-out in MVP. Software releases,
schema migrations, canaries, backup and restore operate per organization. Forms, settings
and feature activation may target units without independent schema releases.

Read [the operating model](BRAND-CLINIC-PLAN.md) and [handover](HANDOVER.md) alongside
this document.

## Existing evidence versus proposed behavior

These are source observations, not results of a new test run. Existing clinic
structures do not yet establish the corrected organization/unit model.

| Source | Observed behavior and design implication |
| --- | --- |
| `api/src/server.ts` | One pool from `DATABASE_URL`; suitable starting shape for an organization deployment, but organization identity pinning is not established by this file. |
| `api/migrations/0001_foundation.sql` | Clinic registry, timezone, `clinic_today()`, forced tenant RLS and audit housekeeping exist; `database_url` is a placeholder. These clinic concepts require deliberate refactoring into organization isolation and unit scoping. |
| `api/src/http/context.ts` | Session-derived clinic and named permission checks inside a transaction. New checks must handle organization membership, unit scopes and cross-unit purpose. |
| `api/src/auth/permissions.ts` | Editable clinic roles, seeded templates and permission names exist. No organization/unit grant model or persistent inheritance is established. |
| `api/migrations/0004_masters.sql` | Local versioned JSON settings exist; no organization-default/allowed-override/lock contract. |
| `api/src/routes/admin-reports.ts`, `api/src/reports/reports.ts` | Clinic reports use permission checks, local dates and April-to-March financial years. Some return patient details; summary permissions must not expose those rows. |
| `api/src/routes/storage.ts` | Sealed credentials, credential-present status and storage checks exist; these checks do not verify backups or restores. |
| `docs/HANDOVER.md` | Backup/restore tooling remains a gap; uncommitted forms and phone-session work belongs to another workstream. |

Everything below is proposed. Capability labels are product requirements, not
claims about existing permission constants. The test product may be refactored or
replaced; preserving legacy screens/adapters is not a requirement by itself.
Applied migrations remain unchanged unless a later explicit reset plan authorizes
otherwise. This document changes no code or existing work.

## Navigation, unit switcher and sessions

Navigation: Overview, Units, Customers, Forms & catalogues, Shared settings,
People & access, Maintenance, Activity. Customer and money sections appear only
with their own grants. The persistent header shows organization, environment, signed-in
identity, and scope: **Organization overview** or **Unit A — Clinic**. Unit screens show
name, code and type; labs use suitable workflow labels instead of clinic-only terms.

The switcher lists only authorized units with search and keyboard support. Organization
overview is available only for the actor's permitted summary scope. Switching
units does not sign out or exchange credentials: one organization session serves that
organization's application. It changes the active work context and never expands access.
Each server request validates an explicit unit target against the session's organization
and grants. A URL/body unit identifier cannot select a different organization or bypass
a unit check. Cross-unit actions name every involved unit and validate all scopes.

Clear previous-unit data before loading a new context and ignore delayed responses
for old context IDs. Drafts retain their originating unit; switching with unsaved
work offers Save draft / Discard / Stay. Readonly and write scopes are separate.
A deep link without access shows denied; it does not choose another unit. Organization
and unit are text labels as well as colour. Loading, empty, denied and failed
states remain distinct on desktop, tablets and narrow screens.

Organization A and Organization B use separate host-scoped sessions and resources. A token from
A never authenticates to B, even for the same email address. Switching organizations in
MVP means opening that organization's subdomain and signing in there; cross-organization SSO is
later scope. Avoid parent-domain session cookies and client-selected DB routing.

## Capabilities and access workflows

Authorize by capability, organization membership and explicit unit set; never role name.
All-unit grants are explicit and state whether they include newly created units.
Default new-unit access is none. Grant management cannot exceed the actor's
explicit delegable authority. Recheck at request, queued-job execution and export
download; revoke access on the next request and clear affected cached views.

| Capability bundle | Intended actions | Separate grant still required |
| --- | --- | --- |
| Organization access administrator | Manage memberships, unit scopes and delegable capabilities | Patient details, clinical history and finance |
| Organization configuration manager | Publish defaults, locks, forms and unit assignments | Clinical records, financial summaries and maintenance execution |
| Unit manager | Manage allowed local setup and unit workflows | Other units and locked organization policy |
| Summary viewer | Operational metrics for granted units | Financial-summary access, detailed records and exports |
| Customer registrar/coordinator | Search minimal organization identity and attach existing customers to permitted units | Clinical/financial history outside authorized units |
| Clinical or financial user | Perform specifically granted work in permitted units | Other units, access administration and platform operations |
| Platform operator | Sanitized organization deployment, backup and release health; separately authorized jobs | Patient/financial data, impersonation and backup-content browsing |

An owner can be assigned multiple bundles, but the title alone confers none.
Access review shows user, capability, unit scope, expiry, grantor and last change.
Changes record reason and before/after values. Role templates never silently
reassign staff or remove the last access administrator. An operator view contains
safe status/error IDs, not connection strings, keys, patient payloads or backup
URLs. Infrastructure privileges require their own controlled operational process;
the console must not imply that operators cannot technically access an administered
host merely because its UI hides records.

## Workflow: shared customer identity and cross-unit handling

An organization owns one customer identity with an immutable ID; unit encounters, lab jobs,
appointments, documents, charges and receipts retain their owning unit and history.
The same customer may attend a clinic and a lab without duplicate registration.
References across units use the shared customer ID and owning unit ID. Human-facing
number formats are a separate product choice; do not use a typed UHID alone as a
cross-organization or cross-unit authorization key.

1. From an authorized unit, a registrar searches a minimal organization identity directory
   using an explicit identity-lookup capability. Return only the approved matching
   fields needed to identify the person; exclude unrelated clinical and money data.
   Users without that capability can search their permitted unit associations only.
2. If a match exists, link the existing customer to the current unit under an
   association permission. Show that this preserves one organization identity. Creation
   with a possible duplicate requires review; no automatic merge by name/phone.
3. Opening the customer shows identity fields the actor may read and unit sections
   the actor may access. A unit association never grants access to other units'
   records. Organization-wide identity editing requires a separate permission because a
   correction affects every associated unit. Audit the change with provenance.
4. A cross-unit referral/lab request explicitly names source, destination and the
   information to share. Authorize creation, receiving access and the approved
   handoff payload; record purpose, actor and time. Destination staff see only
   information permitted by that workflow and their grants. Missing grant blocks
   the handoff, with no silent copy of the full clinical chart.
5. Financial work remains attributed to its unit. Organization-wide identity does not
   imply a pooled balance, cross-unit receipt allocation or combined collection
   authority. MVP shows authorized unit balances separately; settlement/transfers
   require a later explicit accounting contract.

Basic shared identity and scoped cross-unit handling are MVP, not a later patient
sharing feature. Later work includes advanced duplicate merge/unmerge, expanded
consent-sensitive sharing, inter-unit settlement and cross-organization identity exchange.
A merge design must preserve every original reference, audit and record ownership.

## Workflow: review organization and unit performance

The organization overview queries authorized unit data in the same organization database. It
does not call a fleet of clinic APIs. Prefer a consistent database snapshot for
all cards; if a summary projection is used, expose its watermark and rebuild state.
Each metric response carries definition version, permitted unit set, date window,
unit timezone/currency, generated-at and data-through. Cache keys include organization,
permission scope, units, dates and definition version.

Choose unit subset (and optionally type), Today, This month, Financial year or a
bounded Custom range. Freeze dates at request start. MVP FY is April 1 to March 31;
show exact dates. Use unit-local business dates and timezone-aware midnight
boundaries for timestamps. Show each unit's resolved window. Mixed local dates
must not produce a combined Today total; offer a common explicit calendar range.
Label common-date totals **Unit-local business days**, not simultaneous UTC time.
Organization reporting timezone defines default period selection, not record attribution.

Initial metrics: new organization customers, new unit associations, recorded visits,
appointments by status, lab jobs by status, collections and expenses. Display
metrics applicable to each type; N/A differs from zero. Count unique organization customers
by shared customer ID across the authorized selection; do not sum unit unique
customer counts. Define whether a customer metric counts registration, attendance
or association. Financial cards require a separate summary grant. Metric definitions
must specify cancellations/refunds and expense inclusion and reconcile to owning
unit evidence. Rates aggregate numerators/denominators rather than percentages.
Do not infer doctor revenue from receipts without reliable attribution.

Require explicit ISO currency codes. Group money by currency using decimal/minor
units; no automatic FX in MVP. Missing currency excludes that unit's money while
counts can remain available. Unlike metric versions or periods cannot be summed.

Freshness proposal: five minutes for cached summaries. Show Fresh, Stale, Rebuilding,
Failed and No data yet, plus period In progress where applicable. A failed/stale
metric is not zero. With two missing contributors, display **Partial — 3 of 5
selected units**, identify missing permitted units, and exclude stale values from
the current subtotal; cached historical values may be displayed separately. A
organization DB/application outage is an organization-wide failure, not several offline unit
instances. Unit closure is a business state, not a failed runtime. Corrections
must refresh derived metrics and expose their updated data-through time.

Summary exports require an export grant and retain filters, definitions, coverage,
currency groups and freshness. Detailed customer exports require additional grants
and must not be reachable by changing a summary-export parameter.

## Workflow: defaults, locks, overrides and publishing

Resolve product defaults -> published organization policy -> permitted unit overrides.
Organization policy explicitly defines which fields are overridable and allowed bounds.
A lock remains enforced at the API and background-job layers, including alternate
write paths; hiding an input is insufficient. Unit type can constrain applicability.

| Setting family | Proposed ownership |
| --- | --- |
| Organization name/theme/logo/standard layout | Organization-controlled; selected layout fields may allow unit overrides |
| Unit address, contacts, doctors, chairs, lab resources, hours | Unit values subject to organization-defined required fields and bounds |
| Forms, medicine/service catalogues, fees | Organization versions and allowed local additions/overrides with effective dates |
| Access/security rules | Organization-enforced limits; unit delegation only within explicit policy |
| Timezone, currency, legal receipt identity and numbering | Controlled unit setup with impact review, excluded from routine bulk edits |
| Integrations/storage | Organization-isolated resources/credentials; unit namespaces and permitted non-secret options inside the organization boundary |

The effective-settings table shows product default, organization version/value, local
value, effective value/source, lock/bounds, actor and effective time. **Use organization
default** removes an override; it differs from an explicit empty value.

1. Draft against a known revision with a reason. Saving changes no effective data.
2. Validate typed values, type applicability, permission and schema support. Preview
   each target unit's before/after effective values, preserved overrides, new locks
   and conflicts. Show affected unit count and environment before publication.
3. A new lock conflicting with an override requires an explicit authorized decision:
   replace the override with reviewed impact, revise the draft, or exclude the unit
   where policy permits. Mandatory organization rules cannot be bypassed by an exclusion.
4. Publish an immutable revision and target assignments in one organization transaction,
   protected by optimistic versions. Reject stale previews if any relevant policy
   or unit override changed. Never silently overwrite a concurrent unit edit.
5. Activate immediately or schedule one explicit UTC instant, displayed in organization
   and unit timezones. Validate again at activation. MVP atomically activates the
   selected valid policy/assignments inside the shared DB; no per-unit delivery or
   acknowledgement protocol is needed. Invalid required targets block the activation.
6. Show Draft, Scheduled, Active, Conflict, Validation failed, Cancelled and Superseded.
   Cancelling a scheduled version prevents activation. Repeated activation commands
   are idempotent. Offline browsers refresh effective policy before the next write;
   stale policy tokens cannot authorize actions against obsolete rules.

Reverting creates a new reviewed policy revision; it cannot rewrite historical
records. Keep allowed overrides visible as **Expected override**. Unexpected drift
means an effective value/hash inconsistent with its stored policy and override
revision, stale application caches or unsupported configuration; it is not an
independent unit release mismatch. Every write path uses the same resolution rules.

## Workflow: organization-created forms and catalogues

Organization authors create forms and choose explicit unit assignments/type filters.
Preview the resolved unit list. New units are not automatically assigned unless a
reviewed assignment rule explicitly includes future units of that type. Unit
managers can use assigned forms and override only declared fields; an unassigned
form cannot be opened/submitted by guessed ID. Draft form preview uses fictional
content. Filling, viewing and publishing are distinct capabilities.

Stable item IDs and immutable revisions underpin templates, services and medicines.
Local additions have explicit origin; equal names do not imply equal IDs. Preview
New / Changed / Retired / Mapping required and unit applicability. Retire instead
of deleting referenced items. Entries, printouts, charges and receipts retain the
revision and labels/answers/prices required to reproduce their original meaning;
IDs alone are insufficient. New form/fee versions do not reprice prior charges or
reinterpret completed clinical answers.

Pin open form drafts to their starting revision. Complete only supported revisions;
a safety withdrawal blocks submission and requires reviewed replacement without
silent answer transformation. Copy-forward creates a new entry with current rules.
Feature activation for a lab or selected clinics changes configuration/authorization,
not schema version. The organization deployment must support all activated unit features.

## Maintenance, health and release workflow

Organization Maintenance shows observed/expected release and artifact hash, organization schema
version, effective config revision/cache health, storage checks, last heartbeat,
backup coverage and restore-drill evidence. A unit page may show business setup or
feature status, never pretend its schema/runtime releases independently. Platform
operators see sanitized health in a separate capability context; financial and
clinical access remain separately granted even within the organization admin panel.

For multiple organizations, an operator-only fleet view may expose sanitized deployment
metadata. It is not a cross-organization patient/financial console and is not required for
the organization admin MVP. Release workflow: pinned artifact -> organization preflight/maintenance
window -> verified backup prerequisite -> canary organization -> health/business smoke
review -> remaining organizations in waves. Migration failure pauses subsequent organizations.
Track durable job IDs, actor, reason, timing, compatibility and recovery instructions.
All units in an organization use its deployed schema. Per-unit feature flags do not provide
migration isolation. App rollback requires schema compatibility; otherwise use a
reviewed restore/forward-fix process. No arbitrary shell/SQL or restore-to-live
button belongs in the organization owner MVP.

Backup status distinguishes attempted, completed, uploaded, retained, verified and
restored. Cover the organization DB, storage/documents, configuration and separately held
keys/roles as required by the operations plan. Show recoverable point, agreed data
loss/recovery targets, last isolated restore time/result and owner. A fresh upload
is not a verified restore. Unknown/Never run are explicit. Restore drills operate
on the whole organization in an isolated target; per-unit selective recovery requires a
separate reconciliation design because identity and references are shared.

## Implementation sequence and MVP boundary

1. Settle organization/unit identifiers, type extensibility, ownership of every record,
   shared identity fields, grant scopes and policy resolution. Map current clinic
   structures into the new model; choose explicit forward migrations or a separately
   authorized test reset. Do not edit applied migrations as an incidental shortcut.
2. Prove two fictional organizations with separate runtime config, DB roles/databases,
   host-scoped sessions and storage boundaries; create multiple clinics and a lab
   inside one organization. Establish organization pinning and unit authorization before UX polish.
3. Build the organization admin shell, switcher and grants; implement shared customer
   lookup/association and audited cross-unit handoff using the permission contract.
4. Add versioned policy, conflict-safe overrides, form assignments and historical
   snapshots; enforce policy across all APIs/jobs before allowing publication.
5. Add same-database scoped metrics with definition reconciliation, currency/timezone
   handling and exports; then sanitized maintenance evidence and per-organization jobs.
6. Verify backup/restore and staged per-organization release in isolation; complete browser
   acceptance on desktop/tablet/phone. Retire legacy paths only through an explicit
   implementation plan that preserves required business behavior and existing work.

MVP includes shared identity, unit-scoped workflows, organization-created assigned forms,
policy enforcement, summaries and health. Later: cross-organization SSO/identity exchange,
advanced merge/unmerge, inter-unit financial settlement, FX and richer sharing
consent rules. Cross-organization SSO must be audience-bound and revocable; one organization's
session must never become a credential accepted blindly by another.

## Acceptance tests for implementation

Use fictional Organization A and Organization B, each in a separate database/runtime/storage
boundary. A has Clinic North, Clinic South and Lab Central; B has Clinic West and
Lab West. These are future verification cases, not tests executed for this document.
Serialize database tests under AGENTS.md; do not overlap the shared test database.

| ID | Scenario and required outcome |
| --- | --- |
| AC-01 | A session, record ID, unit ID, guessed hostname or export URL from A is rejected at B; B credentials cannot open A DB/storage. Missing/wrong deployment organization identity fails closed. |
| AC-02 | A North-only user cannot obtain South/Lab records by URL, altered body, export, background job or cache. A deliberate all-unit grant works only within A; new-unit inclusion follows its explicit rule. |
| AC-03 | Switching North to South during a delayed response never renders North data under South. A North draft retains North ownership. Organization A logout/revocation does not authenticate or change B. |
| AC-04 | Register a fictional customer in North and associate the same ID in South/Lab without duplication. Identity lookup reveals only permitted matching fields; association does not reveal North clinical or financial history. B's equal name/phone is a separate identity. |
| AC-05 | A permitted clinic-to-lab handoff reveals only its approved payload to authorized receivers. Missing destination/source grants deny it; the audit identifies both units, customer ID, actor and purpose. Unit balances remain separate. |
| AC-06 | Platform operator sees deployment/backup failure but is denied patient, clinical, financial summary and detailed export endpoints. Owner title alone does not bypass capabilities. Revocation removes next-request access and cached contributions. |
| AC-07 | A permitted override survives an organization default change; clearing it restores inheritance. Locked/out-of-bounds writes fail through UI, direct API and jobs. A conflicting new lock requires explicit reviewed resolution. |
| AC-08 | Concurrent policy/override edits cause a conflict rather than lost updates. Scheduled activation revalidates, commits all selected required assignments atomically and is idempotent. No distributed unit acknowledgement is required. |
| AC-09 | Publish an organization form to North and Lab only: South cannot fetch or submit it by ID. Lab sees appropriate fields. New units follow the declared future-assignment rule; revisions preserve prior submitted answers/printouts. |
| AC-10 | Change fees, retire an item and withdraw a form: existing charges/receipts and completed records remain reproducible; new selection/submission follows current rules and supported draft revisions. |
| AC-11 | A customer attending North and South counts once in the selected organization unique-attendee metric, twice in visit/association metrics as defined. Lab N/A differs from zero. Every metric reconciles to owned records and its versioned definition. |
| AC-12 | Different unit timezones at midnight show explicit local windows; mixed-date Today is not summed. FY 2026-27 spans 2026-04-01 through 2027-03-31. Distinct currencies stay separate and decimal totals match source amounts. |
| AC-13 | Stale/rebuilding metrics show coverage and timestamps, never fabricated zero. Unauthorized units do not enter totals or leak existence. Organization DB failure produces an organization availability error. Summary exports retain coverage and exclude detailed patient fields. |
| AC-14 | A unit feature activation changes no unit schema/release. A canary organization migration failure pauses later organizations; other organizations keep their deployed versions. Restore rehearses the entire affected organization in isolation and leaves B untouched. |
| AC-15 | Successful backup upload followed by failed restore verification shows both facts; never-run evidence is Unknown. Health/errors contain no credentials or patient payloads. Shared identity dependencies block a misleading one-unit restore action. |
| AC-16 | Keyboard and narrow-screen users can select scope, inspect conflicts and publish with clear target review. Activity survives reload and identifies organization/unit scope, actor, reason and revisions without exposing unauthorized record content. |

Open decisions: exact identity lookup fields; authority for cross-unit handoffs and
identity edits; unit numbering/legal receipt rules; overridable fields and locks;
metric definitions, reporting timezone/currencies and freshness target; recovery
targets and responder. These refine the proposed defaults, not organization isolation.

Documentation validation only: source files in the evidence table were inspected;
no secrets or patient-data files were read. No tests, migrations, code changes,
deployments or commits were made. Only this assigned document was revised, preserving
other workstreams' uncommitted work.
