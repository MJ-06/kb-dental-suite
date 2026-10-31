# Organization demo: integration verification

31 October 2026. First organization/unit vertical slice implemented locally on
`saas/multi-clinic`; no commits, push, hosted deployment or live import performed.

## Delivered and running

- Organization A: http://org-a.localhost:8101 with Riverside and Orchard clinics.
- Organization B: http://org-b.localhost:8102 with Meadow clinic.
- Separate databases, generated owner/runtime roles, sessions, process configuration
  and local document folders. Runtime is non-owner with no RLS bypass.
- Local app entrypoint: `api/src/organization-server.ts`. New API/domain module:
  `api/src/organization/`. Migration 0023 adds organization-scoped tables without
  rewriting applied migrations or deleting the existing clinic implementation.
- Organization workspace: `organization.html`, `organization.js`, `organization.css`.
  The organization runtime deliberately does not register unrestricted legacy routes.
- Existing forms and clinic screens remain in the working tree. The forms test
  helper was corrected to establish a forced-RLS clinic context inside a transaction.

Credentials stay in the ignored `.organization-demo-runtime/<org>/demo-logins.txt`
files under `api/`. Do not paste passwords, state JSON or connection URLs in chat.
The runbook explains startup and role fixtures. These processes are local demo
services, not installed services or production hosting.

## Actual checks

| Check | Result |
| --- | --- |
| New organization specifications before implementation | Initially failed on missing module; later concrete name/void/default regressions captured failing before fixes |
| Full API suite after final fixes | PASS: 21 files, 269 tests, serialized shared test DB run |
| TypeScript | PASS: `npx tsc --noEmit` |
| Frontend syntax | PASS: `node --check organization.js` |
| Running two-organization HTTP/database verifier | PASS: 33 checks against separate dedicated synthetic DBs |
| Source profile | PASS: aggregate/schema read-only inspection; workbook structure only; no source rows exported |
| Browser login screen | PASS: organization identity, responsive stacked display at available in-app viewport, invalid-login feedback; no initial console errors |
| Authenticated organization A admin browser workflows | PASS: navigation/clinic selection, metrics scope, forms creation/versioning/assignment dialog, staff scopes, inherited settings/override/reset and audit display |
| Authenticated clinical/accounts and organization B browser workflows | PENDING separate role sessions; their APIs remain covered by the tests above |
| Fixed desktop/mobile viewport matrix | PENDING: browser viewport override did not change the observed in-app viewport; no 390px/1366px claim |
| Production provider, backup/restore, live migration | NOT RUN / outside this local demo |

The 33 live checks include hostname pinning, anonymous rejection, no legacy bypass,
host-only HttpOnly session, A token denied at B, shared identity between A clinics,
A patient unavailable at B, single-clinic history denial, administrative/clinical
separation, note creation, organization metrics, locked override denial, and runtime
database credential denial from A to B and B to A. They also check distinct document
roots. Full file-access and document checksum/permission cases are in the unit suite.

Concrete regressions fixed: literal name confirmation cannot be bypassed with SQL
wildcards; concurrent payment/receipt void cannot create a prohibited negative clinic
balance; organization defaults are versioned/editable only with organization access,
while clinic overrides/reset preserve inheritance; forms assertions now exercise
actual RLS-visible fixture rows rather than silently matching no rows.

## Demo walk-through

1. Sign in as `admin` to view clinic totals, staff grants, forms/assignments and
   organization defaults versus clinic overrides. Admin has no clinical grant.
2. Sign in as `doctor`, search synthetic `DEMO-A-001`, and switch A1/A2 to see
   different histories for the same patient. `doctor-one` demonstrates restricted scope.
3. Use reception for registration/appointments and accounts for A1 receipts/balance.
   The first fictional patient's seeded A1 balance is INR 400; A2 balance is zero.
4. Sign in at Organization B to see single-clinic auto-selection and isolation.

## Authenticated admin browser follow-up

The user signed into the in-app browser as admin. Browser assertions first exposed
two defects not caught by backend tests: passing node arrays directly to
replaceChildren rendered object text instead of navigation buttons/clinic options;
setting readonly="false" still made a new form key read-only. Both failures were
captured before fixes, corrected in organization.js, and retested in the same session.
Five admin navigation buttons and two real clinic options now render correctly.
New form keys are editable; existing-version keys remain read-only.

Verified in the browser:
- Organization totals show INR2000 = Riverside1100 + Orchard900.
- Working-clinic reporting shows only Riverside's row/INR1100; organization scope
  restores both rows and INR2000.
- Saving a synthetic Riverside contact override shows Clinic override and Reset;
  Orchard still inherits Organization contact. Reset restores Riverside inheritance.
  The temporary override was removed normally through the UI.
- Organization defaults editor and protected values render; staff memberships show
  one-clinic and two-clinic users without admin clinical navigation.
- A new synthetic follow-up form was published for Riverside, then version2 was
  published with the stable key locked. Assignment dialog reflects Riverside only.
- Audit displays the setting override/reset and form publications with the admin author.
- Browser console had no warnings/errors at the final check. JS syntax check passes.

Synthetic evidence: [overview](demo-evidence/organization-overview.jpg),
[saved override](demo-evidence/clinic-override.jpg),
[published form](demo-evidence/published-form.jpg).
The new layout is a demo workspace for organization/unit behavior. The original
clinic screens remain intact; this does not commit the product to replacing all
existing clinical screens or reducing their functionality.

This is an implemented local demonstration, not completion of the entire legacy
PMS replacement. The source-profile and screen-inventory documents describe what
was reused as reference and what was built anew. Authenticated visual acceptance
for clinical/accounts roles and organization B remains a later check in the main chat.
