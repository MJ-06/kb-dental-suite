-- 0004 The clinic's own lists (the Master screen) and settings.
--
-- Every table here is a tenant table: each clinic has its own fee list,
-- medicines, reasons and timings. Lists keep an `active` flag instead of
-- being deleted, because history (a 2019 visit's doctor, an old fee) still
-- points at them.

ALTER TABLE doctors ADD COLUMN role text;

CREATE TABLE staff (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  user_id     uuid,
  name        text NOT NULL,
  role        text,
  phone       text,
  email       text,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES app_users (clinic_id, id)
);
CREATE UNIQUE INDEX staff_name ON staff (clinic_id, lower(name));
SELECT enable_tenant_table('staff');

-- Short lists: payment modes, dosages, frequencies, durations, medicine
-- notes, expense and document categories (a value each), and medicine
-- instructions and clinical note templates (a situation plus text and
-- category, kept in `data`).
CREATE TABLE pick_lists (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  list_name   text NOT NULL,
  value       text NOT NULL CHECK (length(trim(value)) > 0),
  data        jsonb,
  sort_order  integer NOT NULL DEFAULT 0,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);
CREATE UNIQUE INDEX pick_lists_value ON pick_lists (clinic_id, list_name, value);
SELECT enable_tenant_table('pick_lists');

CREATE TABLE appointment_reasons (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  name        text NOT NULL,
  steps       text[] NOT NULL DEFAULT '{}',   -- RCT: Access Opening, BMP, Obturation
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);
CREATE UNIQUE INDEX appointment_reasons_name ON appointment_reasons (clinic_id, lower(name));
SELECT enable_tenant_table('appointment_reasons');

-- Treatments & Fees: the price list shown on estimates.
CREATE TABLE treatments (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  name        text NOT NULL,
  department  text,
  fee         numeric(10,2) CHECK (fee >= 0),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);
CREATE UNIQUE INDEX treatments_name ON treatments (clinic_id, lower(name));
SELECT enable_tenant_table('treatments');

CREATE TABLE medicines (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id         uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  name              text NOT NULL,
  default_dosage    text,
  default_frequency text,
  sort_order        integer NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid
);
CREATE UNIQUE INDEX medicines_name ON medicines (clinic_id, lower(name));
SELECT enable_tenant_table('medicines');

CREATE TABLE implant_brands (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  name        text NOT NULL,
  sizes       text[] NOT NULL DEFAULT '{}',
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);
CREATE UNIQUE INDEX implant_brands_name ON implant_brands (clinic_id, lower(name));
SELECT enable_tenant_table('implant_brands');

CREATE TABLE panel_rates (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id      uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  panel_id       uuid NOT NULL,
  code           text NOT NULL,          -- the panel's own procedure code
  procedure      text,
  rate           numeric(10,2) CHECK (rate >= 0),
  classification text NOT NULL DEFAULT '',
  sort_order     integer NOT NULL DEFAULT 0,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  FOREIGN KEY (clinic_id, panel_id) REFERENCES panels (clinic_id, id) ON DELETE CASCADE
);
CREATE INDEX panel_rates_panel ON panel_rates (clinic_id, panel_id, sort_order);
SELECT enable_tenant_table('panel_rates');

-- Odds and ends with no table of their own: clinic profile, timings,
-- week offs, pad margins. One JSON value per key per clinic.
CREATE TABLE clinic_settings (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  key         text NOT NULL,
  value       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  UNIQUE (clinic_id, key)
);
SELECT enable_tenant_table('clinic_settings');

CREATE TABLE holidays (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id     uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  holiday_date  date NOT NULL,
  name          text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  UNIQUE (clinic_id, holiday_date)
);
SELECT enable_tenant_table('holidays');

-- A doctor's (or the clinic's) signature image, as the forms store it.
CREATE TABLE signatures (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  owner_name  text NOT NULL,
  image_data  text NOT NULL CHECK (image_data ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  UNIQUE (clinic_id, owner_name)
);
SELECT enable_tenant_table('signatures');
