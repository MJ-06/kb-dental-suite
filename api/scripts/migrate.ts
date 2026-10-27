import { required } from "../src/env.js";
import { migrate } from "../src/migrator.js";

await migrate(required("OWNER_DATABASE_URL"));
console.log("Database is up to date.");
