# Organization data archiving

Implemented 6 November 2026. Open **Master → Organization → Data Archiving**.
Use the existing Master password; the server also requires organization-management
access and `roles:manage`. One policy covers every clinic in the organization.

## Current review setup

The protected laptop review has migration0033, a private backup role and the
`KB Dental Review Archives` Windows task installed. The worker is running. Both
storage options are available; the user chose to configure the destination later.
Daily archives therefore remain **disabled**, with no destination connected and no
real-data archive upload performed. Current staff and Master passwords are unchanged.

Default editable values:23:00 in the organization's timezone,30 daily retention
days and12 monthly copies. The screen shows destination readiness, worker status,
recent attempts, errors and a manual **Archive now** action. Refresh status after
saving destination details; the worker checks them at its next minute tick.

## What a complete archive contains

- A PostgreSQL custom-format dump of the whole dedicated organization database,
  including all clinics, shared patient identities, clinical/financial/CRM records,
  configuration and audit history.
- All locally stored `patient_documents`, including soft-deleted references whose
  files are retained, and organization documents when their root is configured.
- A manifest with file sizes and SHA-256 checksums. The dump catalogue is checked
  using `pg_restore --list`; every copied document is checked against recorded
  size/checksum where available.

The database dump and document list use the same exported repeatable-read
snapshot. Opaque document keys are retained for restore; names are not used as
filesystem paths. Live records are never moved or deleted by archiving.

Mixed remote patient-document backends currently **fail the archive** with an
explicit error rather than producing a misleading complete copy. External URLs
that were never imported as files remain references in the database, not newly
downloaded attachments. Full stock/inventory or external integration backups are
not implied. Server env files, PostgreSQL roles and encryption keys are not in
`pg_dump`; keep the private recovery configuration separately.

## Storage choices

**Google Drive, direct upload:** enter a folder ID in Master. The operator supplies
an existing OAuth credential JSON file privately on the server, then sets
`ARCHIVE_DRIVE_CREDENTIAL_FILE` in the private worker env and restarts the task.
The existing `DriveCredential` OAuth shape uses `type`, `client_id`, `client_secret`
and `refresh_token`; never paste these into chat, Git or the Master folder field.
This feature does not add a self-service Google OAuth sign-in screen. A connected
account and writable destination are prerequisites, not already provisioned here.

