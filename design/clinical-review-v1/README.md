# Clinical UI review prototype

Separate static design artifact. It does not replace index.html or connect to
clinical data, APIs or credentials. All patients, doctors, visits and material
examples are fictional. Retained detailed screens are labelled schematic previews.

From repository root:

```powershell
py -m http.server 8090 --bind 127.0.0.1 --directory design/clinical-review-v1
```

Open http://127.0.0.1:8090/. The real existing clinic UI remains at port8080.

Review Patient folder, Overview & history, Record visit, Visits, Records,
Procedures/Notes/Fees, Doctor History and Item Usage History. The visit summary
button is a design preview with no save. Clinical form cards explain preservation
of the current form rather than presenting a generic replacement.

Full findings, approval questions and next steps:
`docs/CLINICAL-UI-REVIEW-2026-11-01.md`.
