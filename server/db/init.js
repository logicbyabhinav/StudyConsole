const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const _bcryptImport = require("bcryptjs");
const bcrypt =
  _bcryptImport && typeof _bcryptImport.hashSync === "function"
    ? _bcryptImport
    : _bcryptImport.default || _bcryptImport;

const DATA_DIR = path.join(__dirname, "../../data");
const DB_PATH = path.join(DATA_DIR, "studycenter.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Initialize isolated student photo database
const PHOTOS_DB_PATH = path.join(DATA_DIR, "photos.db");
const photosDb = new Database(PHOTOS_DB_PATH);
photosDb.pragma("journal_mode = WAL");
photosDb.exec(`
  CREATE TABLE IF NOT EXISTS student_photos (
    student_id INTEGER PRIMARY KEY,
    photo_data TEXT NOT NULL
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function runMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrateStudentsTable();
  migrateBillingAndAuditSettingsTables();
  migrateAppSettingsTable();
  migratePaymentTransactionsTable();
}

function migratePaymentTransactionsTable() {
  const cols = db
    .prepare("PRAGMA table_info(payment_transactions)")
    .all()
    .map((c) => c.name);
  if (!cols.includes("payment_id")) {
    console.log(
      "[migration] Adding payment_id column to payment_transactions...",
    );
    db.exec("ALTER TABLE payment_transactions ADD COLUMN payment_id TEXT");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_payment_id ON payment_transactions(payment_id);",
    );

    // Backfill existing transactions
    const txs = db
      .prepare(
        "SELECT transaction_id FROM payment_transactions WHERE payment_id IS NULL",
      )
      .all();
    if (txs.length > 0) {
      console.log(
        `[migration] Backfilling ${txs.length} payment transactions with unique 10-digit payment IDs...`,
      );
      const updateStmt = db.prepare(
        "UPDATE payment_transactions SET payment_id = ? WHERE transaction_id = ?",
      );

      const usedIds = new Set();
      const runTx = db.transaction(() => {
        for (const tx of txs) {
          let pId;
          do {
            pId = String(Math.floor(1000000000 + Math.random() * 9000000000));
          } while (usedIds.has(pId));
          usedIds.add(pId);
          updateStmt.run(pId, tx.transaction_id);
        }
      });
      runTx();
    }
  }
}

// Adds new columns to app_settings for existing databases
function migrateAppSettingsTable() {
  const cols = db
    .prepare("PRAGMA table_info(app_settings)")
    .all()
    .map((c) => c.name);
  if (!cols.includes("operational_start_month")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN operational_start_month TEXT");
  }
}

// Migrates billing_records and audit_settings for the new billing features
function migrateBillingAndAuditSettingsTables() {
  // 1. Migrate billing_records
  const billingCols = db
    .prepare("PRAGMA table_info(billing_records)")
    .all()
    .map((c) => c.name);

  const addBillingCol = (name, definition) => {
    if (!billingCols.includes(name)) {
      db.exec(`ALTER TABLE billing_records ADD COLUMN ${name} ${definition}`);
    }
  };
  addBillingCol("admission_fee", "REAL NOT NULL DEFAULT 0");
  addBillingCol("due_amount", "REAL NOT NULL DEFAULT 0");
  addBillingCol("payment_mode", "TEXT");
  addBillingCol("note", "TEXT");
  addBillingCol("reminder_sent", "INTEGER NOT NULL DEFAULT 0");

  // 2. Migrate audit_settings
  const auditCols = db
    .prepare("PRAGMA table_info(audit_settings)")
    .all()
    .map((c) => c.name);

  const addAuditCol = (name, definition) => {
    if (!auditCols.includes(name)) {
      db.exec(`ALTER TABLE audit_settings ADD COLUMN ${name} ${definition}`);
    }
  };
  addAuditCol("admission_fee", "REAL NOT NULL DEFAULT 0");
  addAuditCol("partial_fine_amount", "REAL NOT NULL DEFAULT 0");
  addAuditCol("partial_exemption_months", "INTEGER NOT NULL DEFAULT 0");

  // 3. Migrate fee_structures — pending price change columns
  const feeCols = db
    .prepare("PRAGMA table_info(fee_structures)")
    .all()
    .map((c) => c.name);
  const addFeeCol = (name, definition) => {
    if (!feeCols.includes(name))
      db.exec(`ALTER TABLE fee_structures ADD COLUMN ${name} ${definition}`);
  };
  addFeeCol("pending_monthly_fee", "REAL");
  addFeeCol("pending_from", "TEXT"); // 'YYYY-MM' of the month the new price takes effect

  // 4. Migrate audit_settings — suspension waiver cutoff day
  const auditColsV2 = db
    .prepare("PRAGMA table_info(audit_settings)")
    .all()
    .map((c) => c.name);
  if (!auditColsV2.includes("suspension_waiver_day"))
    db.exec(
      "ALTER TABLE audit_settings ADD COLUMN suspension_waiver_day INTEGER",
    ); // null = disabled
}

// Upgrades an existing students table (old column names) to the v1 field list
// without losing data. Safe to run every startup — every step checks first.
function migrateStudentsTable() {
  const cols = () =>
    db
      .prepare("PRAGMA table_info(students)")
      .all()
      .map((c) => c.name);

  let current = cols();
  if (current.includes("full_name") && !current.includes("name")) {
    db.exec("ALTER TABLE students RENAME COLUMN full_name TO name");
  }
  current = cols();
  if (current.includes("admission_date") && !current.includes("joining_date")) {
    db.exec(
      "ALTER TABLE students RENAME COLUMN admission_date TO joining_date",
    );
  }

  current = cols();
  const addIfMissing = (name, definition) => {
    if (!current.includes(name))
      db.exec(`ALTER TABLE students ADD COLUMN ${name} ${definition}`);
  };
  addIfMissing("dob", "TEXT");
  addIfMissing("aadhaar_number", "TEXT");
  addIfMissing("mother_name", "TEXT");
  addIfMissing("emergency_contact", "TEXT");
  addIfMissing("leaving_date", "TEXT");
  addIfMissing("whatsapp", "TEXT");
  addIfMissing("email", "TEXT");
  addIfMissing("billing_start_month", "TEXT");
  addIfMissing("suspension_type", "TEXT");
  addIfMissing("suspension_reason", "TEXT");

  // New Admission Form fields
  addIfMissing("form_number", "TEXT");
  addIfMissing("class", "TEXT");
  addIfMissing("parent_occupation", "TEXT");
  addIfMissing("nationality", "TEXT");
  addIfMissing("religion", "TEXT");
  addIfMissing("goal", "TEXT");
  addIfMissing("photo_path", "TEXT");
  addIfMissing("address_village", "TEXT");
  addIfMissing("address_po", "TEXT");
  addIfMissing("address_ps", "TEXT");
  addIfMissing("address_district", "TEXT");
  addIfMissing("address_state", "TEXT");
  addIfMissing("address_pin", "TEXT");
  addIfMissing("education_history", "TEXT");

  // Data migration: 'Overdue' used to be a student-level status; it's now billing-only.
  // Any student still carrying it from before this change reverts to 'Active' — their
  // actual overdue billing records (and any resulting fine/suspension) are unaffected,
  // since those live in billing_records and are recomputed by the audit engine anyway.
  db.exec(`UPDATE students SET status = 'Active' WHERE status = 'Overdue'`);
}

function migrateRegistrationRequestsTable() {
  db.exec(`
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
      remarks               TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    )
  `);

  const cols = db
    .prepare("PRAGMA table_info(registration_requests)")
    .all()
    .map((c) => c.name);
  const addIfMissing = (name, definition) => {
    if (!cols.includes(name))
      db.exec(
        `ALTER TABLE registration_requests ADD COLUMN ${name} ${definition}`,
      );
  };

  addIfMissing("form_number", "TEXT");
  addIfMissing("class", "TEXT");
  addIfMissing("parent_occupation", "TEXT");
  addIfMissing("nationality", "TEXT");
  addIfMissing("religion", "TEXT");
  addIfMissing("goal", "TEXT");
  addIfMissing("photo_path", "TEXT");
  addIfMissing("address_village", "TEXT");
  addIfMissing("address_po", "TEXT");
  addIfMissing("address_ps", "TEXT");
  addIfMissing("address_district", "TEXT");
  addIfMissing("address_state", "TEXT");
  addIfMissing("address_pin", "TEXT");
  addIfMissing("education_history", "TEXT");
  addIfMissing("photo_data", "TEXT");
}

function migrateEmailSettingsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_settings (
      setting_id      INTEGER PRIMARY KEY CHECK (setting_id = 1),
      smtp_host       TEXT NOT NULL DEFAULT 'smtp.gmail.com',
      smtp_port       INTEGER NOT NULL DEFAULT 465,
      smtp_secure     INTEGER NOT NULL DEFAULT 1,
      sender_email    TEXT,
      sender_password TEXT,
      active          INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function init() {
  runMigrations();
  db.exec("DROP TABLE IF EXISTS refund_records;");
  migrateSeatLayout();
  migrateRegistrationRequestsTable();
  migrateEmailSettingsTable();
  migrateWhatsAppQueueTable();
  migrateReallocationRequestsTable();
  migrateProfileEditRequestsTable();
  bootstrapReallocationRequests();

  // Bootstrap single settings configuration rows with blank defaults.
  // This is a system schema requirement to prevent audit engine and settings API crashes.
  db.prepare(
    `
    INSERT OR IGNORE INTO app_settings (setting_id, institute_name, institute_address, institute_phone, total_seats, section_size, created_at)
    VALUES (1, 'My Study Center', '', '', 0, 0, ?)
  `,
  ).run(nowIso());

  db.prepare(
    `
    INSERT OR IGNORE INTO audit_settings (setting_id, audit_day, fine_amount, admission_fee, partial_fine_amount, partial_exemption_months, suspension_threshold_months, updated_at)
    VALUES (1, 28, 0, 0, 0, 0, 1, ?)
  `,
  ).run(nowIso());

  db.prepare(
    `
    INSERT OR IGNORE INTO email_settings (setting_id, smtp_host, smtp_port, smtp_secure, active)
    VALUES (1, 'smtp.gmail.com', 465, 1, 0)
  `,
  ).run();

  syncSeatSections();
  migrateAuthTables();
  initAttendance();
}

function migrateAuthTables() {
  // 1. Seed default admin if missing
  const adminExists = db
    .prepare("SELECT 1 FROM admins WHERE username = 'admin'")
    .get();
  if (!adminExists) {
    const passwordHash = bcrypt.hashSync("admin123", 10);
    db.prepare(
      "INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)",
    ).run("admin", passwordHash, nowIso());
    console.log("[db] Seeded default admin credentials: admin / admin123");
  }

  // 2. Backfill existing student auth table
  const students = db.prepare("SELECT student_id FROM students").all();
  const checkAuth = db.prepare(
    "SELECT 1 FROM student_auth WHERE student_id = ?",
  );
  const insertAuth = db.prepare(
    "INSERT INTO student_auth (student_id, password_hash, created_at) VALUES (?, ?, ?)",
  );

  db.transaction(() => {
    for (const student of students) {
      if (!checkAuth.get(student.student_id)) {
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const tempPassword = `Study@${randomNum}`;
        const passwordHash = bcrypt.hashSync(tempPassword, 10);
        insertAuth.run(student.student_id, passwordHash, nowIso());
        console.log(
          `[db] Backfilled student STC-${String(student.student_id).padStart(4, "0")} with temporary password: ${tempPassword}`,
        );
      }
    }
  })();
}

function syncSeatSections() {
  const appSettings = db
    .prepare(
      "SELECT total_seats, section_size FROM app_settings WHERE setting_id = 1",
    )
    .get();
  const sectionSize =
    (appSettings && appSettings.section_size) > 0
      ? appSettings.section_size
      : 10;
  const seats = db.prepare("SELECT * FROM seats").all();
  const updateStmt = db.prepare(
    "UPDATE seats SET section = ? WHERE seat_id = ?",
  );
  const tx = db.transaction(() => {
    for (const s of seats) {
      const seatNum = parseInt(s.seat_number, 10);
      if (!isNaN(seatNum)) {
        const idx = Math.floor((seatNum - 1) / sectionSize);
        const sect = String.fromCharCode(65 + idx);
        if (s.section !== sect) {
          updateStmt.run(sect, s.seat_id);
        }
      }
    }
  });
  tx();
}

function migrateSeatLayout() {
  const seatCols = db
    .prepare("PRAGMA table_info(seats)")
    .all()
    .map((c) => c.name);
  if (!seatCols.includes("grid_x")) {
    db.exec("ALTER TABLE seats ADD COLUMN grid_x INTEGER DEFAULT NULL");
  }
  if (!seatCols.includes("grid_y")) {
    db.exec("ALTER TABLE seats ADD COLUMN grid_y INTEGER DEFAULT NULL");
  }
  if (!seatCols.includes("rotation")) {
    db.exec("ALTER TABLE seats ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0");
  }
  if (!seatCols.includes("frame_id")) {
    db.exec("ALTER TABLE seats ADD COLUMN frame_id TEXT DEFAULT NULL");
  }

  // Check if there are any seats with NULL coordinates
  const seatsWithNull = db
    .prepare("SELECT COUNT(*) c FROM seats WHERE grid_x IS NULL")
    .get().c;
  const seats = db.prepare("SELECT * FROM seats").all();

  // If any seat has NULL grid_x, or if seat_number has non-digits, migrate them to sequential integer names & grid coords
  const needsMigration =
    seatsWithNull > 0 || seats.some((s) => isNaN(Number(s.seat_number)));

  if (needsMigration) {
    console.log(
      "Migrating seats to numerical labels and 12-column default grid coordinates...",
    );
    const tx = db.transaction(() => {
      // Sort them visually by section, seat_number to preserve original layout sequence during rename
      const sortedSeats = [...seats].sort((a, b) => {
        if (a.section !== b.section) return a.section.localeCompare(b.section);
        const aNum = parseInt(a.seat_number.replace(/\D/g, "")) || 0;
        const bNum = parseInt(b.seat_number.replace(/\D/g, "")) || 0;
        return aNum - bNum;
      });

      sortedSeats.forEach((s, idx) => {
        const newNumber = String(idx + 1);
        const gx = idx % 12;
        const gy = Math.floor(idx / 12);
        db.prepare(
          "UPDATE seats SET seat_number = ?, grid_x = ?, grid_y = ? WHERE seat_id = ?",
        ).run(newNumber, gx, gy, s.seat_id);
      });
    });
    tx();
    console.log(`Migrated ${seats.length} seats successfully.`);
  }
}

function migrateWhatsAppQueueTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_queue (
      queue_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id    INTEGER NOT NULL,
      phone         TEXT NOT NULL,
      message_type  TEXT NOT NULL,
      message_text  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'Pending',
      reference_id  INTEGER,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
    )
  `);

  // Create indexes for performance
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_whatsapp_queue_status ON whatsapp_queue(status);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_whatsapp_queue_student ON whatsapp_queue(student_id);",
  );

  // Bootstrap script: if whatsapp_queue is empty, populate with pending 'Dues' messages
  const count = db.prepare("SELECT COUNT(*) c FROM whatsapp_queue").get().c;
  if (count === 0) {
    console.log(
      "[db] Bootstrapping whatsapp_queue with existing unpaid dues...",
    );

    // Fetch all unpaid/partial/overdue bills with student name & contact
    const pendingBills = db
      .prepare(
        `
      SELECT br.*, s.name as student_name, s.phone, s.whatsapp
      FROM billing_records br
      JOIN students s ON s.student_id = br.student_id
      WHERE br.status IN ('Due', 'Partial', 'Overdue')
    `,
      )
      .all();

    // Query active seats for students to construct the dues reminder text
    const seatStmt = db.prepare(`
      SELECT DISTINCT se.seat_number
      FROM seat_allocations sa
      JOIN seats se ON se.seat_id = sa.seat_id
      WHERE sa.student_id = ? AND sa.active = 1
    `);

    const appSettings = db
      .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
      .get();
    const instituteName = appSettings?.institute_name || "StudySpace";

    const insertStmt = db.prepare(`
      INSERT INTO whatsapp_queue (
        student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at
      )
      VALUES (?, ?, 'Dues', ?, 'Pending', ?, ?, ?)
    `);

    const runTx = db.transaction(() => {
      for (const bill of pendingBills) {
        const seats = seatStmt.all(bill.student_id).map((r) => r.seat_number);
        const seatDisplay = seats.length > 0 ? seats.join(", ") : "N/A";

        // Month label helper
        const [y, m] = bill.billing_month.split("-");
        const monthLabel = new Date(+y, +m - 1, 1).toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        });

        const feeComponents = [];
        if (bill.base_fee > 0)
          feeComponents.push(`Base Fee: ₹${bill.base_fee}`);
        if (bill.admission_fee > 0)
          feeComponents.push(`Admission Fee: ₹${bill.admission_fee}`);
        if (bill.fine_amount > 0)
          feeComponents.push(`Late Payment Fine: ₹${bill.fine_amount}`);
        const componentsText = feeComponents.join(", ");

        const msgText = `Dear ${bill.student_name},\n\nThis is an official payment reminder from ${instituteName} regarding your allocated seat.\n\nOur records indicate the following outstanding dues:\n- ${monthLabel}: ₹${bill.due_amount} due (${componentsText})\n\nTo ensure uninterrupted access to your assigned seat, please clear these dues at the reception desk. If you have already made the payment, please share your receipt suffix code.\n\nThank you for your cooperation.\n\nBest regards,\n${instituteName} Management`;

        const contactPhone = bill.whatsapp || bill.phone;

        insertStmt.run(
          bill.student_id,
          contactPhone,
          msgText,
          bill.billing_id,
          nowIso(),
          nowIso(),
        );
      }
    });

    try {
      runTx();
      console.log(
        `[db] Bootstrapped ${pendingBills.length} pending dues reminders into whatsapp_queue.`,
      );
    } catch (err) {
      console.error("[db] Error bootstrapping whatsapp_queue:", err);
    }
  }
}

function migrateReallocationRequestsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reallocation_requests (
      request_id            INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id            INTEGER NOT NULL,
      preferred_seat        TEXT NOT NULL,
      preferred_start_time  TEXT NOT NULL,
      preferred_end_time    TEXT NOT NULL,
      reason                TEXT,
      status                TEXT NOT NULL DEFAULT 'Pending',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_reallocation_requests_status ON reallocation_requests(status);",
  );
}

function bootstrapReallocationRequests() {
  const count = db
    .prepare("SELECT COUNT(*) c FROM reallocation_requests")
    .get().c;
  if (count === 0) {
    const student = db
      .prepare(
        "SELECT student_id FROM students WHERE status = 'Active' LIMIT 1",
      )
      .get();
    if (student) {
      db.prepare(
        `
        INSERT INTO reallocation_requests (student_id, preferred_seat, preferred_start_time, preferred_end_time, reason, status, created_at, updated_at)
        VALUES (?, '25', '09:00', '15:00', 'Desire a seat closer to the window/air conditioner for better concentration.', 'Pending', ?, ?)
      `,
      ).run(student.student_id, nowIso(), nowIso());
      console.log(
        `[db] Seeded initial pending reallocation request for student_id: ${student.student_id}`,
      );
    }
  }
}

function migrateProfileEditRequestsTable() {
  const cols = db
    .prepare("PRAGMA table_info(profile_edit_requests)")
    .all()
    .map((c) => c.name);
  const addIfMissing = (name, definition) => {
    if (!cols.includes(name))
      db.exec(
        `ALTER TABLE profile_edit_requests ADD COLUMN ${name} ${definition}`,
      );
  };

  addIfMissing("form_number", "TEXT");
  addIfMissing("class", "TEXT");
  addIfMissing("parent_occupation", "TEXT");
  addIfMissing("nationality", "TEXT");
  addIfMissing("religion", "TEXT");
  addIfMissing("goal", "TEXT");
  addIfMissing("address_village", "TEXT");
  addIfMissing("address_po", "TEXT");
  addIfMissing("address_ps", "TEXT");
  addIfMissing("address_district", "TEXT");
  addIfMissing("address_state", "TEXT");
  addIfMissing("address_pin", "TEXT");
  addIfMissing("education_history", "TEXT");
  addIfMissing("photo_data", "TEXT");
}

// Create attendance_log table (migration-safe)
function initAttendance() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_log (
      date       TEXT NOT NULL,
      student_id INTEGER NOT NULL,
      logged_in_at TEXT NOT NULL,
      PRIMARY KEY (date, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_log(date);
  `);
}

module.exports = { db, photosDb, init, nowIso };
