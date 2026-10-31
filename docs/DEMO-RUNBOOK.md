# Synthetic organization demo runbook

31 October 2026. Implements accepted D01-D18 in [DEMO-DECISIONS.md](DEMO-DECISIONS.md).
API/seed interface: [DEMO-API.md](DEMO-API.md). Organization A has two clinics;
Organization B has one. Labs and all external integrations remain outside this demo.

## Safety boundary and ownership

Main coordination chat reviews changes and owns all database execution and test
scheduling. On 31 October 2026, it successfully applied the provisioner, creating
both dedicated demo databases, separate roles, config and storage roots, and seeded
both organizations. The source profiler also succeeded in a read-only transaction.
The main chat reports 33 passing API/database verifier checks; detailed results
and browser acceptance remain owned by its verification record. Existing source
databases were not mutated by these scripts. This is synthetic local demonstration
tooling, not a production provisioning/backup system.

Run commands below from `D:\Projects\kb-dental-suite\api` on `saas/multi-clinic`.
Node 24 and the existing PostgreSQL 18 Windows service are prerequisites. Use
existing installed packages; no new dependencies are needed. Do not run the legacy
bootstrap, seed/reset or rehearsal-check scripts as part of this procedure.
`rehearsal-check.ts` mutates accounts and is not a safe profiler.

Target databases are fixed: `kb_org_demo_a` and `kb_org_demo_b`. The provisioner
never drops databases, truncates tables or overwrites unrelated existing data.
It creates unique owner/runtime role names and generated passwords per organization.
Role membership is not shared between organizations; runtime is non-owner and
NOBYPASSRLS. Existing development/test/rehearsal databases are never provisioning
targets. The script does not modify PUBLIC access on existing unrelated databases;
production cluster hardening remains separate work.

Runtime secrets/config/documents live only in the narrowly ignored directory
`api/.organization-demo-runtime/`. Do not copy that directory, URLs, passwords,
state JSON or login files into chat, screenshots, commits or generic diagnostics.
The provisioner uses a restrictive Windows directory ACL for the current SID, or
0700 directories/0600 files on Unix. These protections isolate from other accounts,
not from another process running as the same desktop user. They are not a
substitute for production service identities or off-host backup/key management.

## 1. Optional source pattern profiling

This step is optional and cannot supply fixture identities. `profile-demo-source.ts`
uses one `BEGIN READ ONLY` transaction, bounded timeouts and RLS enabled. It reads
clinic IDs internally, sets transaction-local clinic context and combines per-clinic
counts. No IDs or source rows are printed. Only allowlisted table counts, column
names/types and coarse document-size buckets are emitted. No source documents,
patient names, phones, UHIDs, dates of birth, notes or addresses leave the process.
It does not read or extract `migration/data` files.

Use explicitly selected existing source env files. The script never imports the
application's implicit env loader. For the rehearsal owner connection, PowerShell:

```powershell
node --import tsx --env-file=.env --env-file="$env:USERPROFILE/.kb-pms/owner.env" scripts/profile-demo-source.ts --source=rehearsal
```

This selects `REHEARSAL_OWNER_DATABASE_URL` from those env files. For a source whose
explicit env file provides `DATABASE_URL`, use:

```powershell
node --import tsx --env-file=<explicit-source-env> scripts/profile-demo-source.ts --source=database
```

The latter credential must be able to enumerate `clinics` and read all intended
tables under their RLS contexts. Ordinary app credentials lack registry access.
Missing privileges fail safely with a generic message and no partial summary.
Do not weaken source grants or disable RLS just to obtain a profile. It is acceptable
to omit profiling and use the independently fictional workflow fixtures.

Any resulting aggregate output is reference material only; do not paste confidential
source information or credential-bearing error messages into documentation. Source
statistics are not used to generate or copy actual patient rows.

## 2. Review the dry run

```powershell
node --import tsx scripts/provision-organization-demo.ts
```

Default is a non-mutating plan: it does not connect to PostgreSQL, read the superuser
file, create runtime directories or write provider probes. It describes dedicated
database creation and synthetic seeding. Backend seed module/migration must exist
before running the script; see `api/src/organization/seed.ts` and migration 0023.

Review these exact intended resources before apply:

