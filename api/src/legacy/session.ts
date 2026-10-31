// Who is signed in on this device, for the greeting on the dashboard.
import { sql } from "kysely";
import { read, type ActionTable } from "./types.js";

export const session: ActionTable = {
  whoAmI: read(async (_p, { tx, actor }) => {
    const clinic = (await sql<{ name: string }>`SELECT name FROM clinic_profile()`.execute(tx)).rows[0]?.name ?? "";
    return { success: true, name: actor.displayName, role: actor.role, permissions: [...actor.permissions], clinic };
  })
};
