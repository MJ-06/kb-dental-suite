# AGENTS.md

Instructions for AI coding agents (OpenAI Codex and others) working in this repo.
Read `docs/HANDOVER.md` first for the goal, decisions and workstream status.

## What this is

KB Dental's practice management system, being rebuilt as a multi-clinic product.
The new backend is in `api/` (TypeScript, Node 24, Fastify, Kysely, PostgreSQL 18
with forced row level security per clinic). The old screens (`index.html`,
`register.html`, `chatbot.html`, `expense.html`, plus `admin.html`, `roles.html`,
`system-log.html`, `forms.html`) are served by the API and talk to it through the
`/exec` adapter that mimics the old Apps Script.

Work on branch `saas/multi-clinic` (PR 138, pushed to the fork `MJ-06/kb-dental-suite`).

## Rules

- **Never touch `main`.** Stay on `saas/multi-clinic`. No force pushes.
- **Commit explicit paths only** (`git add <file> ...`, `git commit <paths>`). Never
  `git add -A` or `git commit -a`: other people and agents leave uncommitted work in
  the same tree.
- **No patient data or secrets in git.** `migration/data/` is git-ignored and holds
  real clinic spreadsheets, answer files and zips: read them only to summarise, never
  copy rows, names, mobiles or UHIDs into code, tests, docs, commits or chat. Use
  made-up patients in tests. Never commit `api/.env`, `~/.kb-pms/*`, keys or tokens.
- **Do not run the test suite in parallel or while someone else is.** All test files
  share one database (`kb_pms_test`) and each file drops and rebuilds it. One run at a
  time; run a single file with `npx vitest run test/<file>.test.ts`.
- Do not edit applied migrations. Add the next numbered file in `api/migrations/`.
  (0001-0006 were edited in place before first deployment and are about to be frozen.)
- Port behaviour from the live Apps Script copy `apps-script/out/Code.gs`, not from
  `server/` or `kb-dental-suite/` (older copies of the code).
- Ignore the stray root file `nul` and the nested folders `kb-dental-suite/` and
  `server/`; they are slated for cleanup (back up first).

## Commands (run from `api/`, Windows, PowerShell or Git Bash)

```bash
npm install
npm run db:bootstrap   # once per machine: roles, kb_pms + kb_pms_test, writes .env
npm run db:migrate
npm run db:seed        # dev clinic "kbdev", one account per role
npm run dev            # http://127.0.0.1:8080
npm test               # vitest, shared test DB: one run at a time
npx tsc --noEmit       # typecheck
```

Secrets live outside git: `api/.env` (app credentials), `~/.kb-pms/owner.env`
(schema owner), `~/.kb-pms/postgres-superuser.txt`, `~/.kb-pms/dev-logins.txt`
(test logins, clinic code `kbdev`). PostgreSQL 18 runs as the Windows service
`postgresql-x64-18`. Docker, pnpm, Java, Go, Rust are not installed.

## Conventions

- Every new clinic table: `clinic_id ... DEFAULT app_clinic_id()`, the housekeeping
  columns (`version`, `created_at`, `updated_at`, `created_by`, `updated_by`), then
  `SELECT enable_tenant_table('name')`. Foreign keys to tenant tables include `clinic_id`.
- Legacy `/exec` actions declare a permission (`read(fn, perm)` / `write(perm, fn)`);
  a `{success:false}` result rolls the transaction back. New REST routes go under `/api/v1`.
- Permissions are checked by permission name, never by role name (clinics can rename roles).
- Use `clinic_today()` and `clinics.timezone`, never the server's timezone.
- In `sql` templates write `[0-9]` / `[.]`, not `\d` / `\.` (JavaScript eats the backslash).
- Clinical flat-form code in `api/src/legacy/clinical-forms.ts` is generated: rerun
  `py api/scripts/gen-clinical-forms.py` instead of editing.
- Match the surrounding code's style; no new dependency if the stdlib or an existing one will do.
- Write files UTF-8 without BOM, LF endings for `*.sh`. Quote Windows paths.
- Every bug fix starts with a failing test. Do not claim something works without running it.
