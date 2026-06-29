-- Study Center Management System — Database Schema
-- Matches DBPRD v1.0, with gender added to students per client request

CREATE TABLE IF NOT EXISTS students (
  student_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  gender            TEXT CHECK (gender IN ('Male', 'Female', 'Other')),
  dob               TEXT,
  phone             TEXT NOT NULL,
  whatsapp          TEXT,
  email             TEXT,
  aadhaar_number    TEXT,
  father_name       TEXT,
  mother_name       TEXT,
  emergency_contact TEXT,
  address           TEXT,
  joining_date      TEXT NOT NULL,
  leaving_date      TEXT,
  duration_hours    INTEGER NOT NULL,   -- SUM of hours across all active allocations (supports combo blocks)
  fee_structure_id  INTEGER,
  status            TEXT NOT NULL DEFAULT 'Active', -- Active | Suspended | Archived (Overdue is a billing_records status only)
  billing_start_month TEXT,                     -- 'YYYY-MM'
  
  -- New Admission Form fields
  form_number       TEXT,
  class             TEXT,
  parent_occupation TEXT,
  nationality       TEXT,
  religion          TEXT,
  goal              TEXT,
  photo_path        TEXT,
  address_village   TEXT,
  address_po        TEXT,
  address_ps        TEXT,
  address_district  TEXT,
  address_state     TEXT,
  address_pin       TEXT,
  education_history TEXT,
  
  remarks           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (fee_structure_id) REFERENCES fee_structures(fee_structure_id)
);

CREATE TABLE IF NOT EXISTS seats (
  seat_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_number  TEXT NOT NULL UNIQUE,    -- e.g. 1, 2, 3...
  section      TEXT NOT NULL,           -- e.g. A, B, C...
  active       INTEGER NOT NULL DEFAULT 1, -- 1 = enabled, 0 = disabled
  grid_x       INTEGER DEFAULT NULL,
  grid_y       INTEGER DEFAULT NULL,
  rotation     INTEGER NOT NULL DEFAULT 0,
  frame_id     TEXT DEFAULT NULL,
  created_at   TEXT NOT NULL
);

-- Most important table: every row is a single time-block allocation.
-- A "combo" student simply has 2+ active rows here. Nothing is ever deleted,
-- only marked active = 0 when reallocated (full history preserved).
CREATE TABLE IF NOT EXISTS seat_allocations (
  allocation_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL,
  seat_id        INTEGER NOT NULL,
  start_time     TEXT NOT NULL,  -- 'HH:MM' 24-hour
  end_time       TEXT NOT NULL,  -- 'HH:MM' 24-hour, may wrap past midnight (e.g. 22:00 -> 04:00)
  valid_from     TEXT NOT NULL,
  valid_to       TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id),
  FOREIGN KEY (seat_id) REFERENCES seats(seat_id)
);

CREATE TABLE IF NOT EXISTS fee_structures (
  fee_structure_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  hours_per_day      INTEGER NOT NULL UNIQUE,
  monthly_fee         REAL NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_records (
  billing_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL,
  billing_month  TEXT NOT NULL,  -- 'YYYY-MM'
  base_fee       REAL NOT NULL,
  admission_fee  REAL NOT NULL DEFAULT 0,

  
  fine_amount    REAL NOT NULL DEFAULT 0,
  amount_paid    REAL,
  due_amount     REAL NOT NULL DEFAULT 0,
  bill_number    TEXT,
  payment_mode   TEXT,           -- Cash | UPI | Other
  payment_date   TEXT,
  status         TEXT NOT NULL DEFAULT 'Due', -- Due | Paid | Overdue | Partial
  reminder_sent  INTEGER NOT NULL DEFAULT 0,  -- 0 = Not sent, 1 = Sent
  created_at     TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id)
);