Each verified bundle is packaged as a `.tar.gz` and streamed through a resumable
Drive upload. Remote size, MD5 and app-owned organization/run markers must match
before success is recorded. Retention moves only matching unchanged archive files
to Drive's bin; it does not alter folder permissions or permanently delete them.
Implementation references: [Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
and [file metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).

**Personal storage / Google Drive for Desktop folder:** enter the full existing
cloud-synced folder path. The worker creates `KB Dental Archives/<organization UUID>`
inside it and verifies the copied bundle. It reports **Folder copy verified; check
cloud sync**, because a local copy is not proof that the desktop sync client has
uploaded it. Paths inside this source repository and symlinks are refused.

Temporary working copies stay in a private operator-controlled staging directory.
No HTTP route lists or downloads their contents. A failed destination upload never
triggers retention of older successful copies. Failed/incomplete working copies
are retained for operator diagnosis, not automatically declared successful.

## Schedule and retention rules

The worker checks once a minute. After the configured local time it creates at
most one scheduled attempt for that local day. A restart can catch up today's
attempt after that time; it cannot recreate snapshots for missed days. A failed
scheduled attempt is visible and may be retried with Archive now after fixing it.
Manual archives are allowed even with the daily schedule disabled, once ready.

Keep every successful copy within the last N calendar days, plus the first
successful copy in each of the latest M represented calendar months. This is one
monthly retained copy, not a second full upload of the same bundle.0 monthly copies
disables monthly pinning; at least1 daily retention day is required. The newest
successful copy is always protected. Manual copies participate in the same policy.

Only after a new successful published copy exists does the worker expire older
copies. It checks the organization marker, exact UUID path, manifest/checksums
and (for Drive) stored file ownership markers before removal. Changed or damaged
copies stop expiration and raise `RETENTION_REVIEW_REQUIRED`. Expiration is logged.

## Operator setup on another laptop

Prerequisites: the existing dedicated organization installation, Node24,
PostgreSQL18 client tools and Windows `tar.exe`. All database clinics must be linked
to its one organization. Run from `api/`:

```powershell
node --import tsx scripts/configure-archive-worker.ts --apply
# For the marked protected review instead:
node --import tsx scripts/configure-archive-worker.ts --review --apply
```

Setup uses the existing local PostgreSQL operator credential to create a separate
non-superuser backup role. It can read this database across forced clinic RLS and
write archive job/status/audit rows; it cannot create roles or databases. The web
app retains its existing restricted role and never receives the backup password.
`PG_BIN` can override the PostgreSQL tool directory; `ARCHIVE_DIR` overrides private
staging. Setup preserves an existing worker configuration and never enables the
schedule unless explicitly requested with `--enable-defaults` (not used here).

The private worker env is under `~/.kb-pms/` for a normal install, or the ignored
review runtime for `--review`. Set `ORG_DOCUMENT_DIR` there if organization documents
exist outside the clinical document root. Configure a Drive credential file there
if using direct upload. For a one-off worker check:

```powershell
node --import tsx scripts/archive-worker.ts --config="ABSOLUTE_PRIVATE_ENV_PATH" --once
```

Install a hidden current-user logon task and start it:

```powershell
.\scripts\install-archive-task.ps1 -Config "ABSOLUTE_PRIVATE_ENV_PATH" -TaskName "KB Dental Organization Archives"
```

Choose a different task name for each organization. It runs while this user is
logged in and the laptop/PostgreSQL are available; it does not wake a powered-off
laptop. PostgreSQL advisory locking prevents concurrent workers from processing
the same database. Before retiring this setup, disable the named task and revoke
the dedicated backup role through the operator's database administration process.

## Verification and restore

```powershell
node --import tsx scripts/verify-archive.ts --config="ABSOLUTE_PRIVATE_ENV_PATH" --id="ARCHIVE_UUID"
```

For recovery, download/extract a Drive `.tar.gz`, or use the personal folder bundle.
Verify its manifest/checksums and restore `database.dump` into a **new isolated
database**, using `pg_restore --exit-on-error --no-owner --no-privileges`. Copy
`files/clinical/` into the configured clinical document root and
`files/organization/` into its organization document root. Apply the installation's
role grants, supply separately protected keys/configuration, invalidate restored
sessions, rebind worker settings and verify login, clinical/financial totals and
file reads before switching traffic. Never test restore over a running database.

## APIs and stored metadata

| Screen action | API | Storage |
|---|---|---|
| Load settings/history | GET `/api/v1/archives/` | `org_settings.archive_policy`, `org_archive_worker`, last40 `org_archive_runs` |
| Save schedule/destination | PUT `/api/v1/archives/policy` | Organization setting plus optimistic version check and `archive.policy_updated` audit |
| Archive now | POST `/api/v1/archives/runs` | Queued organization job; requires a ready live worker; one active job per organization |
| Worker execution | Local operator process | Private bundle + chosen destination; completion/expiration audit and safe error codes |

The browser never supplies database credentials or an archive download path.
RLS scopes all metadata to the current organization. No new `/exec` actions.

## Validation completed

15 focused archive tests pass, including a real custom-format dump/restore of a
fictional organization with two clinics and document checksums, using the dedicated
backup-role privilege model. Simulated OAuth/resumable upload, retention boundaries,
corruption refusal, policy concurrency and API permissions pass. Existing storage14
and clinical organization13 tests pass, each database file run separately.
TypeScript/build and browser Master checks pass. Browser verifies both destination
controls, saving the disabled default policy, online worker and blocked Archive now.
Screenshots contain no patient selection: `evidence/data-archiving-master.jpg` and
`evidence/data-archiving-policy.jpg`.

This is not a live Google-account upload acceptance or production-data restore
acceptance; destination configuration is deliberately deferred by the user.
