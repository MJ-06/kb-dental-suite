// Google Drive as a clinic's file store, through the shared client in ../drive.
// Layout follows the Apps Script's: <root folder>/<UHID_Name>/<Category>/<file>,
// so staff who browse Drive see the folders they know. Files are private; the
// app is the only way to open them.
import { DriveClient, parseCredential } from "../drive/client.js";
import type { Backend } from "./types.js";
import { assertKey } from "./types.js";

export interface DriveConfig {
  /** Default "KB Dental - Patient Documents". Found by name, created if missing. */
  folderName?: string;
  /** Or an exact folder (needed for a Shared Drive folder, whose name may repeat). */
  folderId?: string;
}
export const DEFAULT_DRIVE_FOLDER = "KB Dental - Patient Documents";

const folderSafe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().slice(0, 100) || "Other";

export function driveBackend(cfg: DriveConfig, secret: unknown): Backend {
  const client = new DriveClient(parseCredential(secret));
  // Resolved once per backend instance; the promise is cached so two uploads at the
  // start cannot both create the folder.
  let root: Promise<string> | null = null;
  const rootFolder = () => (root ??= (cfg.folderId ? Promise.resolve(cfg.folderId) : client.ensureFolder(cfg.folderName || DEFAULT_DRIVE_FOLDER))
    .catch((e) => { root = null; throw e; }));
  const children = new Map<string, Promise<string>>();
  const child = (parent: string, name: string) => {
    const k = `${parent}/${name}`;
    let p = children.get(k);
    if (!p) { p = client.ensureFolder(name, parent).catch((e) => { children.delete(k); throw e; }); children.set(k, p); }
    return p;
  };

  return {
    kind: "drive",
    async put(key, bytes, opts = {}) {
      assertKey(key);
      let parent = await rootFolder();
      for (const f of opts.folder ?? []) parent = await child(parent, folderSafe(f));
      const name = folderSafe(opts.name ?? key.split("/")[1]!);
      return client.upload({ name, parentId: parent, mime: opts.mime || "application/octet-stream", bytes });
    },
    async get(_key, ref) {
      if (!ref) throw new Error("This file has no Google Drive id");
      return client.download(ref);
    },
    async check() {
      await client.ping();
      const id = await rootFolder();
      return `Google Drive works (folder ${id.slice(0, 6)}…)`;
    }
  };
}
