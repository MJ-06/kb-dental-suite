# Patient and clinic CRM: latest product direction

31 October 2026. Explicit user correction in the main coordination chat.
This direction takes precedence over the contact-centre analogy and demo layout.

The organization/unit hierarchy is for ownership, isolation and settings inheritance.
It must not determine a contact-centre-style operational interface. The product is
a patient-centred clinical CRM and longitudinal record system. Keep clinical screens
familiar to the existing suite; study the live-source HTML and Apps Script behavior
before redesigning workflows. The new organization workspace is a functional demo,
not a feature-complete replacement or the agreed final clinical interface.

## Primary journey

1. Find the returning patient's shared organization identity and open their record.
2. See relevant demographics, medical/dental history, prior visits, treating doctors,
   procedures/treatment cases, forms, documents and permitted financial history.
3. Create/assign the current visit to a clinic and a doctor who works at that clinic.
4. Record the visit's treatments/procedures, notes and items/materials used.
5. Preserve these links in the patient timeline and in doctor, clinic and item histories.

The core relationships are patient -> visit -> clinic + treating doctor, with visit
treatments and item-usage entries. Multi-visit treatment cases link visits when
needed; an appointment is a scheduling record, not the complete clinical encounter.
Item usage means a clinical consumption/history record; full stock purchasing,
warehouse/inventory accounting and lab workflows need separate scope.

## Next implementation work (not already delivered)

- Audit the existing registration, diary, patient profile, clinical forms,
  treatment-case and finance screens and map their required behavior.
- Add a first-class visit/encounter and a patient-first longitudinal timeline.
- Preserve historical treating doctor/clinic attribution even when staff or unit
  details are later changed; distinguish planned doctor from actual treating doctor.
- Link performed treatments and item usage to visit, patient and treating doctor.
  Record item identity, quantity/unit and relevant lot/batch information where needed,
  with audit/correction behavior; do not silently rewrite historical usage.
- Provide doctor history (visits/treatments performed) and item history (where/when
  used) as authorized views of the same clinical records, not duplicated stores.
- Focus metrics on patient history and recorded care: visits over time, treatments,
  doctor activity and material usage, with explicit definitions. "Active patients"
  is not the organizing concept or primary product goal.

Organization isolation, explicit clinic/clinical permissions, assigned forms,
controlled overrides and the familiar clinical workflows remain requirements.
Shared identity must not expose restricted histories or finance across staff scopes.

## Current handoff boundary

The committed organization demo already proves isolated organization runtimes,
shared patients, clinic-scoped notes/forms/appointments, simple receipts, settings
and admin controls. It does not yet implement the complete visit/treatment/item
history model above. The older suite remains runnable separately for comparison.
The user's immediate priority is saving runnable code and fresh-laptop instructions;
do not replace clinical screens during that handoff merely to change their appearance.