| Organization | Database | Browser origin | Clinics |
| --- | --- | --- | --- |
| A (`org-a`) | `kb_org_demo_a` | `http://org-a.localhost:8101` | `a1` Riverside, `a2` Orchard |
| B (`org-b`) | `kb_org_demo_b` | `http://org-b.localhost:8102` | `b1` Meadow |

These are fictional names. Units have no independent process/database. Brand-wide
customer identity is shared only within the organization's database.

## 3. Apply after the main chat's review

The main coordination chat has already reviewed and executed this step successfully.
Commands remain here for reproducibility and ownership-validated recovery; do not
reset or recreate completed targets. No additional product approval of D01-D18 is needed.

```powershell
node --import tsx scripts/provision-organization-demo.ts --apply
```

Local connection settings: optional `PGHOST` (`localhost` or `127.0.0.1` only) and
`PGPORT` (5432 default). Administrative password comes from `PGSUPERPASS`, if already
securely supplied, otherwise the existing private
`~/.kb-pms/postgres-superuser.txt`. Never pass the password in the command line.
The provisioner does not load `.env` or `owner.env` implicitly.

Apply holds one advisory lock on its administrative connection across both target
operations. It persists protected per-organization generated state before creating
resources. Databases and roles receive matching operation ownership comments.
An existing DB without a matching state/comment/owner is refused. A completed
matching demo is validated and left unchanged, preserving interactive demo writes.
There is no reset flag. Incomplete matching runs may resume migration/seed/config
steps, reusing saved credentials rather than rotating passwords.

CREATE DATABASE cannot share a transaction with its ownership comment. A crash
between creation and comment deliberately leaves an unadoptable target: stop and
perform private ownership review, rather than dropping it or blindly adding a
marker. State corruption, lost state or changed config similarly requires review.
Generic failures name the safe phase only; raw SQL/driver errors are not printed.
Earlier successful organization creation remains available after a later failure.

Migrations are applied only to newly created/validated dedicated demo targets,
using the existing checksum-enforcing migrator. Existing source schemas/databases
are untouched. The full migration chain is required by organization migration 0023
(extensions/context helpers). The existing `kb_app` role must already exist; this
script does not rotate/create that shared legacy role. After migration, legacy
`kb_app` table/function access is removed in these target DBs. Runtime grants cover
`org_*` tables/functions plus `app_user_id()` needed by the housekeeping trigger.
Identity writes, immutable form/note/submission/audit changes and receipt deletion
are explicitly denied in addition to database triggers. Review and run actual
isolation checks before treating grant behavior as verified.

Per-organization files are:

- `app.env`: runtime URL, organization code/hostname, document root, sealing key and
  loopback/local cookie flags. Contains only that organization's runtime credentials.
- `owner.env`: maintenance URL, never loaded by the running server.
- `demo-logins.txt`: fictional usernames and generated demo password, for private
  local use. All six fictional users in one organization share this generated demo
  password; the other organization has a different generated value. Not production.
- `provision-state.json`: protected recovery state, including passwords. Do not edit
  or publish it. Keep it separate from runtime service configuration in production.
- `documents/`: isolated local writable root; no real provider integration.

## 4. Launch the reviewed organization servers

Open two local terminals from `api/` after successful provisioning. Do not load the
legacy `.env` at the same time. Node environment variables already present in the
shell override `--env-file`; use clean terminal environments without conflicting
DATABASE_URL/KB_ORGANIZATION_* values. Never inspect or print those variable values
as troubleshooting output. Runtime readiness must reject any mismatched identity.

```powershell
node --import tsx --env-file=.organization-demo-runtime/org-a/app.env src/organization-server.ts
```

```powershell
node --import tsx --env-file=.organization-demo-runtime/org-b/app.env src/organization-server.ts
```

The entrypoint supplies `buildOrganizationApp({db,code,hostname,documentRoot,
cookieSecure,logger})`. Config names are exactly `DATABASE_URL`,
`KB_ORGANIZATION_CODE`, `KB_ORGANIZATION_HOSTNAME`, `KB_DOCUMENT_ROOT`, `HOST`,
`PORT`, `KB_LOCAL_DEMO=1`, `COOKIE_SECURE=false`. The generated `KB_SECRETS_KEY`
is organization-specific if required by storage code. Do not supply owner credentials.
`KB_ORGANIZATION_HOSTNAME` includes the local port (`org-a.localhost:8101` or
`org-b.localhost:8102`) because the API pins the complete Host header and Origin.

