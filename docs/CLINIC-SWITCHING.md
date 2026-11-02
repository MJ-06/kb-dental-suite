# Clinic switching and Organization in Master

3 November 2026. Implemented on saas/multi-clinic. Existing clinical layout retained;
UI redesign remains deferred. Organization uses the existing Master password.

## Try it locally

Open http://127.0.0.1:8080 and use your existing kbdev development account.
The bottom-left Clinic selector lists explicitly granted clinics. Select a clinic,
review the destination and save-work warning, then click Switch clinic. Stay cancels.
The page reloads, closing patient tabs/drafts and reloading clinic-scoped data.

Master > Organization > Organization Details edits organization name, legal name,
address, phone, email and website. These details are shared by linked clinics.
Clinic-specific setup remains under CLINIC. This screen does not edit database
credentials, hostname, storage secrets or immutable organization identity.

The same Master password opens this tab. There is no second password. Setting or
changing Master from a linked clinic changes the shared organization Master password.
The backend additionally checks an explicit organization-management grant and both
masters:write and roles:manage permissions. A verified Master unlock lasts15 minutes,
is bound to the session, is cleared by a clinic switch/logout, and is invalidated
by a Master password change. An unset Master password retains the existing behavior:
authorized administrators can open Master; no password was invented or changed here.

## Existing/fresh laptop commands

Run from api/ after the usual bootstrap/seed on a fresh installation:

```powershell
npm run db:migrate
node --import tsx scripts/link-local-clinics.ts
node --import tsx scripts/link-local-clinics.ts --apply
npm run dev
```

The helper is opt-in and limited to the seeded kb_pms/kbdev development installation.
It creates KB Local Organization and KB Dental East (synthetic demo), links both
clinic units, and grants existing development administrators access to both.
Existing clinic login credentials are retained. Other staff keep only their own
clinic unless the operator explicitly grants more access. No patient data is copied,
imported, deleted or re-attributed. Re-running the helper is idempotent; it refuses
another organization or unrelated pre-existing target account. Never use it to
onboard production organizations. The independent Org A/B demos remain separate.

## Backend and safety behavior

- Additive migration0024 bridges existing clinics to org_identity/org_units. Links
  and grants are owner-managed; kb_app cannot create its own grants or read them raw.
- The original authenticated account remains the session principal. An explicit
  grant maps it to a clinic-local account; the current role permissions, active
  account and active clinic are checked on every request. This is a transition
  bridge for the preserved schema, not a new independent organization registry.
- Session requests serialize against switching. Each rendered page and embedded
  form pins its requests to clinic ID plus context revision. An old browser tab
  cannot write into a newly selected clinic; it receives a reload-required error.
  REST consumers can discover the current context at /api/v1/auth/me and must send
  X-KB-Clinic and X-KB-Clinic-Revision for organization-linked clinical requests.
- A full reload clears in-memory masters/forms/patient tabs. Top-level browser keys
  and embedded mini-app storage are namespaced per clinic. Old stored values are
  retained rather than deleted or silently adopted by another clinic.
- Switching and organization-profile changes are audited. Saves use version checks;
  stale saves are refused. New profile/switch changes require POST. Master password
  verification/change from the frontend also uses POST, keeping passwords out of URLs.

## Boundary and next work

The existing legacy patient/clinical tables remain clinic-scoped in this bridge.
It does NOT yet merge patient identity across clinics, migrate complete longitudinal
visit/treatment/material history, or apply organization profile fields to every old
print template. Existing clinic forms and printing remain as before and still need
clinic-specific print acceptance. Organization profile metadata and clinic grants
are shared; full settings inheritance and clinical schema consolidation remain next.
The new Master/list/document/report parity gaps from Viveyk's merge also remain as
tracked in LOCAL-CLINICAL-BASELINE.md. Do not describe this as the finished CRM.

## Verification

The full serialized API regression passed277 tests across22 files during this work.
The final organization integration file additionally covers concurrency, disabled
accounts and embedded storage/fetch isolation. Typecheck/build and standalone auth
and storage-key regressions pass. Browser checks verified switching both ways,
clinic-specific dashboard data, Master > Organization, saving fictional organization
details and reading the same saved details after switching back. Existing patient
records were not opened or modified. See evidence/organization-master-2026-11-03.jpg.
