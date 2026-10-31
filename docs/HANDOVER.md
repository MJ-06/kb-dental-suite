# Handover for the next tool (31 Oct 2026)

Written so OpenAI Codex, or anyone, can continue without the chat history. Rules and
commands are in `AGENTS.md`; the long-form status and decisions are in `STATUS.md`.
The root `HANDOVER.md` is the older Apps Script handover and is out of date for this branch.
Branch: `saas/multi-clinic` (PR 138). People: Diya (product owner), Viveyk (the clinic's
doctor and owner, supplies data and decisions).

## Goal

Replace the clinic's Apps Script + Google Sheets system with a hosted, multi-clinic
practice management system. Plan: about 10 clinics; K.B. Dental is the first. Staff use
desk PCs and tablets, and also phones for the diary and forms (a separate phone website is
future scope). It must work over mobile data. For now it is built and run on Diya's own
laptop; hosting comes later.

## Architecture and stack

- `api/`: TypeScript, Node 24, Fastify, Kysely, PostgreSQL 18. No Docker yet.
- Clinics are isolated by forced row level security (`clinic_id = app_clinic_id()`). The app
  connects as `kb_app`, which owns no tables and cannot bypass RLS. Each request is one
  transaction; `session_resume()` sets the clinic and user for that transaction. No clinic
  set means no rows. Sessions live in the database, not in memory.
- `api/src/routes/`: REST `/api/v1/...`. `api/src/legacy/`: the `/exec?action=...` adapter
  that returns the old Apps Script response shapes so the existing HTML screens keep working.
- `api/src/http/pages.ts` serves the HTML screens with a nonce CSP and vendored libraries.
- Storage: `api/src/storage/` (server folder, S3-compatible bucket, Google Drive, chosen per
  clinic); `api/src/drive/client.ts`; `api/src/secrets.ts` seals credentials with `KB_SECRETS_KEY`.
- Migrations `api/migrations/0001`-`0022` plus `grants.sql`; tests in `api/test/` (about 200).
- Schema reference: `docs/DATABASE-STRUCTURE.md`; migration plan: `docs/MIGRATION-DB-PLAN.md`;
  plain-words security summary: `docs/how-we-protect-the-app.md`; multi-visit treatment
  specs: `docs/ClinicalSuite*.md`, `docs/MultiVisitTreatment.md`.

## How to run and test

See `AGENTS.md`. Key warning: `npm test` rebuilds the shared `kb_pms_test` database per file,
so **one run at a time**, and check no other agent is running one. A full run takes about
5 minutes. `STATUS.md` records 195 passing at the last full run; the review thread did not
re-run it.

## Decisions made

From `STATUS.md`, the migration answer files and the review thread (Diya, 31 Oct):

- Port from the live `apps-script/out/Code.gs`, not from Viveyk's `server/` copy.
- UHID scheme: two letters for the year (AA = 2015), month, running number (`AE0117`).
  `getNextUHID` reserves numbers; gaps allowed, duplicates never.
- Receipts: `yy-yy/n` per financial year (April start), continuing from the highest imported
  number. Receipts cannot be deleted; expenses are voided.
- Duplicate UHIDs: the latest row wins; only pairs differing in name, gender or date of birth
  go to review. Money history from April 2024 only; patients from all eras.
- Panel patients are one list with panel, category and card ID fields.
- Roles are customisable per clinic (admin, doctor, reception, accounts to start); permissions,
  not role names, gate features. Doctors do not see patient payments on progress notes unless
  the clinic turns it on.
- Each clinic chooses its document storage. K.B. Dental keeps its Drive folder
  "KB Dental - Patient Documents".
- Backups: daily to Drive (14 daily and 12 monthly copies proposed) plus a monthly restore test.
  Encrypted; the key kept apart from the backups (password manager plus a printed copy).
- Phone sessions lock after about 1 hour idle and end after 1 day, set per clinic.
- Out of scope: consents (stay on paper), care plans, treatment plans, AI consents, Inventory,
  Attendance and the other books.
- Diya's review answers (31 Oct): accepted nearly all of `docs/REVIEW-2026-10-31.md`. Lost-update
  protection with `version`, forms gated by permission not role name, rate limits keyed per
  session/account, move state-changing calls to POST, upgrade jsPDF, move letterhead and
  signature lines into clinic settings, longer separate limit for reports. Extra security work
  waits until the product is ready to ship. Cleanup of `nul` and the old nested copies: back up,
  delete, then delete the backup. A per-clinic database is a **real requirement**, not an option.

