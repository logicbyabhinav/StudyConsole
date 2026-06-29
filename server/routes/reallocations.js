const express = require("express");
const router = express.Router();
const { db, nowIso } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");
const {
  isSeatAvailable,
  durationHours,
  rangesOverlap,
  normalizeRange,
} = require("../services/seatAvailability");
const { proposeSeat } = require("../services/allocator");

// GET /api/reallocations - Fetch all pending requests with metadata
router.get("/", (req, res) => {
  try {
    const pending = db.prepare(`
      SELECT 
        rr.request_id,
        rr.student_id,
        rr.preferred_seat,
        rr.preferred_start_time,
        rr.preferred_end_time,
        rr.reason,
        rr.status,
        rr.created_at,
        s.name AS student_name,
        s.gender AS student_gender,
        s.duration_hours AS current_duration_hours,
        s.phone AS student_phone,
        s.whatsapp AS student_whatsapp
      FROM reallocation_requests rr
      JOIN students s ON s.student_id = rr.student_id
      WHERE rr.status = 'Pending'
      ORDER BY rr.created_at DESC
    `).all();

    const todayStr = new Date().toISOString().slice(0, 10);
    const currentAllocStmt = db.prepare(`
      SELECT sa.start_time, sa.end_time, se.seat_number
      FROM seat_allocations sa
      JOIN seats se ON se.seat_id = sa.seat_id
      WHERE sa.student_id = ? AND sa.active = 1
        AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
      ORDER BY sa.start_time
    `);

    const result = pending.map(item => {
      const allocs = currentAllocStmt.all(item.student_id, todayStr, todayStr);
      const oldSeats = allocs.map(a => `Seat ${a.seat_number}`).join(", ");
      const oldShifts = allocs.map(a => `${a.start_time} - ${a.end_time}`).join(", ");
      return {
        ...item,
        current_seats: oldSeats || "None",
        current_shifts: oldShifts || "None"
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Common reallocation execution function
function executeReallocation(studentId, newBlocks, reqBody) {
  const timestamp = nowIso();
  const today = new Date().toISOString().slice(0, 10);
  const effectiveDate = reqBody.effective_date || today;

  // Calculate dayBeforeEffectiveDate (UTC/local safe)
  const dateObj = new Date(effectiveDate);
  dateObj.setDate(dateObj.getDate() - 1);
  const dayBeforeEffectiveDate = dateObj.toISOString().slice(0, 10);

  // If effectiveImmediately (effectiveDate <= today), query allocations active today.
  // Otherwise, query allocations active on the day before the effective date.
  const deactivationTargetDate = effectiveDate <= today ? today : dayBeforeEffectiveDate;

  const student = db.prepare("SELECT * FROM students WHERE student_id = ?").get(studentId);
  if (!student) {
    throw new Error("Student not found.");
  }

  // Calculate total hours
  const totalHours = newBlocks.reduce(
    (sum, b) => sum + durationHours(b.start_time, b.end_time),
    0
  );

  if (totalHours < 4 || totalHours > 24) {
    throw new Error(`Total duration is ${totalHours}h. Must be between 4 and 24 hours.`);
  }

  const activeFees = db.prepare("SELECT * FROM fee_structures WHERE active = 1").all();
  const feeStructure = activeFees.find(f => Math.abs(f.hours_per_day - totalHours) < 0.01);
  if (!feeStructure) {
    throw new Error(`No fee plan exists for ${totalHours.toFixed(1).replace('.0', '')} hours/day. Create one in settings first.`);
  }

  // Get active seats as of deactivationTargetDate
  const activeAllocs = db.prepare(`
    SELECT sa.allocation_id, se.seat_number, sa.start_time, sa.end_time
    FROM seat_allocations sa
    JOIN seats se ON se.seat_id = sa.seat_id
    WHERE sa.student_id = ? AND sa.active = 1
      AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
  `).all(studentId, deactivationTargetDate, deactivationTargetDate);

  const oldSeatsDisplay = activeAllocs.map(a => `Seat ${a.seat_number}`).join(", ") || "None";

  // Validate timing overlaps between blocks (up to 4 blocks)
  for (let i = 0; i < newBlocks.length; i++) {
    for (let j = i + 1; j < newBlocks.length; j++) {
      const r1 = normalizeRange(newBlocks[i].start_time, newBlocks[i].end_time);
      const r2 = normalizeRange(newBlocks[j].start_time, newBlocks[j].end_time);
      if (rangesOverlap(r1, r2)) {
        throw new Error(`Time Block ${i + 1} and Time Block ${j + 1} overlap with each other.`);
      }
    }
  }

  // Validate seat availability and retrieve seat IDs
  const resolvedBlocks = [];
  for (const block of newBlocks) {
    const seatNum = block.seat_number.trim().toUpperCase();
    const seat = db.prepare("SELECT * FROM seats WHERE seat_number = ? AND active = 1").get(seatNum);
    if (!seat) {
      throw new Error(`Seat "${block.seat_number}" does not exist or is disabled.`);
    }

    // Exclude current student's allocations from availability checks to support moving timings on same seat
    const studentAllocIds = db.prepare("SELECT allocation_id FROM seat_allocations WHERE student_id = ? AND active = 1").all(studentId).map(a => a.allocation_id);
    const checkAvailable = (seatId, start, end) => {
      // Custom checker that ignores this student's active allocations on effectiveDate
      const overlapping = db.prepare(`
        SELECT sa.allocation_id, sa.student_id, sa.start_time, sa.end_time
        FROM seat_allocations sa
        WHERE sa.seat_id = ? AND sa.active = 1
          AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
      `).all(seatId, effectiveDate, effectiveDate);

      const nr = normalizeRange(start, end);
      for (const alloc of overlapping) {
        if (studentAllocIds.includes(alloc.allocation_id)) {
          continue;
        }
        const ar = normalizeRange(alloc.start_time, alloc.end_time);
        if (rangesOverlap(nr, ar)) {
          return false;
        }
      }
      return true;
    };

    if (!checkAvailable(seat.seat_id, block.start_time, block.end_time)) {
      throw new Error(`Seat ${seatNum} is already occupied during ${block.start_time} - ${block.end_time}.`);
    }

    resolvedBlocks.push({
      seat_id: seat.seat_id,
      seat_number: seat.seat_number,
      start_time: block.start_time,
      end_time: block.end_time,
    });
  }

  // Run database transaction
  db.transaction(() => {
    // 1. Deactivate old allocations
    // If effective_date <= today, deactivate immediately (active = 0).
    // If effective_date > today, keep active = 1 but set valid_to so they expire at the end of the day before effective_date.
    db.prepare(`
      UPDATE seat_allocations 
      SET active = ?, valid_to = ? 
      WHERE student_id = ? AND active = 1
        AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
    `).run(
      effectiveDate <= today ? 0 : 1,
      dayBeforeEffectiveDate,
      studentId,
      deactivationTargetDate,
      deactivationTargetDate
    );

    // Deactivate any allocations that start on or after the effective date
    db.prepare(`
      UPDATE seat_allocations 
      SET active = 0 
      WHERE student_id = ? AND active = 1 AND valid_from >= ?
    `).run(studentId, effectiveDate);

    // 2. Insert new allocations
    const insertAlloc = db.prepare(`
      INSERT INTO seat_allocations (student_id, seat_id, start_time, end_time, valid_from, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);

    for (const rb of resolvedBlocks) {
      insertAlloc.run(studentId, rb.seat_id, rb.start_time, rb.end_time, effectiveDate, timestamp);

      // Check seat proposal override and log
      const proposal = proposeSeat(student.gender, rb.start_time, rb.end_time, effectiveDate);
      if (proposal.proposed_seat && proposal.proposed_seat !== rb.seat_number) {
        db.prepare(`
          INSERT INTO seat_override_logs (student_id, proposed_seat, allocated_seat, reason, admin_name, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          studentId,
          proposal.proposed_seat,
          rb.seat_number,
          reqBody.override_reason || reqBody.reason || "Reallocation override",
          reqBody.admin_name || "Admin",
          timestamp
        );
      }
    }

    // 3. Update student plan details
    db.prepare(`
      UPDATE students 
      SET fee_structure_id = ?, duration_hours = ?, updated_at = ? 
      WHERE student_id = ?
    `).run(feeStructure.fee_structure_id, totalHours, timestamp, studentId);

    // 4. Reprice current month's bill to the new full monthly fee.
    // No proration — if the plan changes mid-month, the student owes the full
    // new rate for the entire month. Whatever they've already paid is credited;
    // the difference (new_fee - paid) is what remains due.
    if (reqBody.billing_rule === "prorated") {
      const currentMonth = effectiveDate.slice(0, 7);
      const currentBill = db.prepare("SELECT * FROM billing_records WHERE student_id = ? AND billing_month = ?").get(studentId, currentMonth);
      if (currentBill) {
        // Skip if this is an admission-only bill (billing_start_month is a future month).
        // The student's recurring billing hasn't started yet — leave the admission
        // receipt alone; the new rate kicks in from billing_start_month onward.
        const billingStartMonth = student.billing_start_month;
        const isAdmissionOnlyBill = billingStartMonth && billingStartMonth > currentMonth;

        if (!isAdmissionOnlyBill) {
          const newBaseFee = feeStructure.monthly_fee;
          const totalExpected = newBaseFee + currentBill.admission_fee + currentBill.fine_amount;
          const newDue = Math.max(0, totalExpected - (currentBill.amount_paid || 0));

          let newStatus;
          if ((currentBill.amount_paid || 0) >= totalExpected) {
            newStatus = "Paid";
          } else if ((currentBill.amount_paid || 0) > 0) {
            newStatus = "Partial";
          } else {
            newStatus = "Due";
          }

          db.prepare(`
            UPDATE billing_records 
            SET base_fee = ?, due_amount = ?, status = ? 
            WHERE billing_id = ?
          `).run(newBaseFee, newDue, newStatus, currentBill.billing_id);
        }
      }
    }

    // 5. Insert Status WhatsApp notification
    try {
      const appSettings = db.prepare("SELECT * FROM app_settings WHERE setting_id = 1").get();
      const instituteName = appSettings?.institute_name || "StudySpace";
      const newSeatsDisplay = resolvedBlocks.map(b => `Seat ${b.seat_number}`).join(", ");
      const newShiftsDisplay = resolvedBlocks.map(b => `${b.start_time} - ${b.end_time}`).join(", ");
      
      const statusMsg = `StudySpace Seat Reallocation Alert\n\nDear ${student.name},\n\nYour seat/shift timing configuration has been successfully updated:\n\nStudent ID: STC-${String(studentId).padStart(4, "0")}\nPrevious Seat(s): ${oldSeatsDisplay}\nNew Seat(s): ${newSeatsDisplay}\nNew Shift: ${newShiftsDisplay} (${totalHours} hours/day)\nEffective Date: ${effectiveDate}\n\nNote: If this is set for next calendar month, your current seat remains active until the end of this month.\n\nWarm regards,\n${instituteName} Management`;

      const contactPhone = student.whatsapp || student.phone;
      db.prepare(`
        INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
        VALUES (?, ?, 'Status', ?, 'Pending', NULL, ?, ?)
      `).run(studentId, contactPhone, statusMsg, timestamp, timestamp);
    } catch (e) {
      console.error("[whatsapp] Error queuing reallocation status message:", e);
    }
  })();
}

// POST /api/reallocations/:id/approve - Approve request
router.post("/:id/approve", (req, res) => {
  const requestId = req.params.id;
  try {
    const request = db.prepare("SELECT * FROM reallocation_requests WHERE request_id = ? AND status = 'Pending'").get(requestId);
    if (!request) {
      return res.status(404).json({ error: "Pending reallocation request not found." });
    }

    let blocks = req.body.blocks;
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
      const { seat_number, start_time, end_time } = req.body;
      blocks = [{
        seat_number: seat_number || request.preferred_seat,
        start_time: start_time || request.preferred_start_time,
        end_time: end_time || request.preferred_end_time
      }];
    }

    // Run reallocation
    executeReallocation(request.student_id, blocks, req.body);

    // Update request status
    db.prepare("UPDATE reallocation_requests SET status = 'Approved', updated_at = ? WHERE request_id = ?").run(nowIso(), requestId);

    broadcastChange("students");
    broadcastChange("allocations");
    broadcastChange("messages");

    res.json({ message: "Reallocation request approved and processed successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reallocations/:id/reject - Reject request
router.post("/:id/reject", (req, res) => {
  const requestId = req.params.id;
  const { rejection_reason } = req.body;

  try {
    const request = db.prepare("SELECT * FROM reallocation_requests WHERE request_id = ? AND status = 'Pending'").get(requestId);
    if (!request) {
      return res.status(404).json({ error: "Pending reallocation request not found." });
    }

    db.prepare("UPDATE reallocation_requests SET status = 'Rejected', reason = ?, updated_at = ? WHERE request_id = ?")
      .run(rejection_reason || "Declined by management", nowIso(), requestId);

    // Queue WhatsApp alert for rejection
    try {
      const student = db.prepare("SELECT * FROM students WHERE student_id = ?").get(request.student_id);
      const appSettings = db.prepare("SELECT * FROM app_settings WHERE setting_id = 1").get();
      const instituteName = appSettings?.institute_name || "StudySpace";

      const rejectMsg = `Dear ${student.name},\n\nYour request for seat/timing reallocation at ${instituteName} has been reviewed and declined.\n- Reason: ${rejection_reason || "Declined by management"}\n\nPlease visit the front desk to discuss alternative seat availability.\n\nBest regards,\n${instituteName} Management`;

      const contactPhone = student.whatsapp || student.phone;
      db.prepare(`
        INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
        VALUES (?, ?, 'Status', ?, 'Pending', NULL, ?, ?)
      `).run(request.student_id, contactPhone, rejectMsg, nowIso(), nowIso());
    } catch (e) {
      console.error("[whatsapp] Error queuing rejection status message:", e);
    }

    broadcastChange("students");
    broadcastChange("messages");

    res.json({ message: "Reallocation request rejected successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reallocations/manual - Direct manual reallocation
router.post("/manual", (req, res) => {
  const { student_id, blocks } = req.body;
  if (!student_id || !Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ error: "Student ID and at least one study block are required." });
  }

  try {
    executeReallocation(Number(student_id), blocks, req.body);
    broadcastChange("students");
    broadcastChange("allocations");
    broadcastChange("messages");
    res.json({ message: "Student reallocated successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;