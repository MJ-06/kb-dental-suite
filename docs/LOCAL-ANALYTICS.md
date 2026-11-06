# Local usage analytics

Umami3.4.1 is a separate service on http://127.0.0.1:8091, with its own
`kb_umami_review` database, restricted database role and private admin password.
The clinical application emits named screens/actions; it does not install a
tracking SDK. Session replay stays disabled. This is usage reporting, not the
clinical audit log, and cannot identify an individual using a shared account.

## This laptop

Private credentials: `api/.organization-demo-runtime/analytics/demo-logins.txt`.
No clinical passwords were changed. Start after a restart, from `api/`:

```powershell
& ./scripts/start-local-analytics.ps1
```

Start the protected clinical review separately with
`node --import tsx src/realdata-review-server.ts`. Its private app.env already
contains the local endpoint, website ID and HMAC salt. No public analytics tunnel
is created. Closing Umami must not prevent clinical saves.

## Reproduce on another laptop

Install the clinical prerequisites in ANOTHER-LAPTOP.md first. From `api/`, clone
the official source into the ignored runtime folder (do not vendor it into git):

```powershell
git clone --depth 1 --branch v3.4.1 https://github.com/umami-software/umami.git .organization-demo-runtime/analytics/umami
node --import tsx scripts/provision-local-analytics.ts --apply
cd .organization-demo-runtime/analytics/umami
npx --yes pnpm@12.3.4 install --frozen-lockfile --fetch-timeout=300000
```

The provisioner generates separate private credentials and a marked database;
it refuses unrelated databases. It patches the local copy to use system fonts
instead of downloading Google fonts. Telemetry and geo downloads are disabled
in the generated private .env. Build each prerequisite, then the production app:

```powershell
npx --yes pnpm@12.3.4 exec npm-run-all check:env build:db check:db build:tracker build:recorder build:geo build:openapi build:packages
npx --yes pnpm@12.3.4 exec next build --webpack
cd ../../..
node --import tsx scripts/initialize-local-analytics.ts
& ./scripts/start-local-analytics.ps1
```

The build includes Umami's recorder bundle; it is not loaded by the clinical app
and the configured website has recording disabled. Initial setup needs internet
access; operation uses loopback and PostgreSQL. Builds can take several minutes.
`initialize-local-analytics.ts --connect-review` connects only the specifically
marked local real-data review environment; do not run this flag without that setup.
For another deployment, set UMAMI_LOCAL_URL, UMAMI_WEBSITE_ID and UMAMI_EVENT_SALT
in its private environment, using the values from private analytics/state.json.
Restart that clinical service after changing its environment. Never commit it.

## Collection and operations

- `POST /api/v1/usage/screen`: authenticated, allowlisted screen name only.
- Registered `/exec` action completion emits action name, success and bounded
  duration after the transaction result; no parameter values or error text.
- Staff and clinic keys are HMAC pseudonyms, using a private installation salt.
- No patient identity, UHID, searches, form values, documents, actual URL/query,
  IP, real browser metadata, screenshots, replay or keystrokes are forwarded.
- Fixed hostname/paths and a coarse synthetic user agent prevent accidental
  browsing details from entering events. At most32 requests in flight,2s timeout;
  collection is best effort and may lose events when the service is unavailable.
- `GET /api/v1/usage/status` requires roles:manage; reports configuration only.

Back up/retain the analytics database separately; the clinical archive bundle
does not include it. No automated analytics retention or startup task has been
enabled. Keep the dashboard on loopback. Never reuse clinical credentials for it.
Set UMAMI_LOCAL_URL empty and restart the clinical service to disable collection.

Official references: [installation](https://docs.umami.is/docs/install),
[sending events](https://docs.umami.is/docs/api/sending-stats),
[environment configuration](https://docs.umami.is/docs/environment-variables).
