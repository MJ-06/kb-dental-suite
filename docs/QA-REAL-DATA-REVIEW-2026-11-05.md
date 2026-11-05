# Real-data review QA — 2026-11-05

## Scope and handling

Read-only UI review used the protected review environment. No production data was changed. The only write journey ran against the isolated synthetic database on port 8200. No patient values, credentials, document contents, or financial totals are included here. This review covers the rehearsal and its review flags; it is not production acceptance or cutover approval.

The repository was on `saas/multi-clinic`, based on `0bf29e31eb28a0bf38b05d7fc3751af8c9c3a5a5`. The worktree already contained uncommitted implementation changes. They were left untouched; this file is the only QA report created by this review.

## Result matrix

| Area | Result | Evidence / limit |
|---|---|---|
| Expanded protected API | **PASS** | 33/33 checks against the 2,576-patient review target, including admin/doctor access, patient directory, linked history, appointments, finance, CRM, organization reports, documents, and role denial. No patient rows or credentials were printed. |
| Source-field reconciliation | **PASS, with scope limits below** | Independent read-only comparison matched all 2,499 accepted source patient rows and all compared original source rows in the full rehearsal. Three of three document checksums matched. The 77 additional identities independently matched source demographics and provenance. |
| Review identity expansion | **PASS with review flags** | 2,499 accepted historical identities plus 77 recovered identities = 2,576. All 77 are flagged for review; missing patient types remain null. No names, contact details, or clinical facts were generated. |
| CRM expansion | **RECONCILED; final fingerprint check pending** | The eight-row increase is now attributed to seven preserved older-UI transformations and one additional review pipeline. The guarded demo-only reconciliation retained transformed payloads under original source row IDs and removed appended duplicates. Three duplicate entity groups already exist in source and were not merged. Do not reopen/save CRM until the final fingerprint check and credential rotation are complete. |
| Clinical / financial history UI | **PARTIAL** | Main screens and API contracts load. Longitudinal UI content was not demonstrated for a patient with a populated visit/material history; Care Plans and consents are absent in the source. |
| Real-data write behavior | **NOT RUN** | No real-data records were created or edited. |
| Synthetic write journey | **PASS after read-only follow-up** | Fictional patient, appointment, care plan, treatment plan, restoration form, receipt, expense, two concurrent CGHS bills, document upload/read, clinic switch, and stale-context rejection were exercised only in the synthetic database. Follow-up confirmed the receipt and expected role API denials. |
| Release / production readiness | **BLOCKED by open gates** | Identity source exceptions, pending final CRM fingerprint/credential rotation, and unverified Daysheet date filtering remain. This review does not approve cutover. |

## Data reconciliation

The full rehearsal contains 2,576 patients: 2,499 accepted source identities and 77 recovered, review-required identity records. It contains 2,499 registration rows; the 77 identity-only additions do not have fabricated registration rows. A source-workbook coverage audit scanned 82 tabs and 57,474 rows. The independent comparison reports matching fields for all original rows in the compared tables and matching checksums for all three documents.

Date and historical-field provenance must be visible to acceptance reviewers. Among the 2,499 registration dates, 1,886 derive from the UHID month, 107 from earliest recorded activity, and 506 from source timestamps. Of 1,683 receipt descriptions, 325 derive from register text (307 direct and 18 nearby-register matches), 1,326 are typed descriptions, and 32 remain null. Of 220 treatment-plan rows, 219 are tagged as finance opening estimates. Those 219 are not clinician-authored treatment plans. The source comparison preserves their imported fields; the provenance still requires business acceptance.

Counts for relevant source/rehearsal tables: appointments 306; daily register 5,161; clinical records 4,308; clinical sheets 25; treatment cases 31; treatment plans 220; receipts 1,683; expenses 1,226; patient documents 3. Care plans, consents, and CGHS bills are zero in the real-data rehearsal; those absences reflect source coverage/new feature status, not a successful display of populated records. Expense rows are clinic-level and were not assigned to the second clinic.

The source workbook audit still reports 5 unresolved standard identifiers, 24 named rows with nonstandard identifiers, and 13 named source rows without an identifier. These are source acceptance/reconciliation items; they must not be described as verified patient matches or silently discarded. Other nonstandard identifier groups were also present in the workbook audit.

### CRM reconciliation

The independent field comparison matched all 2,511 original `crm_records` and all 3 `crm_lead_inbox` rows before the guarded reconciliation. Follow-up diagnosis attributes seven transformed payloads to the older clinical UI (lead notes/stage/pipeline/update timestamp and pipeline stages/consolidation markers); the UI generated new storage UUIDs while retaining each existing `data.id`. Full append had introduced seven collisions. The guarded demo-only reconciliation restored those transformed payloads under their original source row IDs and removed only appended duplicates. One additional review pipeline remains. No duplicate entity groups were introduced; three duplicate groups already present in source were not merged. The verifier now fingerprints the preserved CRM transformations, and clinical, finance, and patient fields remain exact. Final fingerprint verification and credential rotation are still pending. No row-level identifiers or values are reproduced here.

## UI and access review

