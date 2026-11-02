# Clinical UI / UX review and approval proposal

1 November 2026. Status: review proposal; application UI changes await user review.
Main chat is the product-decision owner. Read PATIENT-CRM-DIRECTION.md first.

## What was actually reviewed

- Started the existing Fastify clinic server at http://127.0.0.1:8080 and signed in
  with the supplied development account. Credentials were not written to any file.
- Local sign-in initially returned HTTP500 because kb_pms had migrations only
  through0019. Applied existing0020-0023 without resetting data; sign-in then worked.
- Opened https://kbdental.github.io/kb-dental-suite/ as the actual visual reference.
  Used one user-authorized reference patient only to inspect navigation/record layout.
  No live clinical record was edited, created, exported, printed or deleted.
- Inspected search -> patient folder -> Records -> Procedures, Notes & Fees and
  Clinical Records. Read only UI labels/structure; no real patient details, diagnoses,
  source notes, UHIDs or contact data were copied into the proposal or prototype.
- Read index.html navigation, open-patient state, FolderPicker/RecordsPicker,
  TreatmentProgress and ClinicalRecords; the live-source Code.gs field definitions;
  migrations0006/0008/0009; and the multi-visit treatment-case specification.

This is a focused design review, not a complete browser regression of every form,
save path, finance action, embedded iframe, print layout or public integration.

## What type of application this already is

The existing UI is a dental practice-management and clinical-record suite with
front-desk, financial and CRM functions. It is already largely patient-centred:
search opens the patient's folder, open-patient tabs preserve context, specialty
forms record tooth/site-specific care, and progress/fee sheets retain ongoing history.
The React single-page shell carries standalone/embedded clinical mini-apps and talks
to Apps Script in the published version or the Fastify /exec adapter locally.

It is not a contact-centre console. The organization demo demonstrated tenancy and
administration but is not an adequate replacement for this suite's clinical depth.

## Preserve these core elements

| Existing element | Observed behavior | Proposed treatment |
| --- | --- | --- |
| Blue/white visual identity | Blue #0078B4, compact left navigation, clinic identity | Preserve; modest spacing/contrast/consistency refinements |
| Patient Search | Name/UHID lookup; DOB disambiguation | Keep recognizable; add explicit accessible label and clear search/error states |
| Open Patients | Up to10 patient tabs; remembers section per patient | Preserve; label selected chart as Patient in view |
| Patient folder | Care Plan, Treatment Plan, Records, Procedures/Notes/Fees, Prescription, Documents, Fee Collection, Consent, Registration | Preserve shortcuts; add Overview & history and Visits |
| Records landing | Procedures/Notes/Fees, Clinical Records, Daily Register | Keep these destinations and existing names |
| Specialty forms and sheets | RCT, implants, crown/bridge, restoration, orthodontics, denture, pedo, diagnostics and other detailed records | Preserve tooth/site fields, specialty details, saved sheets and print workflow |
| Procedure/progress/fee sheets | Procedure Done Sheet, Treatment Progress Notes, Procedure & Fee Sheet | Keep the three-sheet workflow and add explicit visit references |
| Treatment cases | Stage completion can cover multiple stages in one sitting; visit count is only a counter | Preserve stage logic; a visit must not auto-advance one stage |
| Materials already recorded | Specialty fields include material, implant brand/size/lot and related details | Preserve them; build a structured linked usage view instead of discarding fields |
| Front-desk and finance | Diary, Daysheet, registration, receipts, collections, balances | Preserve role-aware flows; clarify clinic attribution |

Care Plan, Treatment Plan, consent and chatbot menu entries exist in the reference.
Their presence does not re-open out-of-scope backend work or approve new consent/AI
features. Do not remove familiar entries or promise implementation without review.
Lab Log is an existing clinical record category; standalone Lab units remain future.

## Fit to the corrected direction

The current UI has strong patient-history ingredients, including clinical rows,
saved sheets, procedure cases and a daily register. The missing piece is consistent
linkage and a single readable chronology, not a generic new text-form application.

Required additions:
1. Organization-wide shared patient identity with explicit clinical access scope.
2. A patient overview linking existing historical records across permitted clinics.
3. A first-class actual visit/encounter with clinic, actual treating doctor, treatments,
   related procedure-case stages and material usage; an appointment remains scheduling.
4. Doctor and item-history views derived from the same visit-linked records.
5. Clear handling of legacy records whose clinic/doctor/visit link is unknown. Mark
   attribution unknown; never guess doctor ownership from a typed name or current user.
6. Historical attribution and corrections preserved when master data changes.

