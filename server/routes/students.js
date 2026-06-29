const express = require("express");
const router = express.Router();
const { db, photosDb, nowIso } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");

function generatePaymentId(db) {
  while (true) {
    const pId = String(Math.floor(1000000000 + Math.random() * 9000000000));
    const duplicate = db
      .prepare("SELECT 1 FROM payment_transactions WHERE payment_id = ?")
      .get(pId);
    if (!duplicate) return pId;
  }
}

const {
  isSeatAvailable,
  durationHours,
  rangesOverlap,
  normalizeRange,
} = require("../services/seatAvailability");
const {
  isTransitionMode,
  getBillingStartMonth,
} = require("../services/billingStartMonth");
const { proposeSeat } = require("../services/allocator");

const REQUIRED_FIELDS = [
  ["name", "Name"],
  ["gender", "Gender"],
  ["dob", "Date of Birth"],
  ["phone", "Phone Number"],
  ["aadhaar_number", "Aadhaar Number"],
  ["father_name", "Father's Name"],
  ["mother_name", "Mother's Name"],
  ["address", "Address"],
];

// GET /api/students - list with their current active allocation(s) joined in
router.get("/", (req, res) => {
  const students = db
    .prepare("SELECT * FROM students ORDER BY created_at DESC")
    .all();

  const todayStr = new Date().toISOString().slice(0, 10);
  const allocStmt = db.prepare(`
    SELECT sa.*, se.seat_number
    FROM seat_allocations sa
    JOIN seats se ON se.seat_id = sa.seat_id
    WHERE sa.student_id = ? AND sa.active = 1
      AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
    ORDER BY sa.start_time
  `);

  const result = students.map((s) => ({
    ...s,
    allocations: allocStmt.all(s.student_id, todayStr, todayStr),
  }));

  res.json(result);
});

// GET /api/students/:id - full detail for the Student Details Drawer
router.get("/:id", (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE student_id = ?")
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found." });

  // Load isolated student photo if it exists
  const photoRow = photosDb
    .prepare("SELECT photo_data FROM student_photos WHERE student_id = ?")
    .get(student.student_id);
  student.photo_data = photoRow ? photoRow.photo_data : null;

  const allocations = db
    .prepare(
      `
    SELECT sa.*, se.seat_number
    FROM seat_allocations sa
    JOIN seats se ON se.seat_id = sa.seat_id
    WHERE sa.student_id = ?
    ORDER BY sa.active DESC, sa.created_at DESC
  `,
    )
    .all(student.student_id);

  const feeStructure = student.fee_structure_id
    ? db
        .prepare("SELECT * FROM fee_structures WHERE fee_structure_id = ?")
        .get(student.fee_structure_id)
    : null;

  // Payment status: most recent billing record (current month if it exists, else latest).
  const currentMonth = new Date().toISOString().slice(0, 7);
  const latestBilling =
    db
      .prepare(
        "SELECT * FROM billing_records WHERE student_id = ? AND billing_month = ?",
      )
      .get(student.student_id, currentMonth) ||
    db
      .prepare(
        "SELECT * FROM billing_records WHERE student_id = ? ORDER BY billing_month DESC LIMIT 1",
      )
      .get(student.student_id) ||
    null;

  res.json({
    ...student,
    allocations,
    feeStructure,
    paymentStatus: latestBilling
      ? latestBilling.status
      : "No billing record yet",
    latestBilling,
  });
});

