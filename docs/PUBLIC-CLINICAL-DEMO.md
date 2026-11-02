# Two-clinic public clinical review

This is the familiar clinical suite, served by the local TypeScript backend and
PostgreSQL, shared temporarily using Cloudflare Quick Tunnel. It is a synthetic
prototype, not a production migration or a completed CRM integration.

## Decisions checked

The approved demo decisions and latest user corrections already settle these:
organization isolation; central patient identity and existing visible UHID; clinic
care/doctor/material attribution; passive later linking; familiar entry screens;
existing Master password for Organization; labs and UI redesign deferred. No new
decision is needed to review the synthetic prototype. Older per-clinic database
proposals are superseded. Claude's research labeled Proposed/Needs live sheet is
evidence for review, not additional signed-off product decisions. Production data
reconciliation, ambiguous identity merges and cutover still require separate review.

## Access

The current URL is handed over in the main chat. Quick Tunnel URLs change when
restarted and work only while this laptop, PostgreSQL, the demo server and tunnel
are running. This is not permanent cloud hosting.

Private credentials: `api/.organization-demo-runtime/public-clinical/demo-logins.txt`.
Share that file privately with the reviewer; never commit it. Clinic code is
`demo-one`. `admin` and `doctor` can use both clinics. `doctor-one`, `reception`
and `accounts` are limited to the first clinic. Master/Finance/Reports test
passwords are in the same private file. Sign out before changing test users.

Dedicated database: `kb_public_clinical_demo`; dedicated runtime/owner roles,
documents directory and environment. No source patient rows or production provider
credentials were imported. Real AI, server PDF generation and storage-provider
configuration changes are disabled in this public profile. Synthetic data may be
edited by authenticated reviewers. Local development on port8080 is not tunneled.

## Review journeys

| Journey | Steps | Expected result |
|---|---|---|
| Familiar screens | Sign in as admin; open Dashboard, Patient Search, Appointments, Daysheet, Registration and Records | Existing layout and workflows remain; backend runs locally |
| Clinic selection | Use bottom-left Clinic to select Demo Riverside Clinic / Demo Orchard Clinic | Page reloads into selected clinic; no Google Sheets status indicator |
| One patient, two clinics | Search **Aster Demo Patient** in both clinics | Same central patient/UHID; no manual second registration |
| History | Open Aster's folder > Patient History; change clinic filter | Riverside/Orchard entries show clinic, recorded treating doctor and fictional material/lot fields |
| Passive linking | Use existing record-entry screens, then open the patient's history again | No mandatory new visit-first wizard; history reflects supported saved source records |
| Demographics | Edit a synthetic patient's occupation, referral and safety flags, save/reopen; clear flags and reopen | Master lists load; flags persist and can be cleared |
| Organization | Open Master using its test password, then Organization; save/reload a harmless synthetic change | Organization details persist; switching clinics clears the unlock |
| Scheduling | Create a fictional appointment using a new available slot; reopen and cancel it | Clinic-specific appointment persists and cancellation is visible; inspect break slots |
| Financial records | Open Finance using its test password; create a small fictional receipt/expense, reload and inspect | Records belong to the selected clinic; only use synthetic amounts |
| Documents | Upload a made-up text document through the existing patient document screen, then reopen | Stored in the dedicated demo document directory; no real patient files |
| Family search | Search Cedar Demo Patient / Juniper Demo Patient | Separate synthetic identities despite their shared household phone |
| Restricted doctor | Sign out, use doctor-one, search Aster and open History | One clinic selectable and only its permitted history visible |
| Reception/accounts | Sign out and test each role's available navigation/actions | Server permission checks apply; clinical history is not automatically granted by shared identity |
| Two tabs | Open same signed-in account in two tabs, switch clinic in one, attempt a write from the stale tab | Stale clinic context is rejected; refresh before continuing |

Automated public checks cover HTTP page binding, login, two-clinic grants, shared
identity/history, doctor/material attribution, Master unlock/reset, master-list
contracts, disabled external AI, restricted history and forged switching. Manual
journeys above remain a reviewer checklist, not a claim that every browser flow
has already passed. Care/consent/treatment mini-apps, embedded CRM and printing
need their own browser acceptance; CRM synchronization is not implemented.

Structured visit/material ledgers, item stock management and doctor/item analytics
are future backend slices. Current history summarizes the supported existing
records; this demo does not claim those future features are complete.

## Reproduce on another laptop

First follow `ANOTHER-LAPTOP.md` for Node/PostgreSQL/repository setup. From `api/`:

```powershell
node --import tsx scripts/provision-public-clinical-demo.ts
node --import tsx scripts/provision-public-clinical-demo.ts --apply
node --import tsx src/public-demo-server.ts
```

Provisioning defaults to dry run and creates a new isolated database only. It
refuses to overwrite an unexpected/incomplete existing database. Keep the server
running. Download official cloudflared from Cloudflare's downloads page, then in
a separate terminal, using its actual executable path:

```powershell
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8200 --protocol http2
```

Use the printed HTTPS URL, then verify from `api/`:

```powershell
node --import tsx scripts/verify-public-clinical-demo.ts https://YOUR-URL.trycloudflare.com
```

The verifier uses the private synthetic state file without printing credentials.
Stop only the dedicated tunnel/server processes to withdraw access. Never point
the public tunnel at the development database/server containing existing data.
