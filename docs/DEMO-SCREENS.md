# Organization demonstration screen inventory

31 October 2026. D01-D18 are approved. Existing screens are code starting points,
not evidence that organization/unit authorization is already implemented.

| Use case | Existing source | Demo work |
| --- | --- | --- |
| Organization sign-in and clinic context | index.html, auth routes | Organization-bound sign-in, allowed clinic selector, single-clinic auto-selection |
| Organization overview and clinic metrics | admin.html and reports | Organization totals and per-clinic sections with unique-patient reconciliation |
| Shared patient search/register/profile | index.html, register.html | One organization patient directory and permission-scoped history |
| Clinic diary and shared doctor | index.html appointments, REST appointments | Clinic attribution and cross-clinic doctor conflict checks |
| Clinical note and correction | index.html clinical screens | Scoped notes with append-only corrections |
| Form authoring, assignment and entry | forms.html, forms routes (uncommitted) | Organization definitions and immutable versions, clinic assignments and preserved history |
| Receipts, balances and voids | index.html finance, expense.html | Issuing clinic, local balances, audited void and clinic-prefixed numbers |
| Staff and roles | roles.html and access routes | Organization users, per-clinic grants and explicit clinical access |
| Defaults and clinic overrides | index.html masters/settings | Typed inherited/overridden/locked controls and reset-to-inherit |
| Audit/history | system-log.html, audit tables | Authorized organization/unit history without leaking protected records |

Build a cohesive organization workspace for these flows while retaining the old
screens during transition. Reuse domain behavior and existing packages where useful;
do not embed old unrestricted /exec pages as a workaround for unit authorization.
The new interface must use real PostgreSQL-backed APIs, not browser-only mock state.
No public hosting or real integrations are included. Data examples are synthetic,
informed only by source structure/workflow and non-identifying aggregate patterns.
