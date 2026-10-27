// The one connection pool.
//
// Apps Script opened a spreadsheet on every call and read it whole. A pool
// keeps a handful of connections open and hands one to each request, which is
// why an indexed lookup here costs microseconds where the sheet cost seconds.
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "kbdental",
  user: process.env.PGUSER || "kb",
  password: process.env.PGPASSWORD || "",
  // A clinic has a handful of machines, not a thousand. A small pool keeps
  // the memory footprint on an office PC modest.
  max: Number(process.env.PGPOOLMAX || 10),
  idleTimeoutMillis: 30000,
  // A query that has not answered in fifteen seconds is not going to. Better
  // a clear error at the desk than a screen that hangs.
  statement_timeout: 15000
});

// A pooled client that dies in the background must not take the process with
// it. Postgres restarts, the network blips; the next request opens a new one.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Everything in one transaction, or none of it.
//
// This is the thing Sheets could not do. Saving a registration wrote a row,
// then maybe a panel column, then maybe queued a CRM lead — and a failure
// half way left the book in a state nobody had designed. Here the work either
// all lands or none of it does.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

// Who is doing this, for the audit log. Set per transaction so a trigger —
// or the action itself — can record it.
async function withUser(client, username) {
  await client.query("SELECT set_config('kb.username', $1, true)", [username || ""]);
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, tx, withUser, close };
