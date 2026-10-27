// Loads settings with Node's own loader (no dotenv dependency):
//   api/.env                    what the running app needs (kb_app only)
//   ~/.kb-pms/owner.env         schema-owner credentials, for migrations,
//                               tests and onboarding; absent on a server
//                               that only runs the app
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ownerEnvFile = process.env.KB_OWNER_ENV ?? join(homedir(), ".kb-pms", "owner.env");

for (const file of [fileURLToPath(new URL("../.env", import.meta.url)), ownerEnvFile]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run npm run db:bootstrap, or copy .env.example to .env.`);
  return v;
}
