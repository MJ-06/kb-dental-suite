# Small improvements that retain the clinical UI

Keep the sidebar, patient folder, blue palette, tooth charts, existing forms and
passive recording flow. Do not introduce a new navigation model or mandatory
visit-first wizard.

Delivered in this review slice:
- Default recent patient results with registration/appointment sort.
- Organization patient count; actual clinic plan counts and today's appointments.
- Clinic-local date defaults for diary, Daysheet and register.
- Visible unassigned-chair appointments; older saved treatment departments retained.
- Doctor filter instead of doctor maintenance in Procedure Done / Treatment Progress.
- Roles & access embedded under Master, administrator Reports without a second
  password, and authorized all-clinic reporting under Master > Organization.
- Remove duplicate clinic/patient banners in nested Clinical Records > Sheets.

5 November correction delivered: Roles & access is now native to the clinical UI,
replacing the earlier embedded page. Staff controls, grouped role permissions and
activity history retain server permissions. See `REAL-DATA-REVIEW.md`.

Next small UI changes to review:
1. Consistent **Save record**, **Saved**, **Unsaved changes** and retry/error labels.
   Replace remaining Google Sheets wording in the local runtime without changing
   the original hosted Apps Script version's behavior.
2. A compact clinic label beside each screen title and a clear **All authorized
   clinics** label in organization reports.
3. Records search/filter by procedure, treating doctor and date; keep record entry
   separate from filtering existing records. Historical doctor names remain visible
   even if the master has changed.
4. Make patient result rows keyboard-accessible with a visible Open patient action.
5. Consistent empty states: no records, no matching filter and failed load must have
   different messages. Show the next relevant action.
6. Align spacing, form labels, button sizes and table headers; preserve printable
   clinical templates. Keep financial amounts permission-scoped.
7. Add a small patient summary (UHID, DOB, safety flags) in the folder rather than
   repeating large branding and patient selectors inside nested screens.

Add Record behavior still needs side-by-side review against the original clinical
forms. This slice retains their entry and save contracts; it does not claim a full
redesign or acceptance of all17 embedded form layouts.
