# Run both versions on another laptop

31 October 2026. Windows/PowerShell instructions. No Docker required.
Repository code includes both the familiar clinic suite and the organization demo.
Real databases, patient spreadsheets/files, .env files and passwords are deliberately
not included. Fresh setup creates new credentials and synthetic demo records.

## Requirements and checkout

Install Git, Node.js 24 and PostgreSQL 18 (including command-line tools). Start the
PostgreSQL service and retain the local `postgres` password you chose at installation.
Use PostgreSQL18: migrations use uuidv7 and version-specific database features.

```powershell
git clone --branch saas/multi-clinic --single-branch https://github.com/MJ-06/kb-dental-suite.git
cd kb-dental-suite
cd api
npm ci
```

For an existing checkout, inspect `git status` first and preserve local work before
pulling. Do not switch to main or reset an existing database to follow this guide.

## Fresh local databases: one-time setup

The following sequence is for a NEW, disposable development installation.
`db:bootstrap` creates kb_owner/kb_app and kb_pms/kb_pms_test and writes local env
files. Rerunning bootstrap rotates the shared role passwords: do not run it on an
existing installation without understanding which services use those credentials.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE/.kb-pms" | Out-Null
$env:PGSUPERPASS = [System.Net.NetworkCredential]::new('', (Read-Host 'Local PostgreSQL postgres password' -AsSecureString)).Password
npm run db:bootstrap
npm run db:migrate
npm run db:seed
node --import tsx scripts/provision-organization-demo.ts
node --import tsx scripts/provision-organization-demo.ts --apply
Remove-Item Env:PGSUPERPASS
```

Stop if any command fails; do not continue into migration/seed after a failed
bootstrap. Provisioning targets only the new kb_org_demo_a/kb_org_demo_b databases
and refuses an existing unowned target. It seeds Organization A with two clinics
and Organization B with one, including fictional patient histories/forms/receipts.
No source profile or migration/data files are needed. Use separate terminal windows
for the following three servers; run all commands from the checkout's api directory.

## Familiar clinic suite (older multi-clinic implementation)

```powershell
npm run dev
```

Open http://127.0.0.1:8080. Clinic code is `kbdev`. Username/password pairs for the
four roles are generated in `~/.kb-pms/dev-logins.txt`; do not paste them into chat.
The seed creates a fictional clinic and accounts; no real historical records are
included. Register fictional patients through the UI for additional local examples.
Existing registration, diary, clinical/treatment-case and finance screens remain.
The older implementation uses clinic tenancy in one database; it is the reference
workflow, not proof of the new organization/visit/material history requirements.

## Organization demo A: two clinics

```powershell
node --import tsx --env-file=.organization-demo-runtime/org-a/app.env src/organization-server.ts
```

Open http://org-a.localhost:8101. Accounts/password are generated in
`api/.organization-demo-runtime/org-a/demo-logins.txt` (path from repository root).

## Organization demo B: one clinic

```powershell
node --import tsx --env-file=.organization-demo-runtime/org-b/app.env src/organization-server.ts
```

Open http://org-b.localhost:8102. Use its own generated login file in the org-b
directory. Different organization hostnames are necessary for cookie isolation;
do not substitute two ports on the same 127.0.0.1 hostname. Modern browsers resolve
*.localhost locally. If the hostname does not resolve, have the technical operator
check local hostname mapping; do not disable browser security or organization host checks.

Use `admin` for organization controls, `doctor` for shared clinical history,
`doctor-one` for restricted clinic access, and `accounts` for first-clinic receipts.
Search synthetic UHID `DEMO-A-001` or `DEMO-B-001` for the seeded journey. Admin
intentionally lacks clinical permissions. Both demos use local documents and no
external integrations. Ctrl+C stops each server.

## Verify and continue with Codex or Claude

```powershell
npx tsc --noEmit
npm run build
npm test
node --import tsx scripts/verify-organization-demo.ts
```

Run npm test only once at a time: its files rebuild kb_pms_test. The HTTP verifier
requires A/B servers running and creates additional synthetic journey records.
Do not run reset/bootstrap commands as a troubleshooting shortcut on existing data.

Give the next coding agent this starting prompt:

> Read AGENTS.md, docs/HANDOVER.md, docs/PATIENT-CRM-DIRECTION.md and
> docs/ANOTHER-LAPTOP.md first. Stay on saas/multi-clinic. Preserve uncommitted work
> and real data. Both the familiar clinic UI and the organization demo must remain
> runnable. Review existing clinical UI before changing it. The next product work is
> patient-first visit history linked to clinic, treating doctor, treatment and items
> used, with doctor/item history views. Do not infer that the admin demo is the final
> clinical interface. See docs/DEMO-VERIFICATION.md for actual checks and remaining gaps.

Database backups and patient attachments need a separate secure migration if ever
required; cloning Git transfers only code and synthetic seed tooling. Never commit
or copy secrets/patient data into an agent prompt to make another laptop work.
