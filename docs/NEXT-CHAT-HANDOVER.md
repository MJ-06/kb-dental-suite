# Copyable handover prompt

Continue work in `D:\Projects\kb-dental-suite` on `saas/multi-clinic`. Read
`AGENTS.md`, then `docs/HANDOVER.md`, `docs/PATIENT-CRM-DIRECTION.md`,
`docs/SCREEN-API-DATA-GUIDE.md` and `docs/LAUNCH-REVIEW-AND-TIERS.md`.

Preserve the familiar clinical UI and passive linking. Organization is the isolated
database/deployment/session/storage boundary. Patients are central; care, doctors,
items and finance are clinic-attributed. Reuse internal UUIDs; retain visible UHID.
Master uses its existing password. Labs and larger UI redesign are deferred.

Inspect Git status before changes; preserve unrelated work. Never touch main or
force push. Commit explicit paths only. Run DB tests serially. Do not edit applied
migrations or put patient records/credentials in Git/chat. Ignore `nul` and nested
`kb-dental-suite/`. Never reset a real database to set up a demo.

Latest pushed clinical implementation before this launch-planning handoff is
`bdc3d62`; read current Git history for subsequent documentation commits. Full
suite293 tests and33 public HTTP checks passed at that snapshot; they are not proof
of current state or completed browser/production acceptance.

The familiar public demo uses dedicated synthetic DB `kb_public_clinical_demo`,
loopback8200 and ignored runtime config/documents. Credentials are local in
`api/.organization-demo-runtime/public-clinical/demo-logins.txt`; do not print them.
Quick Tunnel URLs expire/change; verify the server/tunnel before sharing a link.
Do not expose the development server/data on8080. Use `PUBLIC-CLINICAL-DEMO.md`.

Next: finish browser acceptance and original Add Record comparison; agree launch
scope/tier allowances; rehearse organization-compatible data migration with count,
financial and attachment reconciliation; implement server-side entitlements; test
restore and production hosting before a controlled pilot. Tier names/allowances
are proposals, not accepted pricing. Billing and plan enforcement do not exist yet.
