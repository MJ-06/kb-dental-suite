# What protects the app after sign-in

Plain-words summary of the four layers. Code references are for the developer.

1. **Sessions (who you are).** Signing in needs clinic code, username and password.
   The server then gives the browser a random token in a cookie that the page's own
   scripts cannot read (HttpOnly), that other sites cannot send (SameSite=Strict)
   and that only travels over HTTPS (Secure). The server keeps only a hash of the
   token, so a copy of the database cannot be used to sign in. A session lasts
   12 hours, and signing out ends it at once. Five wrong passwords pause that account
   for 15 minutes, and each address is limited to 10 sign-in attempts a minute.
   Wrong clinic, wrong user and wrong password all give the same answer.
   (`api/src/auth/`)
2. **Roles (what you may do).** Every action names the permission it needs, such as
   `finance:read` or `clinical:write`, and the server checks it before touching data.
   Reception cannot open collections; accounts cannot edit clinical notes. Hiding a
   button is not the protection, the server refusing is. The role list is a working
   default until Viveyk sends his. (`api/src/auth/permissions.ts`)
3. **Clinic isolation (whose data you see).** Every clinic table has PostgreSQL row
   level security, forced on, and the app's database role cannot switch it off. Each
   request tells the database which clinic it belongs to, and the database itself
   hides every other clinic's rows, so a bug in a screen cannot leak across clinics.
   Tests sign in as two clinics and try to read each other's data.
   (`api/migrations/0001_foundation.sql`, `api/test/isolation.test.ts`)
4. **Audit trail (what happened).** A database trigger records every insert, update
   and delete on every clinic table with who did it, when, and the row before and
   after. The app cannot skip it, because it runs inside the database. Receipts and
   consents cannot be deleted by the app; expenses are voided, not removed.

Also now in place: a Content-Security-Policy so only the page's own scripts run,
libraries served from the app itself instead of public CDNs, HTTPS-only cookies and
HSTS, and no embedding of the pages in other sites.

Not yet in place: a screen to view the audit trail, two-factor sign-in, automatic
password expiry, and encryption of stored attachments (depends on the hosting chosen).
