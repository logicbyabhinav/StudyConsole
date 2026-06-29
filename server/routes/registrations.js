const express = require("express");
const router = express.Router();
const { db, photosDb, nowIso } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");
const {
  isSeatAvailable,
  normalizeRange,
  rangesOverlap,
  durationHours,
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
  ["whatsapp", "WhatsApp Number"],
  ["email", "Email Address"],
  ["aadhaar_number", "Aadhaar Number"],
  ["father_name", "Father's Name"],
  ["mother_name", "Mother's Name"],
  ["address", "Address"],
  ["joining_date", "Joining Date"],
  ["preferred_seat", "Assigned Seat"],
  ["preferred_start_time", "Start Time"],
  ["preferred_end_time", "End Time"],
  ["photo_data", "Profile Photo"],
];

// GET /api/registrations/config - Public configuration details
router.get("/config", (req, res) => {
  try {
    res.json({
      isTransitionMode: isTransitionMode(),
      operationalStartMonth: getBillingStartMonth(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/registrations - Public form submission
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
    preferred_seat,
    preferred_start_time,
    preferred_end_time,
    remarks,
    form_number,
    class: studentClass,
    parent_occupation,
    nationality,
    religion,
    goal,
    photo_path,
    photo_data,
    address_village,
    address_po,
    address_ps,
    address_district,
    address_state,
    address_pin,
    education_history,
  } = req.body;

  // Validate required fields
  const missing = REQUIRED_FIELDS.filter(
    ([key]) => !req.body[key] || !String(req.body[key]).trim(),
  ).map(([, label]) => label);

  if (missing.length) {
    return res
      .status(400)
      .json({ error: `Missing required field(s): ${missing.join(", ")}.` });
  }

  // Validate seat exists and is active
  const seatNumFormatted = preferred_seat.trim().toUpperCase();
  if (seatNumFormatted !== "AUTO") {
    const seat = db
      .prepare("SELECT * FROM seats WHERE seat_number = ? AND active = 1")
      .get(seatNumFormatted);

    if (!seat) {
      return res
        .status(400)
        .json({
          error: `Seat "${preferred_seat}" does not exist or is disabled.`,
        });
    }

    // Validate timing
    try {
      const startRange = preferred_start_time.trim();
      const endRange = preferred_end_time.trim();

      // Check main allocations table (live active students)
      if (!isSeatAvailable(seat.seat_id, startRange, endRange)) {
        return res.status(400).json({
          error: `Seat ${seatNumFormatted} is already occupied during your shift (${startRange} - ${endRange}). Please choose another seat.`,
        });
      }

      // Check other pending requests
      const pendingRequests = db
        .prepare(
          "SELECT * FROM registration_requests WHERE preferred_seat = ? AND status = 'Pending'",
        )
        .all(seatNumFormatted);

      const newRange = normalizeRange(startRange, endRange);
      for (const pending of pendingRequests) {
        const pendingRange = normalizeRange(
          pending.preferred_start_time,
          pending.preferred_end_time,
        );
        if (rangesOverlap(newRange, pendingRange)) {
          return res.status(400).json({
            error: `Seat ${seatNumFormatted} has already been claimed by another student for an overlapping shift (${pending.preferred_start_time} - ${pending.preferred_end_time}) but is pending admin approval.`,
          });
        }
      }
    } catch (err) {
      return res
        .status(400)
        .json({
          error: "Invalid time format. Please check your start/end times.",
        });
    }
  }

  // Insert into registration_requests
  const timestamp = nowIso();
  try {
    db.prepare(
      `
      INSERT INTO registration_requests (
        name, gender, dob, phone, whatsapp, email, aadhaar_number, father_name, mother_name,
        emergency_contact, address, joining_date, preferred_seat, preferred_start_time, preferred_end_time,
        status, remarks,
        form_number, class, parent_occupation, nationality, religion, goal, photo_path,
        address_village, address_po, address_ps, address_district, address_state, address_pin, education_history,
        photo_data, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      name.trim(),
      gender,
      dob,
      phone.trim(),
      whatsapp.trim(),
      email.trim(),
      aadhaar_number.trim(),
      father_name.trim(),
      mother_name.trim(),
      emergency_contact ? emergency_contact.trim() : null,
      address.trim(),
      joining_date,
      seatNumFormatted,
      preferred_start_time.trim(),
      preferred_end_time.trim(),
      remarks ? remarks.trim() : null,
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
      photo_data ? photo_data.trim() : null,
      timestamp,
      timestamp,
    );

    broadcastChange(
      "registrations",
      `New self-registration request from ${name.trim()}`,
    );
    res
      .status(201)
      .json({ success: true, message: "Registration request submitted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit request: " + err.message });
  }
});

// GET /api/registrations - Admin list of pending requests (admissions, profile updates, seat changes)
router.get("/", (req, res) => {
  try {
    const admissions = db
      .prepare(
        "SELECT *, 'New Admission' AS request_type FROM registration_requests WHERE status = 'Pending' ORDER BY created_at DESC",
      )
      .all();

    const profileEdits = db
      .prepare(
        `
        SELECT per.*, s.name as current_name, s.phone as current_phone, 'Profile Update' AS request_type
        FROM profile_edit_requests per
        JOIN students s ON s.student_id = per.student_id
        WHERE per.status = 'Pending'
        ORDER BY per.created_at DESC
      `,
      )
      .all()
      .map((r) => {
        const currentPhoto = photosDb
          .prepare("SELECT photo_data FROM student_photos WHERE student_id = ?")
          .get(r.student_id);
        const curr = (currentPhoto && currentPhoto.photo_data) || "";
        const prop = r.photo_data || "";
        return { ...r, photo_changed: curr.trim() !== prop.trim() };
      });

    const seatChanges = db
      .prepare(
        `
        SELECT rr.*, s.name as student_name, s.phone as student_phone, 'Seat Change' AS request_type
        FROM reallocation_requests rr
        JOIN students s ON s.student_id = rr.student_id
        WHERE rr.status = 'Pending'
        ORDER BY rr.created_at DESC
      `,
      )
      .all();

    res.json({
      admissions,
      profileEdits,
      seatChanges,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/registrations/edits - Fetch pending profile edits
router.get("/edits", (req, res) => {
  try {
    const list = db
      .prepare(
        `
      SELECT per.*, s.name as current_name, s.phone as current_phone
      FROM profile_edit_requests per
      JOIN students s ON s.student_id = per.student_id
      WHERE per.status = 'Pending'
      ORDER BY per.created_at DESC
    `,
      )
      .all();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/registrations/edit/:id/approve - Approve student profile edit request
router.post("/edit/:id/approve", (req, res) => {
  const requestId = req.params.id;
  try {
    const request = db
      .prepare(
        "SELECT * FROM profile_edit_requests WHERE request_id = ? AND status = 'Pending'",
      )
      .get(requestId);
    if (!request) {
      return res
        .status(404)
        .json({ error: "Pending profile update request not found." });
    }

    db.transaction(() => {
      // Update student profile
      db.prepare(
        `
        UPDATE students
        SET name = ?, gender = ?, dob = ?, phone = ?, whatsapp = ?, email = ?,
            aadhaar_number = ?, father_name = ?, mother_name = ?, emergency_contact = ?,
            address = ?, form_number = ?, class = ?, parent_occupation = ?, nationality = ?,
            religion = ?, goal = ?, address_village = ?, address_po = ?, address_ps = ?,
            address_district = ?, address_state = ?, address_pin = ?, education_history = ?,
            updated_at = ?
        WHERE student_id = ?
      `,
      ).run(
        request.name,
        request.gender,
        request.dob,
        request.phone,
        request.whatsapp,
        request.email,
        request.aadhaar_number,
        request.father_name,
        request.mother_name,
        request.emergency_contact,
        request.address,
        request.form_number,
        request.class,
        request.parent_occupation,
        request.nationality,
        request.religion,
        request.goal,
        request.address_village,
        request.address_po,
        request.address_ps,
        request.address_district,
        request.address_state,
        request.address_pin,
        request.education_history,
        nowIso(),
        request.student_id,
      );

      // Mark request as Approved
      db.prepare(
        "UPDATE profile_edit_requests SET status = 'Approved' WHERE request_id = ?",
      ).run(requestId);
    })();

    // Sync photo into isolated photos DB (outside main transaction, separate database)
    if (request.hasOwnProperty("photo_data")) {
      if (request.photo_data && request.photo_data.trim() !== "") {
        photosDb
          .prepare(
            "INSERT OR REPLACE INTO student_photos (student_id, photo_data) VALUES (?, ?)",
          )
          .run(request.student_id, request.photo_data.trim());
      } else {
        photosDb
          .prepare("DELETE FROM student_photos WHERE student_id = ?")
          .run(request.student_id);
      }
    }

    broadcastChange("students");
    res.json({ message: "Student profile updated successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/registrations/edit/:id/reject - Reject student profile edit request
router.post("/edit/:id/reject", (req, res) => {
  const requestId = req.params.id;
  try {
    const result = db
      .prepare(
        "UPDATE profile_edit_requests SET status = 'Rejected' WHERE request_id = ? AND status = 'Pending'",
      )
      .run(requestId);

    if (result.changes === 0) {
      return res
        .status(404)
        .json({ error: "Pending profile update request not found." });
    }
    broadcastChange("students");
    res.json({ message: "Profile update request rejected." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/registrations/:id - Admin reject/remove a request
router.delete("/:id", (req, res) => {
  try {
    // Fetch request details before deleting for email notification
    const request = db
      .prepare("SELECT * FROM registration_requests WHERE request_id = ?")
      .get(req.params.id);

    const result = db
      .prepare("DELETE FROM registration_requests WHERE request_id = ?")
      .run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: "Registration request not found." });
    }

    // Trigger cancellation email asynchronously
    if (request && request.email && request.email.trim() !== "") {
      const {
        sendRegistrationCancellationEmail,
      } = require("../services/emailService");
      sendRegistrationCancellationEmail(request).catch((err) => {
        console.error(
          "[email] Error sending registration cancellation email:",
          err,
        );
      });
    }

    broadcastChange(
      "registrations",
      `Registration request for ${request.name} declined`,
    );
    res.json({ message: "Registration request removed successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/registrations/:id/admit - Approve and directly admit the student
router.post("/:id/admit", (req, res) => {
  const requestId = req.params.id;
  const timestamp = nowIso();

  try {
    // 1. Get the registration request
    const request = db
      .prepare(
        "SELECT * FROM registration_requests WHERE request_id = ? AND status = 'Pending'",
      )
      .get(requestId);
    if (!request) {
      return res
        .status(404)
        .json({ error: "Pending registration request not found." });
    }

    // 2. Resolve seat
    const finalSeatNumber = (
      req.body.seat_number ||
      req.body.preferred_seat ||
      request.preferred_seat
    )
      .trim()
      .toUpperCase();
    const seat = db
      .prepare("SELECT * FROM seats WHERE seat_number = ? AND active = 1")
      .get(finalSeatNumber);
    if (!seat) {
      return res
        .status(400)
        .json({
          error: `Seat "${finalSeatNumber}" does not exist or is disabled.`,
        });
    }

    // Double check availability
    if (
      !isSeatAvailable(
        seat.seat_id,
        request.preferred_start_time,
        request.preferred_end_time,
      )
    ) {
      return res.status(409).json({
        error: `Seat ${finalSeatNumber} is no longer available for ${request.preferred_start_time} - ${request.preferred_end_time}.`,
      });
    }

    // 3. Resolve fee structure
    const duration = durationHours(
      request.preferred_start_time,
      request.preferred_end_time,
    );
    const feeStructure = db
      .prepare(
        "SELECT * FROM fee_structures WHERE hours_per_day = ? AND active = 1",
      )
      .get(duration);
    if (!feeStructure) {
      return res.status(400).json({
        error: `No fee plan exists for ${duration} hours/day. Add one in Settings first.`,
      });
    }

    const dateObj = new Date();
    let year = dateObj.getFullYear();
    let month = dateObj.getMonth() + 2; // Next month
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const billingStartMonth = `${year}-${String(month).padStart(2, "0")}`;

    // Admitting transaction:
    // Insert student -> Insert seat allocation -> Delete registration request
    const admitTx = db.transaction(() => {
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
          request.name,
          request.gender,
          request.dob,
          request.phone,
          request.whatsapp,
          request.email,
          request.aadhaar_number,
          request.father_name,
          request.mother_name,
          request.emergency_contact,
          request.address,
          request.joining_date,
          duration,
          feeStructure.fee_structure_id,
          billingStartMonth,
          request.remarks,
          request.form_number,
          request.class,
          request.parent_occupation,
          request.nationality,
          request.religion,
          request.goal,
          request.photo_path,
          request.address_village,
          request.address_po,
          request.address_ps,
          request.address_district,
          request.address_state,
          request.address_pin,
          request.education_history,
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

      // Insert seat allocation
      db.prepare(
        `
        INSERT INTO seat_allocations (student_id, seat_id, start_time, end_time, valid_from, active, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `,
      ).run(
        studentId,
        seat.seat_id,
        request.preferred_start_time,
        request.preferred_end_time,
        request.joining_date,
        timestamp,
      );

      // Check if the allocated seat differs from the recommended proposal and log it
      const proposal = proposeSeat(
        request.gender,
        request.preferred_start_time,
        request.preferred_end_time,
      );
      if (
        proposal.proposed_seat &&
        proposal.proposed_seat !== finalSeatNumber
      ) {
        db.prepare(
          `
          INSERT INTO seat_override_logs (student_id, proposed_seat, allocated_seat, reason, admin_name, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        ).run(
          studentId,
          proposal.proposed_seat,
          finalSeatNumber,
          req.body.override_reason || req.body.reason || "Admin override",
          req.body.admin_name || "Admin",
          timestamp,
        );
      }

      // Delete registration request
      db.prepare("DELETE FROM registration_requests WHERE request_id = ?").run(
        requestId,
      );

      return studentId;
    });

    let tempPassword = "";
    const studentId = admitTx();

    // Copy compressed student photo from registration request to isolated photos database if present
    if (request.photo_data && request.photo_data.trim() !== "") {
      photosDb
        .prepare(
          "INSERT OR REPLACE INTO student_photos (student_id, photo_data) VALUES (?, ?)",
        )
        .run(studentId, request.photo_data.trim());
    }

    // 4. Send welcome email asynchronously
    if (request.email && request.email.trim() !== "") {
      const { sendRequestWelcomeEmail } = require("../services/emailService");
      const studentDataForEmail = {
        student_id: studentId,
        name: request.name,
        email: request.email,
        joining_date: request.joining_date,
        duration_hours: duration,
      };
      sendRequestWelcomeEmail(
        studentDataForEmail,
        billingStartMonth,
        finalSeatNumber,
        tempPassword,
      ).catch((err) => {
        console.error("[email] Error sending welcome email:", err);
      });
    }

    broadcastChange(
      "registrations",
      `Self-registration approved: ${request.name}`,
    );
    broadcastChange("students");
    broadcastChange("allocations");
    res.json({
      message: "Student admitted successfully.",
      student_id: studentId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to admit student: " + err.message });
  }
});

module.exports = router;
