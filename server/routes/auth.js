const express = require("express");
const router = express.Router();
const { db, photosDb, nowIso } = require("../db/init");
const {
  hashPassword,
  comparePassword,
  createSession,
  deleteSession,
} = require("../services/auth");
const { broadcastChange } = require("../services/liveStream");
const { isTransitionMode } = require("../services/billingStartMonth");

// POST /api/student/login -> Authenticate and issue HttpOnly cookie
router.post("/login", (req, res) => {
  const { username, password, user_type } = req.body;
  if (!username || !password || !user_type) {
    return res
      .status(400)
      .json({ error: "Username, password, and user type are required." });
  }

  // Rate limit by IP to block brute-force attempts
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const { checkLoginRateLimit, recordFailedLogin, clearLoginAttempts } =
    req.app.locals.rateLimiter;
  const limitCheck = checkLoginRateLimit(ip);
  if (limitCheck.blocked) {
    return res.status(429).json({
      error: `Too many failed login attempts. Try again in ${Math.ceil(limitCheck.secsLeft / 60)} minute(s).`,
    });
  }

  try {
    if (user_type === "admin") {
      // Bug 11 fix: the old code branched on `username !== "admin"` which made the
      // top branch permanently unreachable (only "admin" exists) and stored null as
      // the session user_id for every real login. Now we always look up by username
      // and store admin_id correctly.
      const admin = db
        .prepare("SELECT * FROM admins WHERE username = ?")
        .get(username);
      if (!admin || !comparePassword(password, admin.password_hash)) {
        recordFailedLogin(ip);
        return res.status(401).json({ error: "Invalid admin credentials." });
      }
      clearLoginAttempts(ip);
      const session = createSession(admin.admin_id, "admin");
      res.setHeader(
        "Set-Cookie",
        `session_token=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`,
      );
      return res.json({ success: true, user_type: "admin" });
    } else if (user_type === "student") {
      let studentIdStr = username.trim().toUpperCase();
      if (studentIdStr.startsWith("STC-")) {
        studentIdStr = studentIdStr.replace("STC-", "");
      }
      const studentId = parseInt(studentIdStr, 10);
      if (isNaN(studentId)) {
        recordFailedLogin(ip);
        return res.status(401).json({
          error:
            "Invalid Student ID format. Use format 'STC-0006' or just numeric '6'.",
        });
      }

      const student = db
        .prepare("SELECT * FROM students WHERE student_id = ?")
        .get(studentId);
      if (!student || student.status === "Archived") {
        recordFailedLogin(ip);
        return res
          .status(401)
          .json({ error: "Student account not found or archived." });
      }

      const studentAuth = db
        .prepare("SELECT * FROM student_auth WHERE student_id = ?")
        .get(studentId);
      if (
        !studentAuth ||
        !comparePassword(password, studentAuth.password_hash)
      ) {
        recordFailedLogin(ip);
        return res.status(401).json({ error: "Invalid student credentials." });
      }

      // Check if they are still using temporary password (password_changed_at is null)
      const isTempPassword = studentAuth.password_changed_at === null;

      clearLoginAttempts(ip);
      const session = createSession(studentId, "student");
      res.setHeader(
        "Set-Cookie",
        `session_token=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
      );

      // Update last login
      db.prepare(
        "UPDATE student_auth SET last_login = ? WHERE student_id = ?",
      ).run(nowIso(), studentId);

      // Ensure attendance table exists (safe to run every time — no-ops if already created)
      db.exec(`
        CREATE TABLE IF NOT EXISTS attendance_log (
          date         TEXT NOT NULL,
          student_id   INTEGER NOT NULL,
          logged_in_at TEXT NOT NULL,
          PRIMARY KEY (date, student_id)
        );
        CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_log(date);
      `);

      // Mark attendance for today (idempotent — one row per student per day)
      const today = nowIso().slice(0, 10);
      db.prepare(
        "INSERT OR IGNORE INTO attendance_log (date, student_id, logged_in_at) VALUES (?, ?, ?)",
      ).run(today, studentId, nowIso());

      return res.json({
        success: true,
        user_type: "student",
        temp_password: isTempPassword,
      });
    } else {
      return res.status(400).json({ error: "Invalid user type." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout -> Clears cookie and session from DB
router.post("/logout", (req, res) => {
  const token = req.cookies.session_token;
  if (token) {
    deleteSession(token);
  }
  res.setHeader(
    "Set-Cookie",
    "session_token=; HttpOnly; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  );
  res.json({ success: true, message: "Logged out successfully." });
});

// GET /api/student/me -> Return details for student portal
router.get("/me", (req, res) => {
  if (
    req.session.user_type !== "student" &&
    req.session.user_type !== "admin"
  ) {
    return res.status(403).json({ error: "Access denied." });
  }

  const studentId = req.session.user_id;
  if (!studentId) {
    return res.status(400).json({ error: "Student ID missing from session." });
  }

  try {
    const student = db
      .prepare("SELECT * FROM students WHERE student_id = ?")
      .get(studentId);
    if (!student) {
      return res.status(404).json({ error: "Student profile not found." });
    }

    const photoRow = photosDb
      .prepare("SELECT photo_data FROM student_photos WHERE student_id = ?")
      .get(studentId);
    student.photo_data = photoRow ? photoRow.photo_data : null;

    // Active seat allocations
    const todayStr = new Date().toISOString().slice(0, 10);
    const allocations = db
      .prepare(
        `
      SELECT sa.*, se.seat_number
      FROM seat_allocations sa
      JOIN seats se ON se.seat_id = sa.seat_id
      WHERE sa.student_id = ? AND sa.active = 1
        AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
      ORDER BY sa.start_time
    `,
      )
      .all(studentId, todayStr, todayStr);

    // Ledger / Billing History — alias DB columns to what the portal JS expects
    const ledger = db
      .prepare(
        `
      SELECT
        billing_id, student_id, billing_month, bill_number,
        base_fee, admission_fee, fine_amount,
        base_fee AS monthly_fee,
        amount_paid, due_amount, status, payment_mode,
        payment_date AS paid_at,
        payment_date AS due_date,
        note, created_at
      FROM billing_records
      WHERE student_id = ?
      ORDER BY billing_month DESC
    `,
      )
      .all(studentId);

    // Timeline / Notices & Request logs
    const notices = db
      .prepare(
        `
      SELECT message_text as message, created_at, 'Notice' as type
      FROM whatsapp_queue
      WHERE student_id = ?
    `,
      )
      .all(studentId);

    const profileRequests = db
      .prepare(
        `
      SELECT 'Profile update request (' || status || ')' as message, created_at, 'ProfileEdit' as type
      FROM profile_edit_requests
      WHERE student_id = ?
    `,
      )
      .all(studentId);

    const seatRequests = db
      .prepare(
        `
      SELECT 'Seat change request (Seat ' || preferred_seat || '): ' || status as message, created_at, 'SeatChange' as type
      FROM reallocation_requests
      WHERE student_id = ?
    `,
      )
      .all(studentId);

    // Suspension events from remarks or suspension_reason field
    const suspensionLogs = [];
    if (student.suspension_reason && student.status === "Suspended") {
      suspensionLogs.push({
        message: `Your account was suspended. Reason: ${student.suspension_reason}`,
        created_at: student.updated_at || nowIso(),
        type: "Suspension",
      });
    }

    // Reactivation events inferred from active status + allocations
    if (student.status === "Active" && allocations.length > 0) {
      const latestAlloc = allocations.reduce((a, b) =>
        new Date(a.created_at) > new Date(b.created_at) ? a : b,
      );
      // Only show reactivation log if there was a prior suspension (leaving_date was set and cleared)
      const hadSuspension = db
        .prepare(
          `SELECT COUNT(*) as c FROM students WHERE student_id = ? AND suspension_type IS NOT NULL`,
        )
        .get(studentId);
      // Check audit log or remarks for evidence of a past suspension
      const remarksIndicateSuspension =
        student.remarks && student.remarks.includes("Suspended");
      if (remarksIndicateSuspension) {
        suspensionLogs.push({
          message: `Your account was reactivated. Seat(s) assigned: ${allocations.map((a) => `Seat ${a.seat_number} (${a.start_time}–${a.end_time})`).join(", ")}.`,
          created_at: latestAlloc.created_at,
          type: "Reactivation",
        });
      }
    }

    // Combine and sort by date descending
    const logs = [
      ...notices,
      ...profileRequests,
      ...seatRequests,
      ...suspensionLogs,
    ].sort((a, b) => {
      return new Date(b.created_at) - new Date(a.created_at);
    });

    // Pre-load transactions for all billing records so the portal receipt modal
    // needs no second HTTP call (avoids the /api/student/billing/:id/receipt round-trip)
    const transactions = {};
    for (const bill of ledger) {
      const txs = db
        .prepare(
          "SELECT * FROM payment_transactions WHERE billing_id = ? ORDER BY created_at ASC",
        )
        .all(bill.billing_id);
      if (txs.length) transactions[bill.billing_id] = txs;
    }

    const appSettings = db
      .prepare("SELECT institute_name FROM app_settings WHERE setting_id = 1")
      .get();

    res.json({
      student,
      allocations,
      ledger,
      logs,
      transactions,
      instituteName: appSettings?.institute_name || "StudySpace",
      inTransition: isTransitionMode(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/student/change-password
router.post("/change-password", (req, res) => {
  if (req.session.user_type !== "student") {
    return res.status(403).json({ error: "Access denied." });
  }

  const studentId = req.session.user_id;
  const { old_password, new_password } = req.body;

  if (!old_password || !new_password) {
    return res
      .status(400)
      .json({ error: "Old and new passwords are required." });
  }

  try {
    const authRecord = db
      .prepare("SELECT * FROM student_auth WHERE student_id = ?")
      .get(studentId);
    if (
      !authRecord ||
      !comparePassword(old_password, authRecord.password_hash)
    ) {
      return res.status(401).json({ error: "Incorrect current password." });
    }

    const hashed = hashPassword(new_password);
    db.prepare(
      `
      UPDATE student_auth
      SET password_hash = ?, password_changed_at = ?
      WHERE student_id = ?
    `,
    ).run(hashed, nowIso(), studentId);

    res.json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/student/edit-profile -> Create staging profile update request
router.post("/edit-profile", (req, res) => {
  if (req.session.user_type !== "student") {
    return res.status(403).json({ error: "Access denied." });
  }

  const studentId = req.session.user_id;
  const {
    name,
    gender,
    dob,
    phone,
    whatsapp,
    email,
    aadhaar_number,
    father_name,
    mother_name,
    emergency_contact,
    address,
    form_number,
    class: className,
    parent_occupation,
    nationality,
    religion,
    goal,
    address_village,
    address_po,
    address_ps,
    address_district,
    address_state,
    address_pin,
    education_history,
    photo_data,
  } = req.body;

  // Basic validation
  if (!name || !gender || !dob || !phone || !address) {
    return res.status(400).json({
      error: "Name, gender, date of birth, phone, and address are required.",
    });
  }

  try {
    const student = db
      .prepare("SELECT status FROM students WHERE student_id = ?")
      .get(studentId);
    if (!student || student.status !== "Active") {
      return res.status(403).json({
        error: "Profile updates are only allowed for active students.",
      });
    }

    // Overwrite any existing pending requests
    db.prepare(
      "DELETE FROM profile_edit_requests WHERE student_id = ? AND status = 'Pending'",
    ).run(studentId);

    // Insert new pending edit request
    db.prepare(
      `
      INSERT INTO profile_edit_requests (
        student_id, name, gender, dob, phone, whatsapp, email, aadhaar_number,
        father_name, mother_name, emergency_contact, address,
        form_number, class, parent_occupation, nationality, religion, goal,
        address_village, address_po, address_ps, address_district, address_state, address_pin,
        education_history, status, created_at, photo_data
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
    `,
    ).run(
      studentId,
      name.trim(),
      gender,
      dob,
      phone.trim(),
      whatsapp ? whatsapp.trim() : null,
      email ? email.trim() : null,
      aadhaar_number ? aadhaar_number.trim() : null,
      father_name ? father_name.trim() : null,
      mother_name ? mother_name.trim() : null,
      emergency_contact ? emergency_contact.trim() : null,
      address.trim(),
      form_number ? form_number.trim() : null,
      className ? className.trim() : null,
      parent_occupation ? parent_occupation.trim() : null,
      nationality ? nationality.trim() : null,
      religion ? religion.trim() : null,
      goal ? goal.trim() : null,
      address_village ? address_village.trim() : null,
      address_po ? address_po.trim() : null,
      address_ps ? address_ps.trim() : null,
      address_district ? address_district.trim() : null,
      address_state ? address_state.trim() : null,
      address_pin ? address_pin.trim() : null,
      education_history ? education_history.trim() : null,
      nowIso(),
      photo_data != null ? String(photo_data).trim() : null,
    );

    broadcastChange("registrations"); // Signal admin panel to refresh requests badge
    res.json({
      success: true,
      message: "Profile update request submitted for admin approval.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/student/request-seat -> Overwrites/creates pending reallocation request
router.post("/request-seat", (req, res) => {
  if (req.session.user_type !== "student") {
    return res.status(403).json({ error: "Access denied." });
  }

  const studentId = req.session.user_id;
  const { preferred_seat, preferred_start_time, preferred_end_time, reason } =
    req.body;

  if (!preferred_seat || !preferred_start_time || !preferred_end_time) {
    return res
      .status(400)
      .json({ error: "Seat number, start time, and end time are required." });
  }

  try {
    const student = db
      .prepare("SELECT status FROM students WHERE student_id = ?")
      .get(studentId);
    if (!student || student.status !== "Active") {
      return res.status(403).json({
        error: "Reallocation requests are only allowed for active students.",
      });
    }

    // Overwrite any existing pending reallocation request
    db.prepare(
      "DELETE FROM reallocation_requests WHERE student_id = ? AND status = 'Pending'",
    ).run(studentId);

    // Insert new pending reallocation request
    db.prepare(
      `
      INSERT INTO reallocation_requests (
        student_id, preferred_seat, preferred_start_time, preferred_end_time, reason, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?)
    `,
    ).run(
      studentId,
      preferred_seat.trim().toUpperCase(),
      preferred_start_time,
      preferred_end_time,
      reason ? reason.trim() : null,
      nowIso(),
      nowIso(),
    );

    broadcastChange("reallocations"); // Signal admin panel reallocations page
    res.json({
      success: true,
      message: "Seat change request submitted for admin review.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/student/billing/:id/receipt - Student-accessible receipt for their own billing record
router.get("/billing/:id/receipt", (req, res) => {
  if (
    req.session.user_type !== "student" &&
    req.session.user_type !== "admin"
  ) {
    return res.status(403).json({ error: "Access denied." });
  }
  const studentId = req.session.user_id;
  const billingId = parseInt(req.params.id, 10);
  if (!billingId) return res.status(400).json({ error: "Invalid billing ID." });

  try {
    // Ensure the billing record belongs to this student (security guard)
    const record = db
      .prepare(
        `
      SELECT br.*,
        s.name as student_name, s.phone as student_phone, s.whatsapp,
        s.father_name, s.student_id as sid
      FROM billing_records br
      JOIN students s ON s.student_id = br.student_id
      WHERE br.billing_id = ? AND br.student_id = ?
    `,
      )
      .get(billingId, studentId);

    if (!record) return res.status(404).json({ error: "Receipt not found." });

    const transactions = db
      .prepare(
        "SELECT * FROM payment_transactions WHERE billing_id = ? ORDER BY created_at ASC",
      )
      .all(billingId);

    const appSettings = db
      .prepare("SELECT institute_name FROM app_settings WHERE setting_id = 1")
      .get();
    res.json({
      record,
      transactions,
      instituteName: appSettings?.institute_name || "StudySpace",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
