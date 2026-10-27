// The contract today's screens speak: an action name plus loose parameters,
// answered with {success: true, ...} or {success: false, error}. Each legacy
// action is a small function over the same tenant transaction the REST
// routes use, so RLS, roles and the audit log apply to both alike.
import type { Permission } from "../auth/permissions.js";
import type { Actor, Tx } from "../db/index.js";

export type Params = Record<string, unknown>;
export type Result = { success: boolean; error?: string; [k: string]: unknown };

export interface Ctx {
  tx: Tx;
  actor: Actor;
}

export interface LegacyAction {
  /** null = any signed-in user. */
  permission: Permission | null;
  run: (p: Params, ctx: Ctx) => Promise<Result>;
}

export type ActionTable = Record<string, LegacyAction>;

export const read = (run: LegacyAction["run"], permission: Permission | null = null): LegacyAction => ({ permission, run });
export const write = (permission: Permission, run: LegacyAction["run"]): LegacyAction => ({ permission, run });

/** A refusal written for the desk; reported as {success:false, error}. */
export class DeskError extends Error {}
