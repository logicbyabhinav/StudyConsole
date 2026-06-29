const express = require("express");
const router = express.Router();
const { db, nowIso } = require("../db/init");
const { getAvailableSeats } = require("../services/seatAvailability");
const {
  broadcastChange: notifyDashboardChanged,
} = require("../services/liveStream");
const { proposeSeat, validateSeatSelection } = require("../services/allocator");

// GET /api/seats - full seat map with occupancy + current occupant info
router.get("/", (req, res) => {
  const seats = db
    .prepare("SELECT * FROM seats ORDER BY CAST(seat_number AS INTEGER)")
    .all();

  const todayStr = new Date().toISOString().slice(0, 10);
  const allocations = db
    .prepare(
      `
    SELECT sa.seat_id, sa.start_time, sa.end_time, s.name, s.student_id, s.status
    FROM seat_allocations sa
    JOIN students s ON s.student_id = sa.student_id
    WHERE sa.active = 1 AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
  `,
    )
    .all(todayStr, todayStr);

  const allocBySeat = {};
  for (const a of allocations) {
    (allocBySeat[a.seat_id] = allocBySeat[a.seat_id] || []).push(a);
  }

  const result = seats.map((seat) => {
    const occupants = allocBySeat[seat.seat_id] || [];
    let status = "Available";
    if (!seat.active) status = "Disabled";
    else if (occupants.length > 0) status = "Occupied";

    const is24Hour = occupants.some((o) => {
      const [sh, sm] = o.start_time.split(":").map(Number);
      const [eh, em] = o.end_time.split(":").map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      return startMin === endMin || Math.abs(endMin - startMin) === 1440;
    });

    return { ...seat, status, is24Hour, occupants };
  });

  res.json(result);
});

// GET /api/seats/available?start=HH:MM&end=HH:MM&date=YYYY-MM-DD
router.get("/available", (req, res) => {
  const { start, end, date } = req.query;
  if (!start || !end)
    return res
      .status(400)
      .json({ error: "start and end query params are required" });
  const seats = getAvailableSeats(start, end, null, date);
  res.json(seats.map((s) => s.seat_number));
});

// PUT /api/seats/layout - update coordinates for multiple seats
router.put("/layout", (req, res) => {
  const layout = req.body; // Array of { seat_id, grid_x, grid_y }
  if (!Array.isArray(layout)) {
    return res.status(400).json({ error: "Layout data must be an array." });
  }

  try {
    const tx = db.transaction(() => {
      const updateStmt = db.prepare(
        "UPDATE seats SET grid_x = ?, grid_y = ?, rotation = ?, frame_id = ? WHERE seat_id = ?",
      );
      for (const item of layout) {
        updateStmt.run(
          item.grid_x,
          item.grid_y,
          item.rotation ?? 0,
          item.frame_id || null,
          item.seat_id,
        );
      }
    });
    tx();
    notifyDashboardChanged();
    res.json({ success: true, message: "Seat layout saved successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/seats/propose?gender=Male&start=08:00&end=14:00&date=YYYY-MM-DD&excludeStudentId=123
router.get("/propose", (req, res) => {
  const { gender, start, end, date, excludeStudentId } = req.query;
  if (!gender || !start || !end) {
    return res
      .status(400)
      .json({ error: "gender, start, and end query params are required" });
  }
  try {
    const excludeId = excludeStudentId ? parseInt(excludeStudentId, 10) : null;
    const proposal = proposeSeat(gender, start, end, date, excludeId);
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/seats/validate-override
router.post("/validate-override", (req, res) => {
  const { seat_number, gender, start, end, date, student_id } = req.body;
  if (!seat_number || !gender || !start || !end) {
    return res
      .status(400)
      .json({ error: "seat_number, gender, start, and end are required" });
  }
  try {
    const excludeId = student_id ? parseInt(student_id, 10) : null;
    const result = validateSeatSelection(
      seat_number,
      gender,
      start,
      end,
      date,
      excludeId,
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/seats/log-override
router.post("/log-override", (req, res) => {
  const { student_id, proposed_seat, allocated_seat, reason, admin_name } =
    req.body;
  if (!student_id || !proposed_seat || !allocated_seat || !reason) {
    return res
      .status(400)
      .json({
        error:
          "student_id, proposed_seat, allocated_seat, and reason are required",
      });
  }
  try {
    db.prepare(
      `
      INSERT INTO seat_override_logs (student_id, proposed_seat, allocated_seat, reason, admin_name, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      student_id,
      proposed_seat,
      allocated_seat,
      reason,
      admin_name || "Admin",
      nowIso(),
    );
    res.json({ success: true, message: "Override log written successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
