// What each role may do. Checked on every route before any data is read,
// so a screen lock is no longer the only thing between reception and the
// clinic's collection figures.
//
// WORKING DEFAULT (2026-10-28): the proposal in the review doc, used until
// Viveyk confirms the final list. Changing it is a one-line edit here.
import type { Role } from "../db/schema.js";

export const PERMISSIONS = [
  "patients:read",
  "patients:write",
  "appointments:read",
  "appointments:write",
  "clinical:read",       // clinical forms, prescriptions, treatment plans, X-rays
  "clinical:write",
  "payments:collect",    // take a payment, print its receipt, see that patient's balance
  "finance:read",        // collections, day book, expenses, reports
  "finance:write",       // edit or cancel receipts, expenses, panel claims
  "masters:write",       // doctors, chairs, panels, fee lists, medicines
  "users:manage",        // staff accounts and roles
  "audit:read"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  doctor: [
    "patients:read", "patients:write",
    "appointments:read", "appointments:write",
    "clinical:read", "clinical:write"
  ],
  reception: [
    "patients:read", "patients:write",
    "appointments:read", "appointments:write",
    "payments:collect"
  ],
  accounts: [
    "patients:read",
    "appointments:read",
    "payments:collect", "finance:read", "finance:write"
  ]
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
