// Table types for Kysely. Hand-written to match migrations/; a column added
// there is added here in the same commit.
import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
// Maintained by the touch_row() trigger: readable, never written by the app.
type Managed<T> = ColumnType<T, never, never>;

interface Housekeeping {
  version: Managed<number>;
  created_at: Managed<Date>;
  updated_at: Managed<Date>;
  created_by: Managed<string | null>;
  updated_by: Managed<string | null>;
}

interface Tenant {
  id: Generated<string>;
  clinic_id: Generated<string>; // defaults to app_clinic_id()
}

export interface AppUsersTable extends Tenant, Housekeeping {
  username: string;
  display_name: string;
  password_hash: string;
  role_id: string;
  active: Generated<boolean>;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
}

export interface SessionsTable {
  token_hash: Buffer;
  clinic_id: Generated<string>;
  user_id: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  last_seen_at: Generated<Date>;
}

export interface PanelsTable extends Tenant, Housekeeping {
  name: string;
  active: Generated<boolean>;
}

export interface DoctorsTable extends Tenant, Housekeeping {
  user_id: string | null;
  name: string;
  registration_no: string | null;
  phone: string | null;
  email: string | null;
  active: Generated<boolean>;
}

export interface ChairsTable extends Tenant, Housekeeping {
  name: string;
  active: Generated<boolean>;
}

export interface PatientsTable extends Tenant, Housekeeping {
  uhid: string;
  full_name: string;
  gender: "Male" | "Female" | "Other" | null;
  date_of_birth: string | null;
  blood_group: string | null;
  occupation: string | null;
  marital_status: string | null;
  address: string | null;
  mobile: string | null;
  mobile_2: string | null;
  whatsapp: string | null;
  email: string | null;
  emergency_name: string | null;
  emergency_contact: string | null;
  emergency_relation: string | null;
  patient_type: Generated<"Normal" | "Panel">;
  panel_id: string | null;
  panel_category: "Serving" | "Pensioner" | null;
  card_id: string | null;
  referred_by: string | null;
  referred_by_type: string | null;
  registered_on: Generated<Date>;
  deleted_at: Date | null;
}

export interface AppointmentsTable extends Tenant, Housekeeping {
  patient_id: string | null;
  patient_name: string;
  mobile: string | null;
  starts_at: Timestamp;
  ends_at: Timestamp;
  reason: string;
  sub_type: string | null;
  doctor_id: string | null;
  chair_id: string | null;
  notes: string | null;
  status: Generated<AppointmentStatus>;
  checkin_at: Date | null;
  engaged_at: Date | null;
  checkout_at: Date | null;
  cancel_reason: string | null;
}

export interface AuditLogTable {
  id: Generated<string>;
  clinic_id: string;
  user_id: string | null;
  happened_at: Generated<Date>;
  table_name: string;
  row_id: string | null;
  action: "insert" | "update" | "delete";
  before_row: unknown;
  after_row: unknown;
}

export type AppointmentStatus = "Scheduled" | "Checked In" | "In Chair" | "Completed" | "Cancelled" | "No Show";

export interface DB {
  app_users: AppUsersTable;
  sessions: SessionsTable;
  panels: PanelsTable;
  doctors: DoctorsTable;
  chairs: ChairsTable;
  patients: PatientsTable;
  appointments: AppointmentsTable;
  audit_log: AuditLogTable;
}