| Workflow | Result | Notes |
|---|---|---|
| Dashboard / patient search / folder | **PASS** | Dashboard showed 2,000 before expansion; post-expansion API now confirms 2,576. Search defaults to 20 results. Patient folder, History tab, and clinic filter opened. |
| Populated patient history | **PARTIAL** | The inspected recent patient did not surface doctor/material labels. API-linked history opens, but a populated longitudinal history could not be demonstrated from that selection. |
| Registration / clinic switching | **PASS** | Registration screen opened read-only. Switching Main → Second → Main succeeded with no unsaved changes. |
| Diary / unassigned appointments | **PASS** | Historical date with unassigned appointments showed a separate “Appointments without a current chair” section. |
| Daysheet historical filter | **BLOCKED / INCONCLUSIVE** | The control displayed the selected historical date while the page remained empty; API returned eight appointments for that date. The browser date control may not have committed the edit, so this is not counted as a product defect or a pass. |
| Care Plan / consent | **EMPTY BY SOURCE** | UI opened, but target has zero care plans and zero consents. |
| Forms and Sheets | **PASS, catalogue only** | All 18 blank forms and all 6 chart Sheets tabs opened without patient selection or saves. This does not establish populated historical form behavior. |
| CGHS | **PASS, empty real data** | Records stage and Finance → CGHS Bills register opened. Real rehearsal has zero CGHS bills. Synthetic CGHS flows were exercised separately. |
| Finance / reports / organization reports | **PASS, UI load** | Finance, Reports, and organization-wide report views opened. No real-data financial totals are reproduced. |
| Roles and CRM | **PASS, UI load** | Native Roles & Access view loaded without an iframe; CRM page opened before the reconciliation update. Do not reopen or save CRM while final fingerprints and credential rotation are pending. |
| Documents and role boundaries | **PASS** | Three document files matched checksums. Doctor could read clinical/documents but not finance or role management; reception was denied clinical, documents, and finance; accounts could read finance but not clinical/documents. Role management was denied to non-admin roles. |

## Synthetic write checks

The synthetic journey ran against the isolated public clinical demo database only. It created fictional records and covered appointment status, care/treatment plans, a clinical form, receipt, expense, concurrent CGHS numbering, document upload/read, clinic switching, and rejection of stale clinic context. Doctor role API requests were denied. An initial harness summary was 16/18 because it expected a receipt ID field not returned by `saveReceipt` and had a role-check false negative. Read-only follow-up found the saved receipt and confirmed role API requests returned 403; the latest synthetic public verifier passed 33/33 after the fixture date correction and write journey. No synthetic patient facts were added to the real-data environment.

## Verification and limitations

- Serialized API/database suite: 299/299 tests across 28 files passed during this review. After the later expansion and guarded CRM reconciliation, parent coordination reports the full backend suite passed 300/300, plus a targeted legacy-patients regression of 12/12 and TypeScript pass. Those later checks are parent-reported, not rerun here.
- Protected real-data API verifier: 33/33 passed after expansion.
- Recovered identity verifier: 77/77 demographic/provenance checks passed; all review flags and null patient types verified.
- Synthetic public API verifier: 33/33 passed after the synthetic write journey.
- Root browser test runner, Daysheet historical date filtering, external AI/PDF/provider integrations, and production deployment/cutover were not verified in this review.
- This report does not establish source-owner acceptance of inferred historical dates/descriptions, opening-estimate plan provenance, or unresolved workbook identities. The CRM transformations are attributed and fingerprinted by the updated verifier; its final post-reconciliation fingerprint run and credential rotation remain pending.

## Remaining acceptance gates

1. Reconcile and disposition the 5 unresolved standard identifiers, 24 named nonstandard identifiers, and 13 named rows without identifiers using an authorized source owner; record outcomes without copying patient values into code or general logs.
2. Complete the final CRM transformation fingerprint check, then rotate the temporary review credentials; avoid further CRM UI access until both are complete.
3. Retest Daysheet historical filtering with a committed date selection and compare the displayed result count with the read-only API count.
4. Obtain explicit acceptance for imported date/receipt-description provenance and the 219 finance-opening-estimate treatment-plan rows; do not present those rows as clinician-authored care plans.
5. Demonstrate populated patient visit/material history with appropriate clinic and treating-doctor attribution before claiming complete clinical-history acceptance.
6. Perform any production migration/cutover review separately. This rehearsal QA is not authorization to cut over.


## Final coordination evidence — after independent testing

The coordinating agent completed the final post-reconciliation comparison: original
patient, master, clinical and financial fields match; all three attachment hashes
match. CRM preserved transformations are verified against explicit source/review
fingerprints, rather than reported as byte-identical source data. No append-introduced
CRM duplicate groups remain. The serial backend suite passed300/300; TypeScript,
build and four inline-script parses passed. Temporary staff/screen passwords were
rotated after the independent verifier finished; old sessions ended. The public
33-check verifier passed again with new credentials. Earlier pending fingerprint
and rotation items above are therefore closed; the documented Daysheet, populated
history and source-acceptance limitations remain open. This paragraph records
coordination evidence, not additional independent browser coverage.


## Superseding focused check — 6 November 2026

Read UI-COMPARISON-2026-11-06.md for the later one-patient original/prototype check.
Daysheet date commitment now works: prototype5 rows/API5, selected patient1 in both
UIs/API. Original live day total4 versus snapshot5 remains pending source review.
Populated restoration doctor's/material values match both UIs; prototype in-page
print preview contains those values. This patient's Treatment Plan is empty in
both versions and no explicit historical staff attribution was present. Original
popup print layout remains unverified. Do not broaden these results to every form
or complete structured visit/material history.

The previous CRM fingerprint/rotation were completed at the time recorded above.
A newer pipeline stages change is now preserved for review; two storage IDs were
regenerated and order values changed. Contacts/leads remain unchanged. The latest
strict CRM comparison is pending rather than silently blessing that later change.
Current patient/clinical/finance fields and three file checksums match the source.


Final Nov6 coordination: credentials rotated again after the focused comparison;
prior sessions ended and34 public checks passed with the new logins. Source-related
pending items remain preserved for Viveyk; rotation is not pending user action.
