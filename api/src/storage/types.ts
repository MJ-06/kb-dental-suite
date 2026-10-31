// What every place a file can live must do. Callers hold a key ("<clinic uuid>/<file uuid>")
// and, for a backend that hands out its own ids (Drive), the ref that put() returned.
export type Kind = "local" | "s3" | "drive";

export interface PutOpts {
  /** A readable name, for backends a person browses (Drive). Never part of a path. */
  name?: string;
  mime?: string;
  /** Folders to file it under inside the backend (Drive): patient, then category. */
  folder?: string[];
}

export interface Backend {
  kind: Kind;
  /** Stores the bytes; returns the backend's own id for them, or null when the key is enough. */
  put(key: string, bytes: Buffer, opts?: PutOpts): Promise<string | null>;
  get(key: string, ref: string | null): Promise<Buffer>;
  /** Proves the backend can be written to and read from. Throws a sentence the admin can act on. */
  check(): Promise<string>;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(`^${UUID}/${UUID}$`);

/** A key is two uuids: nothing a user types ever becomes part of a path or URL. */
export function assertKey(key: string): void {
  if (!KEY.test(key)) throw new Error("invalid storage key");
}
