# Organization and units: delivery roadmap

31 October 2026. This chat is the main coordination and product-decision chat.
Status: D01-D18 approved; first local organization/unit vertical slice implemented.
Two organization runtimes are verified through 33 HTTP/database checks; final full
suite269/269 passes. Organization A admin browser checks pass; clinical/accounts
and organization B browser sessions still need separate acceptance.
See `docs/DEMO-VERIFICATION.md` for the precise boundary of completion.

Demo scope confirmed: Organization A has two clinics; Organization B has one clinic.
Labs are future scope. All defaults in `docs/DEMO-DECISIONS.md` were explicitly
accepted; the user instructed implementation to proceed.

## Agreed vocabulary and requirements

- Organization is the tenant/account and owns its subdomain, runtime, database,
  credentials, sessions, storage and configuration. Brand is a visual identity setting.
- Units are operating entities with types such as Clinic and Lab. An organization
  may have one unit or many. A single-unit account automatically selects its unit.
- Customer/patient identity is shared within an organization. Unit access remains
  permission-scoped. Different organizations remain isolated.
- Organization defaults apply unless the organization explicitly permits an override.
- Forms are defined/versioned centrally and assigned to units; history is preserved.
- Product releases/migrations and baseline recovery operate per organization.
- This is a test product. Refactoring/replacement is permitted; preserving old code
  solely for compatibility is not required. Data and unrelated work remain protected.

## Coordination

The four specialist chats completed design/review documents; those are proposals,
not evidence of implemented or tested organization support. Their historical filenames
remain to preserve links. Organization replaces Brand in the current documents.
Use this main chat for decisions, integrated priorities and release acceptance. The
specialist chats remain available for scoped work; no need to follow all four daily.
Only one owner may run shared database tests at a time. Assign file ownership before
implementation in this shared working tree; do not start competing schema changes.

## Delivery sequence

| Step | Result | Completion gate |
| --- | --- | --- |
| 1. Reconcile design and protect work | Single domain/access/settings contract and implementation ownership; inventory existing forms work | Table classification and allowed changes are explicit; no unrelated work lost |
| 2. Organization/unit foundation | Organization identity, unit types, staff grants, session context and organization-scoped runtime/storage | Two fictional organizations cannot cross-access DB/session/documents; permitted unit switching works |
| 3. Shared customers and unit workflows | One customer can attend two clinics; work retains originating unit | Scoped access and history work without duplicate customer identity |
| 4. Defaults and form assignment | Enforced override rules, versioned forms, selected-unit assignments | Disallowed overrides fail server-side; unassignment retains old submissions |
| 5. Administration and metrics | Organization overview plus unit sections; uncomplicated single-unit experience | Totals reconcile and restricted staff cannot obtain broader data through reports/exports |
| 6. Operations and acceptance | Provisioning, staged organization releases, verified full restore, browser checks | Test organization recovery works; critical patient/financial flows pass before real cutover |

First milestone: a local demonstration of Organization A (two clinics) and
Organization B (single clinic), with isolated organization sessions/data and shared
customers only inside A. Begin with synthetic data; production import follows later.

## Product decisions to settle as the relevant step approaches

1. Unit types decided: clinics only in the demonstration; labs are future scope.
   Keep an extensible domain without implementing or promising lab workflows now.
2. Cross-unit patient history: which roles can search/view which records? Proposed
   starting point: organization admins get authorized organization-wide access;
   staff receive assigned-unit access and explicit cross-unit grants.
3. Settings ownership: which values can units override? Proposed starting point:
   local contacts/timings/resources can vary; clinical templates, access boundaries
   and mandatory organization policies remain controlled centrally.
4. Patient display IDs, receipt numbering, issuing legal entity and balance scope:
   decide before finance/import changes; preserve historical identifiers.
5. Hosting, acceptable data loss/recovery time and recovery owner: decide before
   deployment; they do not block the local organization/unit foundation.

These are product decisions, not a request to reapprove the agreed architecture.
This roadmap does not authorize destructive resets, applied-migration edits or
changes to external services. No tests or database operations ran for this update.

## Design references

- [Operating model](BRAND-CLINIC-PLAN.md)
- [Backend contracts](BRAND-ARCHITECTURE.md)
- [Operations](CLINIC-OPERATIONS-PLAN.md)
- [Readiness backlog](CLINIC-READINESS-BACKLOG.md)
- [Administration UX](BRAND-CONSOLE-SPEC.md)
