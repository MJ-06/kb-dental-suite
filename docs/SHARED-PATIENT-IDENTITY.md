# Shared patient identity: first clinical-suite slice

3 November2026. Existing UI retained; next milestone after clinic switching.

## Delivered journey

Patient Search uses the organization directory in organization-linked local runtimes.
Search by name, organization/current-clinic UHID or primary phone (2–100 characters).
The first20 matches show demographics for disambiguation. Refine the query if needed.
A patient already registered at this clinic opens the familiar folder directly.
An organization patient not registered here requires explicit confirmation through
Add to this clinic and open. This requires patients:write. Searching requires
patients:read. Other appointment/registration pickers remain clinic-scoped and are
not silently changed into cross-clinic record selectors.

Attachment creates a local registration shell linked to the SAME organization
patient ID. It copies the shared identity fields only: name, primary phone, DOB and
gender. It does not copy medical/dental history, notes, treatments, forms, documents,
receipts, panels or balances. Source clinic IDs/UHIDs and historical clinical and
financial references remain intact. Neither matching name nor phone nor UHID causes
an automatic merge. Repeated attachment returns the existing local link.

The existing org_patients table is canonical; migration0025 adds links to existing
clinic patients. New clinic registrations publish identity automatically. Shared
identity changes from linked registration writes update the canonical four fields.
Legacy getPatient/findPatient and REST patient reads overlay those current fields;
the main organization search reads canonical data. Local patient rows retain other
clinic-specific demographic/registration fields. Existing direct legacy reports and
specialty payload snapshots are not globally rewritten into normalized identities.
This is an incremental bridge, not completed schema consolidation.

## Run after pulling on another laptop

From api/, after the existing local setup and clinic linker:

```powershell
npm run db:migrate
node --import tsx scripts/publish-clinical-patient-identities.ts
node --import tsx scripts/publish-clinical-patient-identities.ts --apply
# Optional, only for the named local development fixture:
node --import tsx scripts/seed-shared-patient-demo.ts --apply
npm run dev
```

Publishing is an explicit, transactional, idempotent backfill for linked clinics.
It prints counts only, does not merge existing records, and does not change their
clinic IDs/UHIDs. If unrelated clinic records have the same UHID, the second gets a
separate organization identity alias (OP plus a sequence); its old clinic UHID is
preserved. Attachment uses a different clinic-local UHID if the canonical one is
already used there. Archive conflicts are refused rather than restored silently.
Unlinked clinic patients remain isolated under the existing implementation.

The optional fixture creates Orion Shared Demo at kbdev only. To repeat the UI
journey, select the East clinic, search that fictional name and add/open it if it
has not already been linked. The browser acceptance performed that attachment.
The standalone OrgA/B demo instances were not reconfigured by this local backfill.

## Boundaries and next work

No patient deduplication/merge UI is delivered. Review duplicate candidates before
any explicit identity linking/merging of pre-existing records. New Registration's
older duplicate check is still clinic-scoped; staff should use organization search
for a returning patient. This must be improved in the next registration parity pass.

Cross-clinic medical/clinical/financial history is not exposed by this directory.
Next implement a permission-checked patient history/timeline across linked local IDs,
then actual visits with clinic, treating doctor, performed treatments/stages and
material usage, preserving original snapshots and source references. Do not broaden
RLS on clinic clinical tables merely because identity is shared. Distinguish denied
history from genuinely absent history without disclosing restricted details/counts.

Legacy registration writes still need submitted base-version checks; shared identity
is not a claim that all stale edits are prevented. REST retains local row version
checks, but organization identity editing needs its own explicit identity-version
contract before broader concurrent editing is considered complete. Other shared
contact fields and direct legacy report reads also remain a consolidation task.

## Verification

- Full serialized API suite:282 tests /22 files passed.
- Organization integration file:12 tests, covering shared identity, no copied private
  registration history, repeat attachment, duplicate-name/phone/UHID separation,
  forged/missing IDs, write permissions, REST canonical-name search/read and existing
  clinic-switch safeguards.
- Typecheck/build and inline-script parsing passed.
- Browser: synthetic patient found from the other clinic, explicit confirmation,
  successful attachment and existing folder navigation verified. No existing patient
  chart was opened/edited during browser acceptance. Screenshot:
  evidence/shared-patient-confirmation-2026-11-03.jpg.

The separate user-requested chat Clinical UI improvements and native backend
opportunities produced UI-NATIVE-OPPORTUNITIES.md as recommendations for review.
Its source snapshot is df7ab43; this slice has since addressed the main Patient
Search error-versus-empty and stale-response issues it identified. Other improvements
remain proposals and have not been implemented by that review chat.
