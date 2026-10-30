// Applies pending migrations to kb_rehearsal (REHEARSAL_OWNER_DATABASE_URL).
import { required } from "../src/env.js";
import { migrate } from "../src/migrator.js";
await migrate(required("REHEARSAL_OWNER_DATABASE_URL"));
