// What a permission is, and the starting roles a new clinic gets. Which
// permissions a person holds comes from their clinic's own role (the roles
// table), read each time a session is resumed, so an admin's change applies
// on the user's next click. Checked on every route before any data is read,
// so a screen lock is no longer the only thing between reception and the
// clinic's collection figures.
//
// WORKING DEFAULT (2026-10-28): the starting roles are the proposal in the review
// doc, used until Viveyk confirms the final list. They are only a seed: a
// clinic's roles are theirs to edit on the "Roles & access" page.

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
  "roles:manage",        // staff accounts, roles and what each role may do (an administrator)
  "audit:read",
  "reports:read"         // admin dashboards, reports and Excel exports (admin only)
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (s: string): s is Permission => (PERMISSIONS as readonly string[]).includes(s);

/** Shown on the Roles & access page, in this order. */
export const PERMISSION_INFO: readonly { id: Permission; group: string; label: string; about: string }[] = [
  { id: "patients:read", group: "Patients", label: "View patients", about: "Search and open patient records." },
  { id: "patients:write", group: "Patients", label: "Register and edit patients", about: "Register patients and change their details." },
  { id: "appointments:read", group: "Diary", label: "View the diary", about: "See appointments and blocked slots." },
  { id: "appointments:write", group: "Diary", label: "Book and change appointments", about: "Book, move, check in and cancel." },
  { id: "clinical:read", group: "Clinical", label: "View clinical records", about: "Forms, prescriptions, treatment plans, X-rays." },
  { id: "clinical:write", group: "Clinical", label: "Enter clinical records", about: "Fill in clinical forms, prescriptions and plans." },
  { id: "payments:collect", group: "Money", label: "Take payments", about: "Take a payment, print its receipt, see that patient's balance." },
  { id: "finance:read", group: "Money", label: "View finance", about: "Collections, day book, expenses and reports." },
  { id: "finance:write", group: "Money", label: "Edit finance", about: "Edit or cancel receipts, expenses and panel claims." },
  { id: "masters:write", group: "Setup", label: "Edit clinic setup", about: "Doctors, chairs, panels, fee lists, medicines." },
  { id: "reports:read", group: "Admin", label: "Admin reports", about: "Admin dashboards and Excel exports." },
  { id: "audit:read", group: "Admin", label: "System log", about: "Read the system log and mark failures resolved." },
  { id: "roles:manage", group: "Admin", label: "Roles & access", about: "Create staff logins and decide what every role may do. Holders are the clinic's administrators." }
];

export interface RoleTemplate { name: string; permissions: readonly Permission[] }

/** Copied into every new clinic's roles table. After that the clinic owns them. */
export const DEFAULT_ROLES: readonly RoleTemplate[] = [
  { name: "admin", permissions: PERMISSIONS },
  {
    name: "doctor",
    permissions: [
      "patients:read", "patients:write",
      "appointments:read", "appointments:write",
      "clinical:read", "clinical:write"
    ]
  },
  {
    name: "reception",
    permissions: [
      "patients:read", "patients:write",
      "appointments:read", "appointments:write",
      "payments:collect"
    ]
  },
  {
    name: "accounts",
    permissions: [
      "patients:read",
      "appointments:read",
      "payments:collect", "finance:read", "finance:write"
    ]
  }
];

export interface HasPermissions { permissions: ReadonlySet<Permission> }

export function can(who: HasPermissions, permission: Permission): boolean {
  return who.permissions.has(permission);
}