// POST /api/students - create a student with full personal details + 1 or 2 time blocks
router.post("/", (req, res) => {
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
    joining_date,
    remarks,
    blocks,
    amount_paid,
    payment_mode,
    bill_number,
    billing_start_month,
    registration_id,
    form_number,
    class: studentClass,
    parent_occupation,
    nationality,
    religion,
    goal,
    photo_path,
    address_village,
    address_po,
    address_ps,
    address_district,
    address_state,
    address_pin,
    education_history,
  } = req.body;

  const missing = REQUIRED_FIELDS.filter(
    ([key]) => !req.body[key] || !String(req.body[key]).trim(),
  ).map(([, label]) => label);
  if (missing.length) {
    return res
      .status(400)
      .json({ error: `Missing required field(s): ${missing.join(", ")}.` });
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res
      .status(400)
      .json({ error: "At least one time block is required." });
  }
  if (blocks.length > 2) {
    return res
      .status(400)
      .json({ error: "A maximum of 2 time blocks is supported." });
  }

  // Re-validate every block against the LIVE database — never trust the client's earlier read,
  // since seat availability can change between when the admin looked and when they hit Save.
  const resolvedBlocks = [];
  for (const block of blocks) {
    const { start_time, end_time, seat_number } = block;
    if (!start_time || !end_time || !seat_number) {
      return res.status(400).json({
        error: "Each time block needs a start time, end time, and seat number.",
      });
    }

    const seat = db
      .prepare("SELECT * FROM seats WHERE seat_number = ? AND active = 1")
      .get(seat_number.trim().toUpperCase());
    if (!seat) {
      return res.status(400).json({
        error: `Seat "${seat_number}" does not exist or is disabled.`,
      });
    }

    if (!isSeatAvailable(seat.seat_id, start_time, end_time)) {
      return res.status(409).json({
        error: `Seat ${seat_number} is not available for ${start_time}–${end_time}. It may have just been taken — check the available list again.`,
      });
    }

    resolvedBlocks.push({
      seat_id: seat.seat_id,
      seat_number: seat.seat_number,
      start_time,
      end_time,
    });
  }

  if (resolvedBlocks.length === 2) {
    const r1 = normalizeRange(
      resolvedBlocks[0].start_time,
      resolvedBlocks[0].end_time,
    );
    const r2 = normalizeRange(
      resolvedBlocks[1].start_time,
      resolvedBlocks[1].end_time,
    );
    if (rangesOverlap(r1, r2)) {
      return res.status(400).json({
        error: "Time Block 1 and Time Block 2 overlap with each other.",
      });
    }
  }

  const totalHours = resolvedBlocks.reduce(
    (sum, b) => sum + durationHours(b.start_time, b.end_time),
    0,
  );

  if (totalHours < 4 || totalHours > 24) {
    return res.status(400).json({
      error: `Total duration is ${totalHours}h. Must be between 4 and 24 hours.`,
    });
  }

  const feeStructure = db
    .prepare(
      "SELECT * FROM fee_structures WHERE hours_per_day = ? AND active = 1",
    )
    .get(totalHours);
  if (!feeStructure) {
    return res.status(400).json({
      error: `No fee plan exists for ${totalHours} hours/day. Add one in Settings → Fee Structures first.`,
    });
  }

  const isOldStudent = !!req.body.is_old_student;
  const inTransition = isTransitionMode();

  // Validate admission payment details
  if (!isOldStudent) {
    if (
      amount_paid === undefined ||
      amount_paid === null ||
      isNaN(Number(amount_paid)) ||
      Number(amount_paid) < 0
    ) {
      return res
        .status(400)
        .json({ error: "Amount Paid must be a valid non-negative number." });
    }
    if (!payment_mode || !["Cash", "UPI", "Other"].includes(payment_mode)) {
      return res
        .status(400)
        .json({ error: "Payment Mode must be Cash, UPI, or Other." });
    }
    if (!bill_number || !/^\d{4,5}$/.test(String(bill_number).trim())) {
      return res
        .status(400)
        .json({ error: "Bill Number must be a 4 or 5 digit number." });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const effectiveJoiningDate = (joining_date && joining_date.trim()) || today; // auto-filled today, editable
  const timestamp = nowIso();

  const auditSettings = db
    .prepare("SELECT * FROM audit_settings WHERE setting_id = 1")
    .get();
  // If this is an old student, force admission fee to 0. New students (including self-registered requests) pay the admission fee
  const admissionFee = isOldStudent ? 0 : auditSettings?.admission_fee || 0;

  // Enforce minimum payment = admission fee for new students
  if (!isOldStudent) {
    if (Number(amount_paid) < admissionFee) {
      return res.status(400).json({
        error: `Minimum payment required is the admission fee of ₹${admissionFee}.`,
      });
    }
  }

  // Check duplicate bill number (only for new admissions)
  if (!isOldStudent) {
    const year = effectiveJoiningDate.slice(0, 4);
    const suffix = String(bill_number).trim();
    const duplicate = db
      .prepare(
        `
      SELECT 1 FROM billing_records WHERE bill_number LIKE ?
      UNION ALL
      SELECT 1 FROM payment_transactions WHERE bill_number LIKE ?
      LIMIT 1
    `,
      )
      .get(`${year}-%-${suffix}`, `${year}-%-${suffix}`);
    if (duplicate) {
      return res.status(400).json({
        error: `Bill number suffix ${suffix} has already been used in ${year}.`,
      });
    }
  }

  // Billing Start Month rules:
  // - Transition mode (old or new): starts on operational_start_month
  // - Normal mode: starts on joining/billing_start_month
  const billingStartMonth = inTransition
    ? getBillingStartMonth()
    : (billing_start_month && billing_start_month.trim()) ||
      effectiveJoiningDate.slice(0, 7);

  const expectedAmount = isOldStudent
    ? 0
    : feeStructure.monthly_fee + admissionFee;
  const dueAmount = isOldStudent
    ? 0
    : Math.max(0, expectedAmount - Number(amount_paid));

  const monthStr = effectiveJoiningDate.slice(0, 7);
  const formattedBillNo = isOldStudent
    ? null
    : `${monthStr}-${String(bill_number).trim()}`;

  let requestedSeat = null;
  if (registration_id) {
    try {
      const regReq = db
        .prepare(
          "SELECT preferred_seat FROM registration_requests WHERE request_id = ?",
        )
        .get(registration_id);
      if (regReq) {
        requestedSeat = regReq.preferred_seat;
      }
    } catch (e) {
      console.error(
        "[email] Error querying registration request for preferred seat:",
        e,
      );
    }
  }

  let generatedPaymentId = null;
  let billingId = null;
  let tempPassword = "";
  // Single transaction: 1 student row + 1-2 allocation rows + optional billing record, all or nothing.
  const insertAll = db.transaction(() => {
    const studentResult = db
      .prepare(
        `
        INSERT INTO students (
          name, gender, dob, phone, whatsapp, email, aadhaar_number, father_name, mother_name, emergency_contact,
          address, joining_date, duration_hours, fee_structure_id, status, billing_start_month, remarks,
          form_number, class, parent_occupation, nationality, religion, goal, photo_path,
          address_village, address_po, address_ps, address_district, address_state, address_pin, education_history,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        name.trim(),
        gender,
        dob,
        phone.trim(),
        whatsapp ? whatsapp.trim() : null,
        email ? email.trim() : null,
        aadhaar_number.trim(),
        father_name.trim(),
        mother_name.trim(),
        emergency_contact || null,
        address.trim(),
        effectiveJoiningDate,
        totalHours,
        feeStructure.fee_structure_id,
        billingStartMonth,
        remarks || null,
        form_number ? form_number.trim() : null,
        studentClass ? studentClass.trim() : null,
        parent_occupation ? parent_occupation.trim() : null,
        nationality ? nationality.trim() : null,
        religion ? religion.trim() : null,
        goal ? goal.trim() : null,
        photo_path ? photo_path.trim() : null,
        address_village ? address_village.trim() : null,
        address_po ? address_po.trim() : null,
        address_ps ? address_ps.trim() : null,
        address_district ? address_district.trim() : null,
        address_state ? address_state.trim() : null,
        address_pin ? address_pin.trim() : null,
        education_history
          ? typeof education_history === "string"
            ? education_history
            : JSON.stringify(education_history)
          : null,
        timestamp,
        timestamp,
      );

    const studentId = studentResult.lastInsertRowid;

    // Generate temporary student portal credentials
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    tempPassword = `Study@${randomNum}`;
    const { hashPassword } = require("../services/auth");
    const hashed = hashPassword(tempPassword);
    db.prepare(
      `
      INSERT INTO student_auth (student_id, password_hash, created_at)
      VALUES (?, ?, ?)
    `,
    ).run(studentId, hashed, timestamp);

    const insertAlloc = db.prepare(`
      INSERT INTO seat_allocations (student_id, seat_id, start_time, end_time, valid_from, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);
    for (const b of resolvedBlocks) {
      insertAlloc.run(
        studentId,
        b.seat_id,
        b.start_time,
        b.end_time,
        effectiveJoiningDate,
        timestamp,
      );

      // Check if the allocated seat differs from the recommended proposal and log it
      const proposal = proposeSeat(gender, b.start_time, b.end_time);
      if (proposal.proposed_seat && proposal.proposed_seat !== b.seat_number) {
        db.prepare(
          `
          INSERT INTO seat_override_logs (student_id, proposed_seat, allocated_seat, reason, admin_name, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        ).run(
          studentId,
          proposal.proposed_seat,
          b.seat_number,
          req.body.override_reason || req.body.reason || "Admin override",
          req.body.admin_name || "Admin",
          timestamp,
        );
      }
    }

    // Only create billing records for non-old students
    if (!isOldStudent) {
      // If in transition, the initial bill before the operational month is only for the admission fee!
      const baseFeeVal = inTransition ? 0 : feeStructure.monthly_fee;
      const dueAmountVal = inTransition ? 0 : dueAmount;
      const billingStatusVal = inTransition
        ? "Paid"
        : Number(amount_paid) >= expectedAmount
          ? "Paid"
          : Number(amount_paid) > 0
            ? "Partial"
            : "Due";

      const billingResult = db
        .prepare(
          `
        INSERT INTO billing_records (
          student_id, billing_month, base_fee, admission_fee, fine_amount,
          amount_paid, due_amount, bill_number, payment_mode, payment_date, status, created_at
        )
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          studentId,
          monthStr,
          baseFeeVal,
          admissionFee,
          Number(amount_paid),
          dueAmountVal,
          formattedBillNo,
          payment_mode,
          effectiveJoiningDate,
          billingStatusVal,
          timestamp,
        );

      billingId = billingResult.lastInsertRowid;

      if (Number(amount_paid) > 0) {
        generatedPaymentId = generatePaymentId(db);
        db.prepare(
          `
          INSERT INTO payment_transactions (
            payment_id, billing_id, amount_paid, bill_number, payment_mode, payment_date, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          generatedPaymentId,
          billingId,
          Number(amount_paid),
          formattedBillNo,
          payment_mode,
          effectiveJoiningDate,
          timestamp,
        );
      }
    }

    // Clean up registration request if approved from form queue
    if (registration_id) {
      db.prepare("DELETE FROM registration_requests WHERE request_id = ?").run(
        registration_id,
      );
    }

    return studentId;
  });

  try {
    const studentId = insertAll();

    // Save compressed student photo in isolated photos database
    if (req.body.photo_data && req.body.photo_data.trim() !== "") {
      photosDb
        .prepare(
          "INSERT OR REPLACE INTO student_photos (student_id, photo_data) VALUES (?, ?)",
        )
        .run(studentId, req.body.photo_data.trim());
    }

    // Send welcome email asynchronously
    if (email && email.trim() !== "") {
      const {
        sendWelcomeEmail,
        sendRequestWelcomeEmail,
      } = require("../services/emailService");

      if (isOldStudent) {
        // Send a clean welcome email confirming their go-live billing start month, omitting any invoice table
        sendRequestWelcomeEmail(
          {
            student_id: studentId,
            name,
            email,
            joining_date: effectiveJoiningDate,
            duration_hours: totalHours,
          },
          billingStartMonth,
          requestedSeat,
          tempPassword,
        ).catch((err) => {
          console.error("[email] Error sending welcome email:", err);
        });
      } else {
        // Normal admission: send the invoice table welcome email
        const studentDataForEmail = {
          student_id: studentId,
          name,
          email,
          joining_date: effectiveJoiningDate,
          duration_hours: totalHours,
        };
        const billDataForEmail = {
          payment_id: generatedPaymentId,
          bill_number: formattedBillNo,
          base_fee: feeStructure.monthly_fee,
          admission_fee: admissionFee,
          amount_paid: Number(amount_paid),
          due_amount: dueAmount,
        };
        sendWelcomeEmail(
          studentDataForEmail,
          billDataForEmail,
          requestedSeat,
          tempPassword,
        ).catch((err) => {
          console.error("[email] Error sending welcome email:", err);
        });
      }
    }

    // Insert welcome WhatsApp message into queue
    try {
      const appSettings = db
        .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
        .get();
      const instituteName = appSettings?.institute_name || "StudySpace";

      const seatList = resolvedBlocks
        .map((b) => `Seat ${b.seat_number}`)
        .join(", ");
      const shifts = resolvedBlocks
        .map((b) => `${b.start_time} - ${b.end_time}`)
        .join(", ");
      const shiftDisplay = `${totalHours} hours/day (${shifts})`;

      const welcomeMsg = `Dear ${name.trim()},\n\nWelcome to ${instituteName}. We are pleased to confirm your admission. Your seat and shift timings have been successfully configured:\n- Student ID: STC-${String(studentId).padStart(4, "0")}\n- Joining Date: ${effectiveJoiningDate}\n- Assigned Seat: ${seatList}\n- Study Shift: ${shiftDisplay}\n\nPlease feel free to reach out to the front desk if you have any questions. We wish you the very best in your studies.\n\nBest regards,\n${instituteName} Management`;

      const contactPhone = whatsapp ? whatsapp.trim() : phone.trim();

      db.prepare(
        `
        INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
        VALUES (?, ?, 'Welcome', ?, 'Pending', NULL, ?, ?)
      `,
      ).run(studentId, contactPhone, welcomeMsg, timestamp, timestamp);

      // Insert receipt WhatsApp message into queue if payment was made
      if (!isOldStudent && Number(amount_paid) > 0 && billingId) {
        const dueAmountVal = inTransition ? 0 : dueAmount;
        const receiptMsg = `Dear ${name.trim()},\n\nThank you for your payment. We have successfully recorded your transaction. Here is your receipt summary:\n- Payment ID: ${generatedPaymentId}\n- Receipt/Bill No: ${formattedBillNo}\n- Payment Date: ${effectiveJoiningDate}\n- Payment Mode: ${payment_mode}\n- Amount Paid: ₹${Number(amount_paid)}\n- Remaining Balance: ₹${dueAmountVal}\n\nPlease preserve this receipt for your records.\n\nBest regards,\n${instituteName} Management`;

        db.prepare(
          `
          INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
          VALUES (?, ?, 'Receipt', ?, 'Pending', ?, ?, ?)
        `,
        ).run(
          studentId,
          contactPhone,
          receiptMsg,
          billingId,
          timestamp,
          timestamp,
        );
      }
    } catch (e) {
      console.error("[whatsapp] Error queuing welcome/receipt messages:", e);
    }

    broadcastChange("students", `New student admitted: ${name.trim()}`);
    broadcastChange("allocations");
    broadcastChange("messages"); // Notify messages panel of new queued items
    res.status(201).json({
      student_id: studentId,
      message: "Student admitted successfully.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save student. " + err.message });
  }
});

// PUT /api/students/:id - edit personal/family/address details + remarks.
// Only allowed while Active — seat/shift/duration changes go through reallocation, not here.
router.put("/:id", (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE student_id = ?")
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found." });
  if (student.status !== "Active") {
    return res.status(400).json({
      error: `Cannot edit a student who is currently ${student.status}.`,
    });
  }

  const body = req.body || {};
  const missing = REQUIRED_FIELDS.filter(([key]) => !body[key]).map(
    ([, label]) => label,
  );
  if (missing.length) {
    return res.status(400).json({
      error: `Please fill in all required fields: ${missing.join(", ")}.`,
    });
  }

  db.prepare(
    `
    UPDATE students SET
      name = ?, gender = ?, dob = ?, phone = ?, whatsapp = ?, email = ?, aadhaar_number = ?,
      father_name = ?, mother_name = ?, emergency_contact = ?, address = ?, remarks = ?,
      form_number = ?, class = ?, parent_occupation = ?, nationality = ?, religion = ?, goal = ?, photo_path = ?,
      address_village = ?, address_po = ?, address_ps = ?, address_district = ?, address_state = ?, address_pin = ?, education_history = ?,
      updated_at = ?
    WHERE student_id = ?
  `,
  ).run(
    body.name.trim(),
    body.gender,
    body.dob,
    body.phone.trim(),
    body.whatsapp ? body.whatsapp.trim() : null,
    body.email ? body.email.trim() : null,
    body.aadhaar_number.trim(),
    body.father_name.trim(),
    body.mother_name.trim(),
    (body.emergency_contact || "").trim() || null,
    body.address.trim(),
    (body.remarks || "").trim() || null,
    body.form_number ? body.form_number.trim() : null,
    body.class ? body.class.trim() : null,
    body.parent_occupation ? body.parent_occupation.trim() : null,
    body.nationality ? body.nationality.trim() : null,
    body.religion ? body.religion.trim() : null,
    body.goal ? body.goal.trim() : null,
    body.photo_path ? body.photo_path.trim() : null,
    body.address_village ? body.address_village.trim() : null,
    body.address_po ? body.address_po.trim() : null,
    body.address_ps ? body.address_ps.trim() : null,
    body.address_district ? body.address_district.trim() : null,
    body.address_state ? body.address_state.trim() : null,
    body.address_pin ? body.address_pin.trim() : null,
    body.education_history
      ? typeof body.education_history === "string"
        ? body.education_history
        : JSON.stringify(body.education_history)
      : null,
    nowIso(),
    student.student_id,
  );

  // Update or delete student photo in isolated database
  if (body.hasOwnProperty("photo_data")) {
    if (body.photo_data && body.photo_data.trim() !== "") {
      photosDb
        .prepare(
          "INSERT OR REPLACE INTO student_photos (student_id, photo_data) VALUES (?, ?)",
        )
        .run(student.student_id, body.photo_data.trim());
    } else {
      photosDb
        .prepare("DELETE FROM student_photos WHERE student_id = ?")
        .run(student.student_id);
    }
  }

  broadcastChange("students", `Student details updated: ${body.name.trim()}`);
  broadcastChange("allocations");
  res.json({ message: "Student details updated." });
});

// POST /api/students/:id/suspend - manual suspension (discipline, planned leave,
// non-payment override, etc). Deactivates active seat allocation(s), stops billing.
router.post("/:id/suspend", (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE student_id = ?")
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found." });
  if (student.status !== "Active") {
    return res.status(400).json({
      error: `Cannot suspend a student who is currently ${student.status}.`,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) {
    return res
      .status(400)
      .json({ error: "Reason for suspension is mandatory." });
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE students SET status = 'Suspended', leaving_date = ?, suspension_type = 'admin', suspension_reason = ?, updated_at = ? WHERE student_id = ?`,
    ).run(today, reason.trim(), nowIso(), student.student_id);
    db.prepare(
      `UPDATE seat_allocations SET active = 0, valid_to = ? WHERE student_id = ? AND active = 1`,
    ).run(today, student.student_id);
    if (reason) {
      const existingRemarks = student.remarks ? student.remarks + " | " : "";
      db.prepare(`UPDATE students SET remarks = ? WHERE student_id = ?`).run(
        `${existingRemarks}Suspended ${today}: ${reason.trim()}`,
        student.student_id,
      );
    }
  });

  try {
    tx();
    broadcastChange("students", `Student suspended: ${student.name}`);
    broadcastChange("allocations");

    // Send suspension email asynchronously
    if (student.email && student.email.trim() !== "") {
      const { sendSuspensionEmail } = require("../services/emailService");
      sendSuspensionEmail(student, reason.trim()).catch((err) => {
        console.error("[email] Error sending suspension email:", err);
      });
    }

    // Insert suspension WhatsApp message into queue
    try {
      const appSettings = db
        .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
        .get();
      const instituteName = appSettings?.institute_name || "StudySpace";

      const msgText = `Dear ${student.name},\n\nThis is an official notice that your account at ${instituteName} (Student ID: STC-${String(student.student_id).padStart(4, "0")}) has been suspended by management.\n- Reason: ${reason.trim()}\n\nAs a result of this suspension, your seat allocations have been released and billing has been paused. Gate pass access is currently restricted. To discuss resolution or reactivation, please contact the front desk.\n\nBest regards,\n${instituteName} Management`;

      const contactPhone = student.whatsapp || student.phone;

      db.prepare(
        `
        INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
        VALUES (?, ?, 'Status', ?, 'Pending', NULL, ?, ?)
      `,
      ).run(student.student_id, contactPhone, msgText, nowIso(), nowIso());
    } catch (e) {
      console.error("[whatsapp] Error queuing suspension message:", e);
    }

    broadcastChange("messages"); // Notify messages panel of status updates
    res.json({
      message: "Student suspended. Seat(s) released, billing stopped.",
      waived: false,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Failed to suspend student. " + err.message });
  }
});

// POST /api/students/:id/prepare-reactivate - check dues for PREVIOUS months only.
// Current month billing is NOT generated here — it depends on the new seat/timing chosen.
router.post("/:id/prepare-reactivate", (req, res) => {
  const studentId = req.params.id;
  try {
    const inTransition = isTransitionMode();
    const student = db
      .prepare("SELECT * FROM students WHERE student_id = ?")
      .get(studentId);
    if (!student) {
      return res.status(404).json({ error: "Student not found." });
    }
    if (student.status !== "Suspended" && student.status !== "Archived") {
      return res.status(400).json({
        error: `Student is currently ${student.status}, only Suspended or Archived students can be prepared for reactivation.`,
      });
    }

    const currentMonth = new Date().toISOString().slice(0, 7);

    // Determine start month from leaving_date or admission_date
    const leavingMonth = student.leaving_date
      ? student.leaving_date.slice(0, 7)
      : null;
    const admissionMonth = student.admission_date
      ? student.admission_date.slice(0, 7)
      : null;
    let startMonth;
    if (leavingMonth && admissionMonth) {
      startMonth =
        leavingMonth < admissionMonth ? leavingMonth : admissionMonth;
    } else {
      startMonth = leavingMonth || admissionMonth || currentMonth;
    }
    if (startMonth > currentMonth) startMonth = currentMonth;

    // Generate months from startMonth up to PREVIOUS month only (exclude current month)
    // Current month fee depends on new seat/timing — generated separately via prepare-current-month-bill
    const prevMonthDate = new Date(currentMonth + "-01");
    prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
    const prevMonth = prevMonthDate.toISOString().slice(0, 7);

    if (startMonth <= prevMonth) {
      const monthsToBill = [];
      let d = new Date(startMonth + "-01");
      const end = new Date(prevMonth + "-01");
      while (d <= end) {
        monthsToBill.push(d.toISOString().slice(0, 7));
        d.setMonth(d.getMonth() + 1);
      }

      const feeStructure = db
        .prepare("SELECT * FROM fee_structures WHERE fee_structure_id = ?")
        .get(student.fee_structure_id);

      if (feeStructure) {
        for (const m of monthsToBill) {
          const exists = db
            .prepare(
              "SELECT billing_id FROM billing_records WHERE student_id = ? AND billing_month = ? AND status != 'Refunded'",
            )
            .get(studentId, m);
          if (!exists) {
            // In transition mode, NEVER create billing records — zero-cost placeholder only if needed
            if (inTransition) {
              // Skip — no charges whatsoever during transition mode
              continue;
            }
            db.prepare(
              `
              INSERT INTO billing_records (
                student_id, billing_month, base_fee, admission_fee, fine_amount,
                amount_paid, due_amount, bill_number, payment_mode, payment_date, status, created_at
              )
              VALUES (?, ?, ?, 0, 0, NULL, ?, NULL, NULL, NULL, 'Due', ?)
            `,
            ).run(
              studentId,
              m,
              feeStructure.monthly_fee,
              feeStructure.monthly_fee,
              nowIso(),
            );
          }
        }
      }
    }

    // Get audit settings for default admission fee
    const auditSettings = db
      .prepare("SELECT * FROM audit_settings WHERE setting_id = 1")
      .get();
    const defaultAdmissionFee = auditSettings?.admission_fee || 0;

    // Return only PREVIOUS months unpaid records (not current month)
    const prevMonthsUnpaid = db
      .prepare(
        "SELECT * FROM billing_records WHERE student_id = ? AND billing_month < ? AND status NOT IN ('Paid', 'Refunded', 'Waived') ORDER BY billing_month ASC",
      )
      .all(studentId, currentMonth);

    // Also return current month record if it already exists (e.g. from a previous partial prepare)
    const currentMonthRecord =
      db
        .prepare(
          "SELECT * FROM billing_records WHERE student_id = ? AND billing_month = ? AND status != 'Refunded'",
        )
        .get(studentId, currentMonth) || null;

    res.json({
      student,
      prevMonthsUnpaid,
      currentMonthRecord,
      defaultAdmissionFee,
      suspensionThreshold: auditSettings?.suspension_threshold_months || 1,
      currentMonth,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to prepare student for reactivation. " + err.message,
    });
  }
});

// POST /api/students/:id/prepare-current-month-bill - generate/update current month billing
// based on the NEW seat/timing blocks selected during reactivation.
// Called after prev dues are cleared and seat is chosen, before hitting Reactivate.
router.post("/:id/prepare-current-month-bill", (req, res) => {
  const studentId = req.params.id;
  try {
    // TRANSITION MODE: strictly no charges allowed — return null record immediately
    if (isTransitionMode()) {
      return res.json({
        currentMonthRecord: null,
        feeStructure: null,
        inTransition: true,
      });
    }

    const student = db
      .prepare("SELECT * FROM students WHERE student_id = ?")
      .get(studentId);
    if (!student) return res.status(404).json({ error: "Student not found." });
    if (student.status !== "Suspended" && student.status !== "Archived") {
      return res
        .status(400)
        .json({ error: "Student is not suspended/archived." });
    }

    const { blocks } = req.body || {};
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return res
        .status(400)
        .json({ error: "blocks required to calculate fee." });
    }

    // Calculate total hours from blocks to find new fee structure
    const totalHours = blocks.reduce(
      (sum, b) => sum + durationHours(b.start_time, b.end_time),
      0,
    );
    const feeStructure = db
      .prepare(
        "SELECT * FROM fee_structures WHERE hours_per_day = ? AND active = 1",
      )
      .get(totalHours);
    if (!feeStructure) {
      return res
        .status(400)
        .json({ error: `No fee plan for ${totalHours} hours/day.` });
    }

    const currentMonth = new Date().toISOString().slice(0, 7);

    // Insert or update current month billing record with the new fee
    const existing = db
      .prepare(
        "SELECT * FROM billing_records WHERE student_id = ? AND billing_month = ? AND status != 'Refunded'",
      )
      .get(studentId, currentMonth);

    const originalFeeStructure = db
      .prepare("SELECT * FROM fee_structures WHERE fee_structure_id = ?")
      .get(student.fee_structure_id);
    const originalMonthlyFee = originalFeeStructure
      ? originalFeeStructure.monthly_fee
      : 0;

    if (existing) {
      if (totalHours !== student.duration_hours) {
        // Plan change (hours differ): ALWAYS re-price, even if the old bill was Paid.
        // The student is effectively switching to a different fee tier — their old payment
        // is credited against the new total and they pay (or are owed) the difference.
        const amountPaid = existing.amount_paid || 0;
        const totalExpected =
          feeStructure.monthly_fee +
          existing.admission_fee +
          existing.fine_amount;
        const rawDue = totalExpected - amountPaid;
        const newDue = Math.max(0, rawDue);
        const newStatus =
          newDue === 0 ? "Paid" : amountPaid > 0 ? "Partial" : "Due";

        let noteText = `Plan changed from ${student.duration_hours}h to ${totalHours}h on reactivation. Base fee adjusted from ₹${originalMonthlyFee} to ₹${feeStructure.monthly_fee}.`;
        if (rawDue < 0) {
          noteText += ` Previous overpayment of ₹${-rawDue} — dues cleared.`;
        }

        db.prepare(
          `
          UPDATE billing_records 
          SET base_fee = ?, due_amount = ?, status = ?, note = ? 
          WHERE billing_id = ?
        `,
        ).run(
          feeStructure.monthly_fee,
          newDue,
          newStatus,
          noteText,
          existing.billing_id,
        );
      } else {
        // Returned to original plan: restore original pricing and clear plan-change note
        const amountPaid = existing.amount_paid || 0;
        const totalExpected =
          originalMonthlyFee + existing.admission_fee + existing.fine_amount;
        const rawDue = totalExpected - amountPaid;
        const newDue = Math.max(0, rawDue);
        const newStatus =
          newDue === 0 ? "Paid" : amountPaid > 0 ? "Partial" : "Due";

        db.prepare(
          `
          UPDATE billing_records 
          SET base_fee = ?, due_amount = ?, status = ?, note = NULL 
          WHERE billing_id = ?
        `,
        ).run(originalMonthlyFee, newDue, newStatus, existing.billing_id);
      }
    } else {
      // No existing bill — create new.
      const newDue = feeStructure.monthly_fee;
      db.prepare(
        `
        INSERT INTO billing_records (
          student_id, billing_month, base_fee, admission_fee, fine_amount,
          amount_paid, due_amount, bill_number, payment_mode, payment_date, status, created_at, note
        )
        VALUES (?, ?, ?, 0, 0, NULL, ?, NULL, NULL, NULL, 'Due', ?, NULL)
      `,
      ).run(
        studentId,
        currentMonth,
        feeStructure.monthly_fee,
        newDue,
        nowIso(),
      );
    }

    const record = db
      .prepare(
        "SELECT * FROM billing_records WHERE student_id = ? AND billing_month = ? AND status != 'Refunded'",
      )
      .get(studentId, currentMonth);

    broadcastChange("students");
    broadcastChange("payments");
    res.json({ currentMonthRecord: record, feeStructure });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Failed to prepare current month bill. " + err.message });
  }
});

// POST /api/students/:id/reactivate - manual reactivation from Suspended OR Archived.
// Always requires a fresh seat/time block — the old allocation is never silently reused,
// since the seat may have been given to someone else in the meantime.
// body: { blocks: [{start_time, end_time, seat_number}, ...] }
router.post("/:id/reactivate", (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE student_id = ?")
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found." });
  if (student.status !== "Suspended" && student.status !== "Archived") {
    return res.status(400).json({
      error: `Cannot reactivate a student who is currently ${student.status}.`,
    });
  }

  // Enforce no unpaid billing records for PREVIOUS months before reactivation.
  // Current month is allowed to have dues (it was just generated with new pricing).
  const currentMonth = new Date().toISOString().slice(0, 7);
  const prevMonthsUnpaid = db
    .prepare(
      "SELECT COUNT(*) c FROM billing_records WHERE student_id = ? AND billing_month < ? AND status NOT IN ('Paid', 'Refunded', 'Waived')",
    )
    .get(student.student_id, currentMonth).c;
  if (prevMonthsUnpaid > 0) {
    return res.status(400).json({
      error:
        "Cannot reactivate student. All previous month dues must be cleared first.",
    });
  }

  const { blocks } = req.body || {};
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({
      error:
        "At least one time block (seat + timing) is required to reactivate.",
    });
  }
  if (blocks.length > 2) {
    return res
      .status(400)
      .json({ error: "A maximum of 2 time blocks is supported." });
  }

  const resolvedBlocks = [];
  for (const block of blocks) {
    const { start_time, end_time, seat_number } = block;
    if (!start_time || !end_time || !seat_number) {
      return res.status(400).json({
        error: "Each time block needs a start time, end time, and seat number.",
      });
    }
    const seat = db
      .prepare("SELECT * FROM seats WHERE seat_number = ? AND active = 1")
      .get(seat_number.trim().toUpperCase());
    if (!seat) {
      return res.status(400).json({
        error: `Seat "${seat_number}" does not exist or is disabled.`,
      });
    }
    if (!isSeatAvailable(seat.seat_id, start_time, end_time)) {
      return res.status(409).json({
        error: `Seat ${seat_number} is not available for ${start_time}–${end_time}.`,
      });
    }
    resolvedBlocks.push({
      seat_id: seat.seat_id,
      seat_number: seat.seat_number,
      start_time,
      end_time,
    });
  }

  if (resolvedBlocks.length === 2) {
    const r1 = normalizeRange(
      resolvedBlocks[0].start_time,
      resolvedBlocks[0].end_time,
    );
    const r2 = normalizeRange(
      resolvedBlocks[1].start_time,
      resolvedBlocks[1].end_time,
    );
    if (rangesOverlap(r1, r2)) {
      return res.status(400).json({
        error: "Time Block 1 and Time Block 2 overlap with each other.",
      });
    }
  }

  const totalHours = resolvedBlocks.reduce(
    (sum, b) => sum + durationHours(b.start_time, b.end_time),
    0,
  );
  if (totalHours < 4 || totalHours > 24) {
    return res.status(400).json({
      error: `Total duration is ${totalHours}h. Must be between 4 and 24 hours.`,
    });
  }

  const feeStructure = db
    .prepare(
      "SELECT * FROM fee_structures WHERE hours_per_day = ? AND active = 1",
    )
    .get(totalHours);
  if (!feeStructure) {
    return res.status(400).json({
      error: `No fee plan exists for ${totalHours} hours/day. Add one in Settings first.`,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const timestamp = nowIso();

  const tx = db.transaction(() => {
    db.prepare(
      `
      UPDATE students 
      SET status = 'Active', 
          leaving_date = NULL, 
          remarks = NULL, 
          duration_hours = ?, 
          fee_structure_id = ?, 
          updated_at = ?,
          suspension_type = NULL,
          suspension_reason = NULL
      WHERE student_id = ?
    `,
    ).run(
      totalHours,
      feeStructure.fee_structure_id,
      timestamp,
      student.student_id,
    );

    const insertAlloc = db.prepare(`
      INSERT INTO seat_allocations (student_id, seat_id, start_time, end_time, valid_from, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);
    for (const b of resolvedBlocks) {
      insertAlloc.run(
        student.student_id,
        b.seat_id,
        b.start_time,
        b.end_time,
        today,
        timestamp,
      );

      // Check if the allocated seat differs from the recommended proposal and log it
      const proposal = proposeSeat(student.gender, b.start_time, b.end_time);
      if (proposal.proposed_seat && proposal.proposed_seat !== b.seat_number) {
        db.prepare(
          `
          INSERT INTO seat_override_logs (student_id, proposed_seat, allocated_seat, reason, admin_name, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        ).run(
          student.student_id,
          proposal.proposed_seat,
          b.seat_number,
          req.body.override_reason || req.body.reason || "Admin override",
          req.body.admin_name || "Admin",
          timestamp,
        );
      }
    }
  });

  try {
    tx();
    const updatedStudent = db
      .prepare("SELECT * FROM students WHERE student_id = ?")
      .get(student.student_id);
    broadcastChange("students", `Student reactivated: ${updatedStudent.name}`);
    broadcastChange("allocations");

    // Send reactivation email asynchronously
    if (updatedStudent.email && updatedStudent.email.trim() !== "") {
      const { sendReactivationEmail } = require("../services/emailService");
      sendReactivationEmail(updatedStudent, resolvedBlocks).catch((err) => {
        console.error("[email] Error sending reactivation email:", err);
      });
    }

    // Insert reactivation WhatsApp message into queue
    try {
      const appSettings = db
        .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
        .get();
      const instituteName = appSettings?.institute_name || "StudySpace";
      const seatList = resolvedBlocks
        .map((b) => `Seat ${b.seat_number} (${b.start_time} - ${b.end_time})`)
        .join(", ");

      const msgText = `Dear ${updatedStudent.name},\n\nWelcome back. Your student account at ${instituteName} (Student ID: STC-${String(updatedStudent.student_id).padStart(4, "0")}) has been successfully reactivated. Your seat configuration is now live:\n- Seat(s): ${seatList}\n- Reactivation Date: ${today}\n- Monthly Fee Plan: ₹${feeStructure.monthly_fee}/month\n\nBilling will resume naturally from this month. Please visit the reception desk to settle any active month fees if applicable.\n\nBest regards,\n${instituteName} Management`;

      const contactPhone = updatedStudent.whatsapp || updatedStudent.phone;

      db.prepare(
        `
        INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
        VALUES (?, ?, 'Status', ?, 'Pending', NULL, ?, ?)
      `,
      ).run(
        updatedStudent.student_id,
        contactPhone,
        msgText,
        timestamp,
        timestamp,
      );
    } catch (e) {
      console.error("[whatsapp] Error queuing reactivation message:", e);
    }

    broadcastChange("messages");
    res.json({
      message:
        "Student reactivated with a new seat assignment. Billing will resume.",
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Failed to reactivate student. " + err.message });
  }
});

// POST /api/students/:id/archive - permanent historical record (student has left for good).
// Never deletes data. Distinct from /suspend: archiving signals "done", not "on hold" —
// both are reactivatable, but Archived carries no implication of returning soon.
router.post("/:id/archive", (req, res) => {
  const student = db
    .prepare("SELECT * FROM students WHERE student_id = ?")
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found." });

  const today = new Date().toISOString().slice(0, 10);
  const { reason } = req.body || {};

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE students SET status = 'Archived', leaving_date = ?, updated_at = ? WHERE student_id = ?`,
    ).run(today, nowIso(), student.student_id);
    db.prepare(
      `UPDATE seat_allocations SET active = 0, valid_to = ? WHERE student_id = ? AND active = 1`,
    ).run(today, student.student_id);
    if (reason) {
      const existingRemarks = student.remarks ? student.remarks + " | " : "";
      db.prepare(`UPDATE students SET remarks = ? WHERE student_id = ?`).run(
        `${existingRemarks}Archived ${today}: ${reason}`,
        student.student_id,
      );
    }
  });

  try {
    tx();
    broadcastChange("students", `Student archived: ${student.name}`);
    broadcastChange("allocations");

    // Send archiving email asynchronously
    if (student.email && student.email.trim() !== "") {
      const { sendArchiveEmail } = require("../services/emailService");
      sendArchiveEmail(student, reason || "No reason specified").catch(
        (err) => {
          console.error("[email] Error sending archiving email:", err);
        },
      );
    }

    // Insert archiving WhatsApp message into queue
    try {
      const appSettings = db
        .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
        .get();
      const instituteName = appSettings?.institute_name || "StudySpace";

      const msgText = `Dear ${student.name},\n\nThis message confirms that your student membership at ${instituteName} (Student ID: STC-${String(student.student_id).padStart(4, "0")}) has been officially archived. Your seat allocations have been released and recurring billing has been stopped.\n- Departure Notes: ${reason || "No reason specified"}\n\nThank you for choosing ${instituteName} for your studies. We wish you the absolute best in your exams and future goals.\n\nBest regards,\n${instituteName} Management`;

      const contactPhone = student.whatsapp || student.phone;

      db.prepare(
        `
        INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
        VALUES (?, ?, 'Status', ?, 'Pending', NULL, ?, ?)
      `,
      ).run(student.student_id, contactPhone, msgText, nowIso(), nowIso());
    } catch (e) {
      console.error("[whatsapp] Error queuing archive message:", e);
    }

    broadcastChange("messages");
    res.json({ message: "Student archived. Seat(s) released." });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Failed to archive student. " + err.message });
  }
});

module.exports = router;