## Specific UI findings and improvements

| Finding | Proposed improvement | Priority |
| --- | --- | --- |
| Search opens a section chooser, with history spread across destinations | Keep the chooser; add a prominent Overview & history shortcut and dated timeline with links back to original forms | P1 |
| Active Patient refers to the currently selected chart | Rename to Patient in view; this is not an active-patient classification | P1 |
| Clinic, doctor and patient context can be implicit in different forms | Persistent patient header; working clinic selector; confirm actual clinic/doctor in each visit | P1 |
| Material/lot details exist inside specialty forms but lack a unified usage view | Link usage to visit and keep original fields; drill patient -> visit -> doctor/treatment -> item/lot | P1 |
| Navigation relies on clickable divs and some inputs on placeholders | Semantic buttons/links, visible labels, keyboard focus and predictable tab order | P1 |
| Saving is distributed across embedded forms | Show draft/saving/final/error state and preserve unsaved input; never signal success before the backend confirms | P1 |
| Full letterhead repeats in interactive pages | Compact app header, retain full letterhead in preview/print outputs | P2 |
| Local UI says Google Sheets connected although served by the API | Use truthful connected/offline/error state; keep implementation/provider detail out of routine workflows | P2 |
| Clinical and monetary context are mixed in some navigation elements | Clinical roles see permitted clinical history; money details require finance/payment permissions | P1 |
| Sidebar is already broad | Keep familiar labels; group new history views and place organization controls under Master/Administration | P2 |
| Existing CRM includes business/follow-up functions | Name the overall product Clinical Suite / Patient & Clinic CRM; do not turn patient care into lead/agent queues | P1 |

## Concrete proposal for review

Prototype: http://127.0.0.1:8090/.
Source: design/clinical-review-v1/index.html, review.css, review.js.
Independent static UI; no application API, credential, patient source, database write
or external integration. Every displayed identity and care example is fictional.

Review these paths:
- Patient folder -> Overview & history -> a specific visit -> existing clinical form.
- Record visit -> clinic + actual doctor -> treatment/stage -> material usage ->
  review summary (does not save).
- Records -> the familiar specialty form grid; Procedures/Notes/Fees retains the
  original three-sheet structure.
- Doctor History and Item Usage History -> original visit.
- Patient Search and open-patient switching; a second fictional patient has an
  independent empty visit timeline.

Retained workflow pages are explicitly schematic previews, not recreated full
clinical forms. This prototype validates navigation/context and visual continuity;
the current8080 screens remain the reference for detailed field design.

## Approval requested from the user

### Verification performed on the separate prototype

- `node --check design/clinical-review-v1/review.js` passes.
- Browser: patient folder, timeline, correct visit-detail links, independent patient
  tabs and fictional search, visit-summary dialog, doctor-history and item-history
  links were exercised. A prototype history-link error was captured as a failing
  browser assertion, fixed, and retested before delivery.
- Read-only historical visit details preserve the selected visit's date/clinic/doctor;
  the working clinic does not silently change historical attribution.
- The second fictional patient has an independent empty timeline, not the first
  patient's history carried into a different tab.
- Desktop1280px and phone390px checked: no horizontal page overflow; no new browser
  console errors after the final reload. Temporary viewport override was reset.
- Evidence uses only fictional records: `design/clinical-review-v1/evidence/`.
- No application screen implementation, backend feature change, live save,
  production deployment, database reset or shared-database test run was performed.
  The only development database operation was applying the pending checked-in
  migrations needed for the requested local sign-in.

Review the concrete prototype before application implementation:
1. Keep patient folder as the opening destination, with Overview/history as its
   prominent first option, or open Overview first?
2. Does the proposed visit context (clinic, actual doctor, date, tooth/site and
   related case) preserve the way staff record care?
3. Are doctor/item histories separate navigation entries, or grouped inside Reports?
4. Is the compact app header acceptable while keeping current full print letterheads?

These are choices about this proposal; prior accepted organization isolation and
permission rules do not need reapproval.

## Next steps after review

1. Record approved navigation and a screen/field mapping against the current UI.
2. Design visit/treatment/item relationships and map legacy records without losing
   specialty detail or inventing missing attribution.
3. Implement a small integrated patient journey in the familiar screens; add failing
   regression tests before bug fixes and serialize shared-database test runs.
4. Verify clinical, front-desk and accounts permissions, cross-clinic history,
   patient-tab isolation, save recovery and unchanged print outputs with synthetic data.
5. Broaden screen changes only after that journey is reviewed; no live deployment
   or real-data import is part of this UI/UX approval step.
