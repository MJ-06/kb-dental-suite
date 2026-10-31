# Organization demo UI: implementation and QA handoff

## Main-chat QA follow-up

Organization A admin signed-in browser checks now pass for navigation, clinic
switching, organization/clinic metrics, staff scope display, forms creation/version2
publication/assignment dialog, organization settings display, clinic override/reset
and audit. Two browser rendering regressions were captured before fixes and retested:
replaceChildren must receive spread DOM nodes, and readonly=false must set the DOM
property rather than a present boolean attribute. No backend/schema change was needed.
See `DEMO-VERIFICATION.md` and `docs/demo-evidence/` for exact results and screenshots.
Rows below retain the original workstream handoff status; this follow-up supersedes
manual-pending only for the admin checks explicitly listed. Clinical/accounts/Org B
browser flows and fixed desktop/mobile viewport testing remain pending.

31 October 2026. Approved scope: D01–D18 in `DEMO-DECISIONS.md`; Organization A
with two clinics, Organization B with one. Labs are future scope.

## Delivered files and contract

- `organization.html`: local organization sign-in and responsive workspace shell.
- `organization.css`: teal/slate dental administration styling, responsive navigation,
  readable tables/cards, dialog and focus styles, reduced-motion treatment.
- `organization.js`: plain JavaScript against `docs/DEMO-API.md`; no dependencies,
  CDN, inline event attributes, inline styles, generated clinical advice or mock API.
- This checklist. The UI workstream edited only these four files.

Backend owns serving `/` or `/organization.html` plus external `/organization.js`
and `/organization.css`, CSP, PostgreSQL persistence, permission checks and document
storage. Expected local origins are `http://org-a.localhost:8101` and
`http://org-b.localhost:8102`. No Site project, source synchronization, hosting,
deployment, secret read, reset or commit was performed. Sites skill local-only
workflow was used in the existing checkout.

## Verification actually performed here

**PASS:** `node --check organization.js` after implementation and subsequent changes.
This is syntax verification only, not a behavioral/browser test.

**PASS (source inspection):** no `innerHTML`, inline event attributes or inline
style attributes; dynamic text uses DOM text nodes/textContent. Username/password
submit only to same-origin auth; passwords are neither embedded nor stored in
browser storage. SessionStorage holds only the page and clinic ID under the
organization code, so clinic context is per tab. Unit writes include explicit
`unit_id`. Form entries pin immutable `form_version`/form ID, not housekeeping
`version`. Mutation success messages follow successful API responses.

**NOT RUN:** browser QA, screenshots, responsive rendering checks, login/API smoke
checks, accessibility tooling, database tests and migrations. Main coordination
chat owns integration and all browser/database verification. No UI behavior below
is claimed tested; every row is **IMPLEMENTED / MANUAL PENDING** until that QA.
The existing shared DB suite must remain serialized.

## Screen-to-use-case checklist

