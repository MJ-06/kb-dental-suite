// Wipes this machine's development database and rebuilds it from the
// migrations. Refuses anything that is not on localhost.
import pg from "pg";
import { required } from "../src/env.js";
import { migrate } from "../src/migrator.js";

const url = required("OWNER_DATABASE_URL");
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`Refusing to wipe a database on ${host}`);
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await c.end();
await migrate(url);
console.log("Development database rebuilt. Run npm run db:seed for the kbdev clinic.");
