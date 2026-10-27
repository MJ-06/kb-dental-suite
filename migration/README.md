# Moving the data — the runbook

Three steps, in order, with a check after each. Nothing here touches the
clinic's sheets: every one of them only reads.

Do the whole thing **once as a rehearsal**, days before the real move, on a
throwaway database. The rehearsal is where the surprises are, and there are
always surprises.

---

## 1. Get the data out

Paste `export-sheets.gs` into the Apps Script editor of either book and run
`exportEverything`. It reads all four books by id and writes one JSON file
per tab into a new Drive folder called **KB Dental export &lt;date&gt;**.

Before that, run `countEverything` and **write the numbers down**. Those are
what step three checks against, and a number written down beforehand is
worth more than one read back afterwards.

Download the folder from Drive (right-click → Download), unzip it.

The clinic can carry on working the whole time. The export is a photograph
of a moment; anything typed after it is handled by the cutover below.

## 2. Put it in

```bash
cd migration
npm install

createdb kbdental
psql -d kbdental -f ../database/schema.sql
psql -d kbdental -f ../database/002-api.sql

node import.js ~/Downloads/"KB Dental export 2026-10-27 1430"
```

It runs as **one transaction**: either the clinic's data is in the database
or the database is untouched. There is no half.

It prints what it read and what it wrote, side by side, and marks every line
where the two differ with `!!`. Then it lists, grouped, every row it could
not place as it stood — and writes all of them in full to
`import-report.json` inside the export folder.

Rows are refused for real reasons, and each is worth reading:

- a register row whose UHID is in no book
- a receipt for a patient who does not exist
- a panel-book row with no panel named
- a date no reading of it makes sense of

Some rows are **mended rather than refused**, and the report says so:

- two bookings in one chair at one time — the second keeps its slot and
  loses its chair, for the desk to put right
- an appointment checked out that was never checked in — the earlier stamps
  are filled from the later one
- a cancellation with no reason recorded — gets one saying so
- two receipts with the same number — the later becomes `R-001-2`, so
  neither is lost
- a referrer kind the register spells its own way — becomes `Other`

Start from an **empty** database each time you run it. Patients, the
register and the lists upsert safely; receipts and bookings would repeat.

## 3. Prove it

```bash
node verify.js ~/Downloads/"KB Dental export 2026-10-27 1430"
```

It reads the export files again from scratch — it does not take the
importer's word for anything — and puts the two counts side by side. It
exits non-zero while anything is unmatched.

The line that decides the move is **total collected**. It has to match to
the rupee.

A mismatch is never a reason to guess. It is either a row listed in
`import-report.json` or a mapping that needs fixing, and both are findable.

## The documents

`patient_documents` rows come across pointing at Drive file ids. The files
themselves still have to come down into the folder `KB_DOCS_DIR` names, one
folder per patient, before anybody opens an X-ray from the new app. The
import report says this out loud.

---

## The cutover

The rehearsal has already been done, and the counts matched.

1. **Evening, after the last patient.** Run the export again. Fresh, so it
   includes everything typed that day.
2. Import it into the real database. Verify. Numbers match, or stop here
   — nothing has changed for the clinic yet.
3. Change one line: `KB_INSTANCE.scriptUrl` → `http://<clinic-pc>:8080/`.
4. **Next morning**, before the first patient: open the day sheet, search a
   patient, save a receipt, print a prescription.

If anything at all is wrong, change that one line back. The clinic is on
Sheets again in a minute, nothing has been lost, and the sheets have been
untouched the whole time — that is the point of reading them and never
writing to them.

Keep the sheets exactly as they are for a month. They cost nothing to keep
and they are the thing you compare against if a number ever looks odd.

## Testing the migration itself

```bash
createdb kbtest
psql -d kbtest -f ../database/schema.sql -f ../database/002-api.sql
PGDATABASE=kbtest node test/migration.test.js
```

It builds an export folder shaped like the clinic's — the same headings,
and the same awkward rows the sheets really contain — then imports and
verifies it. **It empties the database it is pointed at.**
