# The API server

The program that sits between the browser and PostgreSQL. It replaces
Apps Script and speaks exactly what Apps Script spoke, so the app itself
needs no change beyond one line of configuration.

## What runs on the clinic PC

Two things, and nothing else:

- **PostgreSQL 16** — the database.
- **Node 18 or newer** — to run this.

One dependency (`pg`). Everything else is Node's own. That is deliberate:
this has to keep running on a clinic PC, maintained by people who are not
programmers, and every package added is something that can need fixing on a
Tuesday morning.

## Setting it up

```bash
cd server
npm install

# Create the database and load the design.
createdb kbdental
psql -d kbdental -f ../database/schema.sql
psql -d kbdental -f ../database/002-api.sql

# Run it.
PGDATABASE=kbdental PGUSER=kb node src/server.js
```

It prints three lines at startup and the first one matters:

```
[startup] every action the app calls is implemented
[startup] connected to kbdental
[startup] listening on 0.0.0.0:8080
```

If any action the app calls is missing, it is **named at startup** rather
than discovered by a receptionist mid-task.

## Settings

| Variable | Default | What it is |
|---|---|---|
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | `localhost` `5432` `kbdental` `kb` | the database |
| `PORT` `HOST` | `8080` `0.0.0.0` | where it listens |
| `KB_ALLOWED_ORIGINS` | `https://kbdental.github.io,http://localhost:8000` | which pages may call it |
| `KB_DOCS_DIR` | `./documents` | where X-rays and scans are kept — **point the backup at this** |
| `KB_HTML_TO_PDF` | found automatically | a browser to print prescriptions with |
| `ANTHROPIC_API_KEY` | — | for SOAP notes and the patient chatbot |

## Pointing the app at it

In the page, one line:

```js
const SCRIPT_URL = (window.KB_INSTANCE && window.KB_INSTANCE.scriptUrl) || "";
```

`KB_INSTANCE.scriptUrl` is already configuration, so moving off Apps Script
is a config change, not a code change. Set it to
`http://<clinic-pc>:8080/` and the whole app is talking to PostgreSQL.

That also means the move is **reversible in one line**: point it back at
the `/exec` URL and the clinic is on Sheets again while whatever went wrong
is sorted out.

## Running the tests

They need a real PostgreSQL — nothing here is mocked, because a constraint
that would refuse a write at the desk has to refuse it in the tests too.

```bash
createdb kbtest
psql -d kbtest -f ../database/schema.sql -f ../database/002-api.sql
PGDATABASE=kbtest node test/actions.test.js
```

The suite **empties the database it is pointed at**. Never point it at the
clinic's own.

## How it is laid out

```
src/db.js                 the connection pool, and `tx()` — all or nothing
src/auth.js               sign-in, sessions, the three screen passwords
src/util.js               the conversions, done once each
src/registry.js           every action, and the list the app calls
src/server.js             HTTP, routing, and the batch
src/actions/masters.js    the clinic's lists
src/actions/patients.js   patients and registration
src/actions/appointments.js
src/actions/cases.js      multi-visit treatment
src/actions/clinical.js   the register, progress, the 21 forms, plans
src/actions/documents.js  X-rays, scans, the printed prescription
src/actions/finance.js    receipts, collections, outstanding, expenses
src/actions/crm.js        the lead inbox, and the CRM's own collections
src/actions/ai.js         SOAP notes and the chatbot
```
