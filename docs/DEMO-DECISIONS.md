# Synthetic demonstration: product review and decision register

31 October 2026. Main coordination chat owns this review. The user explicitly
approved all D01-D18 and instructed implementation to proceed. The approved demo
uses Organization A with two clinics and Organization B with one; labs are future.
User also authorized existing data/files as reference for realistic examples: inspect
read-only and summarize patterns, then create synthetic identities and documents.
Do not export identifiable patient rows, records or original documents into fixtures.

## Confirmed

- Organization is the tenant boundary; Units are its operating entities.
- Organization A has two clinic units; Organization B has one clinic unit.
- Labs and all lab workflows are future scope, including lab acceptance scenarios
  in earlier design documents. An extensible unit model does not imply a lab MVP.
- Organizations have separate runtime configuration/subdomain, databases,
  credentials, sessions and storage. Patients can be handled across clinics inside
  an organization, with scoped access and organization-governed overrides.
- This is a synthetic local demonstration, not live-data cutover or a deployment.
- Existing implementation may be redesigned; unrelated uncommitted work and real
  data remain protected. No destructive reset is authorized by this register.

## Approved baseline: D01-D18

Every row below is approved for this synthetic demonstration. It does not settle
production legal/billing/import rules. Record subsequent changes against this baseline.

| ID | Review point | Proposed demo behavior |
| --- | --- | --- |
| D01 | Demo scope | Working browser flows for organization administration, clinic selection, patient registration/search/history, appointments, a simple clinical note, assigned form, simple receipt and reconciled metrics. No full dental specialty suite or lab workflows. |
| D02 | Roles and access | Demonstrate organization administrator, clinic administrator, doctor, reception and accounts as permission templates. Grant clinic memberships explicitly. Administration/maintenance never automatically implies permission to read clinical records. Include single-clinic and two-clinic staff fixtures. |
| D03 | Shared patient discovery | Authorized staff can search the organization's shared directory using exact UHID or phone plus name confirmation. Mask/unexpose ungranted clinical/financial fields; no directory or record access across organizations. Shared discovery is distinct from encounter-history access. |
| D04 | Cross-clinic history | Doctors see history only for clinics explicitly granted to them. A two-clinic doctor demonstrates continuity; a clinic-only doctor demonstrates denial. Organization-wide clinical access is an explicit permission/scope, not inferred from admin role. |
| D05 | Patient identifiers and duplicates | One immutable organization-wide internal patient ID; proposed display UHID sequence across the organization for new synthetic patients. Same mobile number is allowed for family members; warn on likely duplicates but do not auto-merge. Existing real identifiers/import mapping are deferred. |
| D06 | Patient edits | Permitted identity edits update the shared patient record and are audited/version-checked. An existing clinical note/form is not rewritten when identity/defaults change. No merge, transfer or patient deletion workflow in demo. |
| D07 | Staff/resources and clinic working context | Staff may belong to multiple clinics; chairs, availability and appointments are clinic-attributed. Choose active clinic explicitly; show it on forms/writes/receipts. Keep context per browser tab/page request to prevent one tab silently redirecting another's save. Block overlapping appointments for a shared doctor in synthetic fixtures. |
| D08 | Override policy | Allow clinic contacts, opening hours, chairs and doctor availability to vary. Organization controls identity/access boundaries, form definitions, templates and core catalogue. Fees remain organization-controlled in the demo; local pricing/approvals can follow. Show inherited, overridden and locked states, with reset-to-inherit. |
| D09 | Form lifecycle | Organization creates/publishes immutable form versions and assigns them to selected clinics. Staff fill only assigned forms with explicit permission. Assignment removal blocks new submissions but preserves history. Drafts stay pinned; unsupported changes show an explicit resolution state. |
| D10 | Clinical correction/history | Save notes/forms with author, clinic, patient and version. Demonstrate an audited correction/addendum; no silent overwrite of finalized records. Do not include medical decision automation or AI-generated clinical advice. |
| D11 | Billing boundary and numbering | Synthetic receipt belongs to its issuing clinic, with a clinic-prefixed sequence unique within the organization. Organization admin can view permitted totals; original clinic remains identifiable. Real issuer/tax/numbering rules need review before real finance/import. This row defines demo mechanics only. |
| D12 | Balances and cross-clinic payments | Balances remain attributed to the clinic/issuer in the demo. Authorized users may see clinic breakdowns; clinic B cannot collect against clinic A's balance. No shared wallet, credits or automatic balance transfers. These require a separate accepted business workflow. |
| D13 | Financial corrections | Receipts cannot be deleted. Corrections are explicitly recorded/voided under permission with an audit reason; no hidden edits. Demonstrate only the supported simple correction path, not a full refund/tax accounting product. |
| D14 | Metrics and date rules | Show registrations, unique organization patients, clinic patient activity, visits/appointments and collections by clinic and organization. A patient visiting both clinics counts once organization-wide but in both activity counts. Use INR and Asia/Kolkata for all synthetic clinics; April-March financial year; date filters are labelled. Multi-currency and differing timezones are future reporting cases. |
| D15 | Documents and integrations | Use fictional uploads and organization-isolated local storage. Authorized patient/document access may span permitted clinics within an organization. No real Drive/S3 account, email/SMS/WhatsApp, payment gateway, public chatbot or external AI call in demo. Provider integration is later scope. |
| D16 | Login and switching | Use local hostname mapping to show separate organization subdomains and host-only sessions. One organization login grants only permitted clinics; no cross-organization SSO. Single-clinic users auto-select their clinic. Grant revocation takes effect on the next authorized request. |
| D17 | Screens and devices | Show organization administration and clinic workspace; hide unnecessary unit switching for single-clinic users. Verify desktop and a narrow/mobile viewport for the key flow. Full mobile redesign, offline operation and native apps are excluded. |
| D18 | Synthetic fixture, completion and changes | Stable fictional organizations/users/patients and a repeatable seed. Test two-clinic patient journey, form assignment, allowed/rejected override, stale-save handling, metric reconciliation and cross-organization/unit denial. Record a pass/fail demo checklist. A reset helper targets only explicitly identified disposable demo DBs; no reset is run without separate scope verification. After review, record changes against this register before expanding scope. |

## Technical implementation choices, handled by the agents

Table ownership and keys, RLS/grants, migration plan, validation, encryption/key
references, bounded pools, routes and request context, optimistic concurrency,
idempotent fixture/provisioning tooling, compatible rollback, cache invalidation
and serialized test ownership are engineering work. Present material tradeoffs
if they affect an accepted product rule. Do not ask the user to design SQL tables.

First prove isolation/access with failing tests where applicable, then complete the
UI flow. Tests using the shared kb_pms_test database must never overlap. Do not
edit applied migrations or destroy existing local/rehearsal data to simplify a demo.
Inventory the existing forms work before reusing or replacing it.

## Explicit later review before live use

Hosting/budget/domain ownership; recovery objectives, off-site backup provider and
actual restore drill; on-call owner; real legal billing entity/receipt numbering,
cross-clinic payment rules and tax configuration; migration/duplicate approval and
import reconciliation; actual storage-provider authorization; real staff access and
retention/export policy; security/dependency and browser acceptance; cutover and
first-week support. A working synthetic demo is not approval for production use.

## Approval and change process

All rows were accepted together in the main chat. Proceed within that scope; do not
ask the user to approve them again. Bring new material product tradeoffs to the main
chat and preserve the accepted rules in implementation and tests.