Browse the origins in the table above, using separate organization hostnames.
`.localhost` normally resolves to loopback; verify the browser on this machine.
If explicit hostname mapping is needed, add only those loopback host mappings via
the authorized OS workflow. Different ports on `127.0.0.1` alone do not isolate cookies.
HTTP/insecure cookies are allowed only for this explicitly loopback-bound demo.
Stop the servers with Ctrl+C. Launch/reboot supervision, TLS and production hosting
are outside this script's scope.

## 5. Fictional fixture and verification checklist

Backend `seedOrganization()` owns stable admin/clinic/staff/permission/default/form
fixtures. Usernames: `admin`, `clinic-admin`, `doctor`, `doctor-one`, `reception`,
`accounts`. `admin` has administration and aggregate metrics permissions, with no
clinical grant. `doctor` spans all of A's clinics; `doctor-one`, reception, accounts
and clinic administrator use the first clinic only. Organization B remains separate.
Credentials are generated, not committed. Unit grant revocation must take effect
on the next authorized request.

`demo-organization-fixtures.ts` adds transactional, idempotent synthetic work marked
by `demo.fixture.v1` in each organization's audit. It creates three extra fictional
patients (`DEMO-A-001` through `003`, or `DEMO-B-001` through `003`), including two
family members with the intentionally non-contactable phone `0000000001`. The
first patient has first-clinic history and, in A, a separate second-clinic note and
appointment under the same identity. It adds an append-only note addendum, an
assigned form submission, non-overlapping same-doctor appointments, and clinic-local
receipts. No external service is called and no original clinic data is copied.

The initial provisioning completed before this additional workflow helper was
available. After checking the dedicated targets, the main chat separately invoked
`seedDemoWork()` for both demo organizations. Those fixtures are now seeded. A
completed provisioner intentionally returns without replaying new fixture helpers;
do not edit its completed state or regenerate credentials to force a replay.
Any future fixture addition needs a targeted, ownership-validated operation by the
main chat; the existing fixture marker makes this helper idempotent.

Seed additions, before interactive changes: A has collections INR 1,100 at A1 and
INR 900 at A2, total INR 2,000; B1 has INR 1,100. The first synthetic patient's A1
charge/payment is 1,200/800 (balance 400), A2 is 900/900 (balance 0). A second
patient has a 300/300 first-clinic receipt. Fixtures are dated on the seed day in
Asia/Kolkata; select a date range containing that day. These are fixture deltas,
not guaranteed total counts if the backend seed adds activity or the user edits.
Each organization also has the backend's two initial synthetic patients.

The main chat owns actual pass/fail results and deviations, including its
[API/database verifier](../api/scripts/verify-organization-demo.ts) and
[UI acceptance checklist](DEMO-UI-CHECKLIST.md). The table below is the scope
checklist, not a second verification result ledger:

| Check | Expected |
| --- | --- |
| Runtime identity | A/B public identity and readiness match configured organization |
| Org isolation | Wrong-host and other-org sessions/IDs denied; separate storage roots |
| Staff scopes | Admin cannot access clinical data; one-clinic doctor denied A2; two-clinic doctor allowed |
| Patient journey | Exact synthetic UHID discovery; one shared patient at A1/A2; histories remain scoped |
| Duplicates/version | Family phone permitted with confirmation; stale identity save returns 409 |
| Clinic context/diary | Writes carry explicit unit; second tab cannot redirect save; shared-doctor overlap denied |
| Forms | First-clinic assignment works; other clinic cannot submit; historical version retained |
| Notes | Addendum retained without overwriting finalized note |
| Overrides | Allowed contact/hours/chair override works; locked fees rejected; reset inherits |
| Billing | Issuing clinic preserved; receipt void audited; no cross-clinic collection |
| Metrics | Distinct org patient vs both-clinic activity; scoped totals reconcile with receipts |
| Documents | Synthetic upload/retrieval allowed only within authorized org/clinic scope |
| Viewports | Primary journey works at desktop and narrow viewport |
| Repeat provision | Matching completed resources unchanged; unowned existing target refused |

Run database tests only under main chat's serialization; never alongside another
suite run. No reset is authorized by this runbook. A later disposable-demo reset
requires explicit target/identity verification and separate scope; it must never
operate on source, rehearsal or shared test databases. A working local demo does
not establish production readiness or replace a verified off-host backup/restore.
