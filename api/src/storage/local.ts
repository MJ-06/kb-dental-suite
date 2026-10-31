// A folder on the server's disk, one sub-folder per clinic. The default for every clinic.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertKey, type Backend } from "./types.js";

/** Read on each call so a test (or an operator) can point it elsewhere. The clinic cannot choose it. */
export const documentRoot = () => process.env.DOCUMENT_DIR ?? join(homedir(), ".kb-pms", "documents");

const pathOf = (key: string) => (assertKey(key), join(documentRoot(), ...key.split("/")));

export const localBackend: Backend = {
  kind: "local",
  /** Written to a temporary name and renamed, so a half-written file is never read. */
  async put(key, bytes) {
    const path = pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.part`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, path);
    return null;
  },
  get: (key) => readFile(pathOf(key)),
  async check() {
    const probe = "00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000";
    const bytes = Buffer.from("kb check");
    await this.put(probe, bytes);
    if (!(await this.get(probe, null)).equals(bytes)) throw new Error("The server folder returned different data than was written");
    return "Server folder works";
  }
};
