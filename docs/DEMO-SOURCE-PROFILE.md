# Source patterns used for the synthetic demonstration

31 October 2026. Source inspection was read-only; no identifiable source records,
clinical text or original patient files were copied into demo fixtures or chat.

The rehearsal schema and aggregate counts confirm registration, diary, finance,
clinical-history and document workflows. The profile runs under enforced RLS with
explicit clinic context and a read-only transaction; only counts/schema are emitted.

| Source table | Aggregate rows |
| --- | --- |
| patients | 2499 |
| patient_registrations | 2499 |
| appointments | 306 |
| doctors | 11 |
| chairs | 4 |
| receipts | 1683 |
| expenses | 1226 |
| clinical_records | 4308 |
| clinical_sheets | 25 |
| patient_documents | 3 |
| treatments | 112 |
| medicines | 18 |
| panels | 1 |

The 11 spreadsheet files have 217 worksheets and 38 columns at their widest in
the structural review. No cell values were exported. These counts describe source
structure, not a completeness/reconciliation result for a live migration.

The demo deliberately uses a small independent fixture: fictional patient identities,
organization-wide UHIDs, family phone reuse, a consultation/follow-up across two
clinics, clinician notes and addenda, assigned visit forms, clinic receipts/voids,
and a fictional text document. Sample amounts, dates and findings are invented.
Original images, signatures, free-text notes and spreadsheet rows are not reused.

The reference review does not imply that the new workspace imports all historical
fields or supports the full clinical suite. Real-data import remains a separate,
reviewed and reconciled cutover workstream.