CREATE TABLE IF NOT EXISTS audit_settings (
  setting_id                    INTEGER PRIMARY KEY CHECK (setting_id = 1), -- only one row ever
  audit_day                     INTEGER NOT NULL,
  fine_amount                   REAL NOT NULL,
  admission_fee                 REAL NOT NULL DEFAULT 0,
  partial_fine_amount           REAL NOT NULL DEFAULT 0,
  partial_exemption_months      INTEGER NOT NULL DEFAULT 0,
  suspension_threshold_months   INTEGER NOT NULL,
  updated_at                    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_id          INTEGER PRIMARY KEY CHECK (setting_id = 1), -- only one row ever
  institute_name       TEXT,
  institute_address    TEXT,
  institute_phone      TEXT,
  total_seats          INTEGER NOT NULL,
  section_size         INTEGER NOT NULL,
  operational_start_month TEXT,            -- 'YYYY-MM' when billing goes live
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  transaction_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id       TEXT UNIQUE,
  billing_id       INTEGER NOT NULL,
  amount_paid      REAL NOT NULL,
  bill_number      TEXT NOT NULL,
  payment_mode     TEXT NOT NULL,           -- Cash | UPI | Other
  payment_date     TEXT NOT NULL,           -- YYYY-MM-DD
  created_at       TEXT NOT NULL,
  FOREIGN KEY (billing_id) REFERENCES billing_records(billing_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_billing ON payment_transactions(billing_id);
CREATE INDEX IF NOT EXISTS idx_allocations_seat ON seat_allocations(seat_id, active);
CREATE INDEX IF NOT EXISTS idx_allocations_student ON seat_allocations(student_id, active);
CREATE INDEX IF NOT EXISTS idx_billing_student ON billing_records(student_id, billing_month);

CREATE TABLE IF NOT EXISTS registration_requests (
  request_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  gender                TEXT NOT NULL CHECK (gender IN ('Male', 'Female', 'Other')),
  dob                   TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  whatsapp              TEXT NOT NULL,
  email                 TEXT NOT NULL,
  aadhaar_number        TEXT NOT NULL,
  father_name           TEXT NOT NULL,
  mother_name           TEXT NOT NULL,
  emergency_contact     TEXT,
  address               TEXT NOT NULL,
  joining_date          TEXT NOT NULL,
  preferred_seat        TEXT NOT NULL,
  preferred_start_time  TEXT NOT NULL,
  preferred_end_time    TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'Pending',
  
  -- New Admission Form fields
  form_number           TEXT,
  class                 TEXT,
  parent_occupation     TEXT,
  nationality           TEXT,
  religion              TEXT,
  goal                  TEXT,
  photo_path            TEXT,
  address_village       TEXT,
  address_po            TEXT,
  address_ps            TEXT,
  address_district      TEXT,
  address_state         TEXT,
  address_pin           TEXT,
  education_history     TEXT,
  
  remarks               TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_settings (
  setting_id      INTEGER PRIMARY KEY CHECK (setting_id = 1),
  smtp_host       TEXT NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port       INTEGER NOT NULL DEFAULT 465,
  smtp_secure     INTEGER NOT NULL DEFAULT 1,
  sender_email    TEXT,
  sender_password TEXT,
  active          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS seat_override_logs (
  override_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id      INTEGER NOT NULL,
  proposed_seat   TEXT NOT NULL,
  allocated_seat  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  admin_name      TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reallocation_requests (
  request_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id            INTEGER NOT NULL,
  preferred_seat        TEXT NOT NULL,
  preferred_start_time  TEXT NOT NULL,
  preferred_end_time    TEXT NOT NULL,
  reason                TEXT,
  status                TEXT NOT NULL DEFAULT 'Pending', -- Pending | Approved | Rejected
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reallocation_requests_status ON reallocation_requests(status);

CREATE TABLE IF NOT EXISTS admins (
  admin_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_auth (
  student_id            INTEGER PRIMARY KEY,
  password_hash         TEXT NOT NULL,
  last_login            TEXT,
  password_changed_at   TEXT, -- NULL if temp password, timestamp when updated
  created_at            TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  user_type     TEXT NOT NULL, -- 'admin' | 'student'
  user_id       INTEGER,         -- student_id (null if admin)
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_edit_requests (
  request_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id        INTEGER NOT NULL,
  name              TEXT NOT NULL,
  gender            TEXT NOT NULL,
  dob               TEXT NOT NULL,
  phone             TEXT NOT NULL,
  whatsapp          TEXT,
  email             TEXT,
  aadhaar_number    TEXT,
  father_name       TEXT,
  mother_name       TEXT,
  emergency_contact TEXT,
  address           TEXT,
  form_number       TEXT,
  class             TEXT,
  parent_occupation TEXT,
  nationality       TEXT,
  religion          TEXT,
  goal              TEXT,
  address_village   TEXT,
  address_po        TEXT,
  address_ps        TEXT,
  address_district  TEXT,
  address_state     TEXT,
  address_pin       TEXT,
  education_history TEXT,
  photo_data        TEXT,
  status            TEXT NOT NULL DEFAULT 'Pending', -- 'Pending' | 'Approved' | 'Rejected'
  created_at        TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);