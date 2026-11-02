# Local clinical baseline — 3 November 2026

## Accepted scope and sequence

Following the user's discussion with Viveyk, preserve the existing clinical UI,
including navigation, patient folders, clinical forms, workflows and print layouts.
The proposed redesign in design/clinical-review-v1 is deferred to a separate phase.
The local product uses the frontend served by api/, the TypeScript/Fastify backend,
and PostgreSQL18. A separate frontend development server is not required: same-origin
serving preserves session cookies, /exec compatibility and the existing embedded forms.
Do not switch to the imported historical server/ implementation.

## Integrated baseline

Fetched both remotes and merged origin/claude/kb-dental-sheet-structure-mlfjr0 at
eac924d into saas/multi-clinic (merge ffbe37e). This is the active upstream feature
branch inferred from its latest clinical changes; upstream main was not checked out.
Resolved four page conflicts, retaining named local accounts and local backend routing.
Both KB_SERVER_URL and KB_SCRIPT_URL_OVERRIDE point at the same local /exec endpoint.
A regression test reproduced and fixed successful authStatus responses recursively
opening sign-in. A successful status carries authRequired as configuration metadata;
only a failed action may invoke the auth-failure handler.

The bottom-left Google Sheets claim is replaced by a native Clinic field populated
from whoAmI, which reads the actual signed-in database clinic. It has one disabled
option in this legacy reference runtime. This is the agreed placement, not completed
organization clinic switching. URL parameters do not grant clinic access.

## Remaining local port work

The merge is not full backend feature parity. Newly introduced literal UI calls include
getOccupationsList, getReferralSourcesList, getSafetyFlagsList and saveAppPassword.
The TypeScript adapter needs their contracts ported from apps-script/out/Code.gs,
including dynamic get/save list calls (such as patient types), safety-flag persistence,
referral renaming, schedule breaks, document password behavior and reports.
Inventory all actions in embedded mini-apps too; counting literal top-level api calls
alone cannot prove parity. Unknown local actions must explain a local port gap rather
than telling the operator to redeploy Apps Script. Preserve permissions and audits.
Existing role-controlled document access must remain server enforced.

## Next implementation stages

1. Finish the local UI/API contract inventory and port the newly merged behavior.
   Exercise registration, patient lookup, records, appointments, daysheet, Master,
   documents, CRM and finance with fictional data. Verify print layouts separately.
2. Bridge the preserved clinical screens to the organization runtime. Keep one
   database, credentials, session namespace, storage and deployment per organization;
   clinics are operating units sharing organization patient identity. Avoid adding a
   third competing tenancy model or silently relabelling legacy tenants as clinics.
3. Enable the bottom-left Clinic selector using only server-authorized clinics for
   the current organization. Validate every read/write on the backend. On a switch,
   check unsaved edits, reset clinic-specific caches and drafts, reload settings,
   doctors/chairs/forms, and preserve historical clinic/doctor attribution. Prevent
   stale in-flight responses from appearing under the new clinic context. Test
   direct forged requests and cross-organization sessions, not just dropdown options.
4. Add Master > Organization (brand details) in the existing Master design. Store
   organization display/legal name, contact details, address and branding defaults;
   maintain clinic-specific letterhead overrides separately. Organization identity,
   hostname, credentials, storage secrets and DB connection strings are provisioning
   settings, not editable text fields in a general Master screen.
   Require an organization-settings permission plus a separate organization password
   check for reading/editing protected details. Store a password hash server-side;
   do not use a JavaScript-only lock or reuse the clinic Master password. Use a
   short-lived server-side unlock tied to the user session and organization,
   rate-limited verification, explicit lock/logout/revocation, audit and optimistic
   concurrency. First password setup/recovery is an explicit administrator workflow;
   an unset password must not silently open the protected screen.
5. Demonstrate Organization A with two clinics and Organization B with one using
   fictional records. Verify shared identity inside A, restricted clinical/financial
   history, isolated B, inherited defaults/allowed overrides, and a fresh-laptop run.
6. Revisit the separate UI/UX improvement proposal only in a later agreed phase.

## Verification of this integration

- TypeScript typecheck and production build passed after the branch merge.
- Page API/security file: 6 tests passed, including local backend-address regression.
- Master adapter file: 21 tests passed. Files were run one at a time.
- Standalone auth-status regression: reproduced failure, then passed after correction.
- Browser: named local sign-in, reload without recurring sign-in, patient-search
  navigation, and actual development-clinic field verified at localhost8080.
- Local health endpoint confirms database connectivity. No real patient data imported.
- Full UI/backend parity, full API regression, print acceptance, enabled multi-clinic
  switching and protected Organization Master persistence are not yet verified/delivered.

See ANOTHER-LAPTOP.md for installation. For an existing setup, use npm ci if lockfiles
change, npm run db:migrate for pending migrations, then npm run dev from api/.
Do not re-bootstrap/reset/seed an existing database just to pull frontend changes.
