# KB PMS API

The multi-clinic backend: TypeScript on Node 24 LTS, Fastify, Kysely, and
PostgreSQL 18 with row level security. Design and review:
[KB Dental PMS: database review and multi-clinic architecture](https://claude.ai/artifact/Eb4jkEuheuLYFabAXjUYXV).

## How clinics are kept apart

- Every clinic-owned table has `clinic_id` and a **forced** RLS policy
  `clinic_id = app_clinic_id()`.
- The API connects as `kb_app`, which owns no tables and cannot bypass RLS.
- Each request is one transaction. `session_resume()` reads the cookie's
  session and sets `app.clinic_id` and `app.user_id` with `set_config(..., true)`,
  which lasts only for that transaction.
- No clinic set means no rows. A forgotten filter fails closed.
- Foreign keys include `clinic_id`, so a row cannot point at another clinic's row.

`test/isolation.test.ts` checks all of this through the API and directly in SQL.

## First run on a new machine

```bash
npm install
npm run db:bootstrap   # roles kb_owner + kb_app, databases kb_pms + kb_pms_test, writes .env
npm run db:migrate
npm test
npm run dev
```

`db:bootstrap` reads the PostgreSQL superuser password from
`~/.kb-pms/postgres-superuser.txt` or `PGSUPERPASS`.

## Migrations

`migrations/NNNN_name.sql`, applied in order, each in one transaction, as
`kb_owner`. An applied file is never edited; add a new one. `grants.sql` is
re-applied after every run. A new clinic table calls
`SELECT enable_tenant_table('name')`, which adds RLS, the version/audit
triggers and the policy in one go.

## API

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | public, 10 per minute per address |
| POST | `/api/v1/auth/logout` | signed in |
| GET | `/api/v1/auth/me` | signed in |
| GET | `/api/v1/patients?q=` | `patients:read` |
| GET | `/api/v1/patients/:id` | `patients:read` |
| POST | `/api/v1/patients` | `patients:write` (server assigns the UHID) |
| PATCH | `/api/v1/patients/:id` | `patients:write`, body `{version, changes}`; 409 if changed elsewhere |