| Screen / decision | Implemented path and expected check | Status |
| --- | --- | --- |
| Organization login (D02, D16) | Login uses username/password at the current organization host; public identity names the organization. Sign out calls server logout. Account examples contain no password. Sign in at A and B; verify host-only sessions and cross-organization denial. | Implemented / manual pending |
| Role landing (D02, D16) | Admin and accounts open permitted metrics; doctor/reception open Patients; clinic-admin opens Settings. Remembered pages are validated against current capabilities. Admin has no default patient/clinical navigation or patient controls. | Implemented / manual pending |
| Clinic context (D07, D17) | Persistent header names the active clinic. Multi-clinic users select it; single-clinic users see its name without an unnecessary selector. Open two tabs, choose different clinics, then write records and verify attribution. Stale screen responses are ignored. | Implemented / manual pending |
| Organization and clinic metrics (D01, D14) | Overview has inclusive date filters, organization/working-clinic reporting scope, deduplicated active patients, registered identities, appointments, collections and per-clinic rows. INR/Asia/Kolkata labels and generated timestamp are visible. Compare two-clinic activity to unique active count and receipt totals. | Implemented / manual pending |
| Shared discovery (D03, D05) | Patients searches exact UHID or exact phone plus name confirmation. No unrestricted directory fetch. Open matching identity, then verify its separate clinic record access. | Implemented / manual pending |
| Registration/duplicate warning (D05) | Register in the working clinic; server supplies organization-wide UHID. Reused family phone is accepted with the server duplicate-warning message; no automatic merge. | Implemented / manual pending |
| Shared identity edit (D06, D18) | Profile edit sends identity `version`; failed save retains dialog entries. Open two stale copies, save one, verify conflict in the other. Explicit Reload latest fetches current identity before restarting edit. Confirm immutable old clinical snapshots server-side. | Implemented / manual pending |
| Clinic history/continuity (D04, D10) | Profile history requests only the explicit clinic. Doctor can switch A's clinics and see their respective notes; doctor-one sees only first clinic. Records include author/time/clinic and finalized status. | Implemented / manual pending |
| Appointments (D07) | Book from diary using exact patient UHID or from profile. Doctor list comes from active clinic API; times are labelled/converted explicitly as Asia/Kolkata. Book shared doctor overlaps in A's two clinics and confirm server conflict, with no fake success. | Implemented / manual pending |
| Clinical note/addendum (D10) | Finalize note; add correction to note or submission using addendum endpoint. Original text is never edited/deleted. Refresh history and verify author and original entry retained. | Implemented / manual pending |
| Form author/version/assignment (D09) | Admin creates named text-field definitions, required flags, stable keys and clinic assignments; previews and publishes immutable versions. Existing form New version keeps key. Assign clinics can remove all assignments. Confirm new submission blocked after removal. | Implemented / manual pending |
| Assigned form entry (D09, D10) | Patient Assigned forms tab loads working-clinic versions. Required fields use native validation; submit sends exact form ID. Server assignment/version conflict is displayed without closing or rewriting draft. Reopen current assigned form to resolve. | Implemented / manual pending |
| Receipts/balances (D11, D12) | Accounts profile shows clinic balance and clinic-prefixed receipts. Issue charge/payment in INR against explicit clinic; verify separate balances after clinic switch and reject overpayment. No wallet, transfer or cross-clinic allocation control. | Implemented / manual pending |
| Receipt correction (D13) | Void dialog requires reason. Original receipt stays visible with void state/reason; no receipt edit/delete control. Reopen billing to confirm reconciled balance and organization collections. | Implemented / manual pending |
| Fictional documents (D15) | Profile Documents tab lists scoped metadata; upload allows text/PDF/PNG/JPEG up to 1 MiB using document API. Download is same-origin with explicit clinic. Verify bytes/checksum, organization isolation and denied clinic/document IDs. | Implemented / manual pending |
| Staff scope (D02, D16) | Admin reviews fixture staff and organization permissions; edits one clinic grant with named capabilities or doctor/reception/accounts/clinic-admin starting template. Empty grant removes clinic capabilities. Verify next-request revocation in another tab. | Implemented / manual pending |
| Settings policy (D08) | Settings show effective value, inherited/override source and organization lock. Contact/hours/availability strings and one-chair-per-line override editor use current version. Reset removes override. Fees, identity, forms, access and catalogue display locked without misleading edit buttons. Verify direct API rejects locked changes. | Implemented / manual pending |
| Organization defaults (D08) | Admin opens Settings -> Organization defaults; edits central contacts, hours, chairs, availability, catalogue lines and structured service-code/name/INR fee rows. Saves use real default revision and API; stale conflict retains entries. Edit a default, verify an inheriting clinic updates while an overridden clinic stays unchanged, then reset that override and verify current default. Identity/access/forms remain locked to dedicated workflows. | Implemented / manual pending |
| Audit (D06, D10, D13) | Admin Activity log lists safe action metadata, actor, clinic and reference. Verify writes appear without clinical payloads or credentials. | Implemented / manual pending |
| Narrow viewport/accessibility (D17) | Responsive horizontal navigation, stacked header/context, card metrics, scrollable labelled tables, skip link, real labels, dialog focus/escape, live feedback and keyboard patient tabs. Check desktop and ~390px viewport for registration -> appointment -> note/form -> billing. | Implemented / manual pending |
| Completion/security (D18) | Repeat the two-clinic patient journey, denied organization/clinic calls, stale save, form assignment change, override/reset and metric reconciliation. Root records observed passes/failures with tested build and date. | Manual pending; integration owner |

## Deliberate limits of this slice

Staff accounts are seeded by backend; UI manages their existing clinic grants, not
account creation or password administration (no such endpoint in this contract).
Forms use text fields only. Documents use small fictional files and local storage.
Clinic settings edits allowed overrides; organization administrators have a separate
Organization defaults scope for shared contact/hours/resources/catalogue/fees.
Identity/access/forms use their dedicated workflows, not the generic defaults editor.
There are no lab, external integration, wallet, AI, merge, patient
deletion, production release or recovery-execution controls. Browser/API denial
remains meaningful and must not be replaced with fabricated fixture success.

## Integration details worth checking

- API `error.message` appears in context; 401 returns to sign-in, 403 displays denied,
  409 preserves the open form and makes clear that the action was not saved.
- Server field names include `form_version`, receipt `number`, audit `actor`,
  settings source `inherited|override`, and `unique_active_patients`.
- Organization defaults use `GET/POST /settings/defaults` for `settings:manage`
  only, with `source=organization`, true default row revisions and generic-editor
  `locked` flags. Clinic overrides continue to use explicit `unit_id` and their own
  version. Text/list/fee editors expose typed fields rather than a JSON textarea.
- Focused integration review: Reset recognizes `source=override`; every form-version
  display uses `form_version` only. Clinical notes and form submissions both show
  the returned `author_name` or `author`. Submission addenda are labelled addenda.
  Syntax rechecked after these corrections; behavioral verification remains owned
  by the main chat (no additional test run here).
- Changing active clinic closes an idle modal; a pending mutation cannot be
  cancelled through dialog controls/escape before its server result. API authority
  remains the explicit captured clinic ID; UI never mutates server-global context.
- No database/browser test has been run by this workstream. After integration,
  inspect CSP console errors, HTTP failures and keyboard focus in the real browser.