## Workstreams

| Workstream | State |
| --- | --- |
| Roles and access | **Done**: `f080c43`, `607fc42` (migration 0020, roles page, password reset ends other sessions). |
| Document storage | **Done**: `98c438e`, `1153a0b` (migration 0022, `/api/v1/storage`, `scripts/copy-documents.ts`). Fake S3/Drive servers in tests; not tried against a real bucket or Drive. No screen yet. |
| Custom forms and mobile entry | **Code written, not committed.** Untracked: `api/migrations/0021_forms.sql`, `api/src/forms/`, `api/src/routes/forms.ts`, `api/test/forms.test.ts`, `forms.html`. Modified and uncommitted: `api/src/app.ts`, `auth/login.ts`, `db/index.ts`, `http/pages.ts`, `routes/auth.ts` (phone sessions). Tests have not been run: they wait on Diya's OK because they use the shared test DB. Must use `storeFor(tx)` for photo and signature fields. Review finding to fix: form rules store role names (`fill_roles`, `view_roles`); change to permissions or role ids. |
| Drive backup | **Waiting on Viveyk**: is his Google Drive personal Gmail (use OAuth, one-time approval) or Workspace with a Shared Drive (use a service account)? Defaults agreed otherwise. There is no backup script or restore drill in the repo. |
| Data import and hardening | Importer and rehearsal tooling are in `migration/` and `api/scripts/` (rehearsal database `kb_rehearsal`, never committed). Waiting on Viveyk's answers (below). Demo checklist: screen share first; run the final import, then `api/scripts/fix-doctor-names.ts --apply`; check receipt totals against the sheet. Hardening still open: signed-in browser pass for CSP breakage, precompile chatbot JSX, `npm audit`, tighten rate limits. |
| Review findings | `docs/REVIEW-2026-10-31.md` (20 items, severity-ranked). High: no ops artefacts (nginx, service, `pg_dump`, restore); per-clinic DB not wired (`clinics.database_url` unused); form role names; no `version` checks (lost updates); 2.7 MB uncompressed `index.html` and base64 uploads. |

### Under discussion: one app instance per clinic

Diya wants a router or, better, one app instance (own database, config folder and subdomain)
per clinic, possibly in Docker. Claude's analysis: it fits 10 clinics, removes the need for a
router and central login database, keeps RLS as a second layer. It needs a "create clinic"
script (database, settings, first admin, nginx entry) and an "update all clinics" script, and
loses the cross-clinic view unless a small operator tool is built. Docker is not installed
here; the plan was plain processes with a per-clinic config folder and a Dockerfile later.
Not decided. Next step proposed: write the technical person's rulebook (setup, checklist,
backups, key rotation, updates), then the create-clinic script. Build for Diya's laptop first.

## Open questions

For Viveyk (full list: `migration/data/VIVEYK-DECISIONS-AND-QUESTIONS-2026-10-31.md`):
1. Personal Gmail Drive or Workspace Shared Drive (backup and Drive storage sign-in).
2. Stub patients for 17 well-formed UHIDs with no registration; review of 63 malformed UHIDs
   and 27 duplicate-UHID pairs (who signs).
3. Accept the filled-in services on 357 receipts; require a service on new receipts?
4. Cutover date, who checks the first week's totals, Google Form freeze date and who types
   clinical entries afterwards.
5. Hosting and who is on call; passwords for Finance, Master, Reports; does the second Reports
   password holder become admin or accounts; is Dr. Manika Mittel admin or doctor.
6. Clinic timings, slot length, weekly off, holidays, doctor signatures; which roles fill and
   view each clinical form; do manual receipts carry printed book numbers.
7. On the live site set `APP_PASSWORD`, then `REQUIRE_AUTH=true` (it currently exposes patient data).

For Diya:
1. Go-ahead to run `forms.test.ts` on the shared test DB, then commit the forms work.
2. Per-clinic instances: confirm the plan, and Docker now or later.
3. Bucket provider and region for attachments; whether the AI consent narrative
   (sends case details to Anthropic) and a public chatbot stay off.
4. Hosting target and who restores a backup at 9 pm, and how long the clinic may be without records.
5. Drive access scope: full-Drive (sees the existing hand-made folder) or app-created files only.
