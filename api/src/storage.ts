// Where uploaded files live. Today a folder on the server's disk, one
// sub-folder per clinic; the same four calls can sit on S3-compatible
// storage later without the callers changing.
//
// A key is always "<clinic uuid>/<document uuid>": nothing a user types ever
// becomes part of a path, so a crafted file name cannot reach outside it.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read on each call so a test (or an operator) can point it elsewhere. */
export const documentRoot = () => process.env.DOCUMENT_DIR ?? join(homedir(), ".kb-pms", "documents");

function pathOf(key: string): string {
  if (!KEY.test(key)) throw new Error("invalid storage key");
  return join(documentRoot(), ...key.split("/"));
}

export const storage = {
  /** Written to a temporary name and renamed, so a half-written file is never read. */
  async put(key: string, bytes: Buffer): Promise<void> {
    const path = pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.part`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, path);
  },
  get(key: string): Promise<Buffer> {
    return readFile(pathOf(key));
  }
};
