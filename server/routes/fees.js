const express = require("express");
const router = express.Router();
const { db, nowIso } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");

// GET /api/fees - all fee slabs (active and inactive)
router.get("/", (req, res) => {
  const fees = db
    .prepare("SELECT * FROM fee_structures ORDER BY hours_per_day")
    .all();
  res.json(fees);
});

// GET /api/fees/active - only active fee slabs
router.get("/active", (req, res) => {
  const fees = db
    .prepare(
      "SELECT * FROM fee_structures WHERE active = 1 ORDER BY hours_per_day",
    )
    .all();
  res.json(fees);
});

// GET /api/fees/pending - slabs with a scheduled price change
router.get("/pending", (req, res) => {
  const pending = db
    .prepare("SELECT * FROM fee_structures WHERE pending_monthly_fee IS NOT NULL ORDER BY hours_per_day")
    .all();
  res.json(pending);
});

// DELETE /api/fees/:id/pending - cancel a scheduled price change
router.delete("/:id/pending", (req, res) => {
  try {
    db.prepare(
      "UPDATE fee_structures SET pending_monthly_fee = NULL, pending_from = NULL WHERE fee_structure_id = ?"
    ).run(req.params.id);
    broadcastChange("settings");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fees - create new fee slab
router.post("/", (req, res) => {
  const { hours_per_day, monthly_fee } = req.body;
  if (
    !hours_per_day ||
    monthly_fee === undefined ||
    hours_per_day < 1 ||
    hours_per_day > 24 ||
    monthly_fee < 0
  ) {
    return res
      .status(400)
      .json({ error: "Invalid hours_per_day (1-24) or monthly_fee" });
  }

  // Check uniqueness of hours_per_day
  const existing = db.prepare("SELECT * FROM fee_structures WHERE hours_per_day = ?").get(hours_per_day);
  if (existing) {
    return res.status(400).json({ error: `A fee slab already exists for ${hours_per_day} hours/day.` });
  }

  try {
    const result = db
      .prepare(
        "INSERT INTO fee_structures (hours_per_day, monthly_fee, active, created_at) VALUES (?, ?, 1, ?)",
      )
      .run(hours_per_day, monthly_fee, nowIso());
    broadcastChange("settings");
    res.json({ fee_structure_id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fees/:id - update fee slab
router.put("/:id", (req, res) => {
  const { hours_per_day, monthly_fee, active } = req.body;
  const id = req.params.id;
  try {
    const slab = db.prepare("SELECT * FROM fee_structures WHERE fee_structure_id = ?").get(id);
    if (!slab) return res.status(404).json({ error: "Fee slab not found" });

    if (typeof hours_per_day !== "undefined") {
      const conflict = db.prepare("SELECT * FROM fee_structures WHERE hours_per_day = ? AND fee_structure_id != ?").get(hours_per_day, id);
      if (conflict) return res.status(400).json({ error: `A fee slab already exists for ${hours_per_day} hours/day.` });
      db.prepare("UPDATE fee_structures SET hours_per_day = ? WHERE fee_structure_id = ?").run(hours_per_day, id);
    }

    if (typeof monthly_fee !== "undefined" && monthly_fee !== slab.monthly_fee) {
      // Price changed on an existing slab → schedule for next month, never overwrite current month.
      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const pendingFrom = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
      db.prepare(
        "UPDATE fee_structures SET pending_monthly_fee = ?, pending_from = ? WHERE fee_structure_id = ?"
      ).run(monthly_fee, pendingFrom, id);
      // Return extra info so the UI can display the scheduling notice.
      broadcastChange("settings");
      return res.json({ success: true, pending: true, pendingFrom, pendingFee: monthly_fee });
    }

    if (typeof active !== "undefined") {
      db.prepare("UPDATE fee_structures SET active = ? WHERE fee_structure_id = ?").run(active ? 1 : 0, id);
      // Disabling a slab cancels any pending price change — no point scheduling
      // a price update for a slab that won't be generating new bills.
      if (!active) {
        db.prepare(
          "UPDATE fee_structures SET pending_monthly_fee = NULL, pending_from = NULL WHERE fee_structure_id = ?"
        ).run(id);
      }
    }

    broadcastChange("settings");
    broadcastChange("students");
    res.json({ success: true, pending: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fees/:id - delete fee slab
router.delete("/:id", (req, res) => {
  const id = req.params.id;
  try {
    // Block deletion if any student (regardless of status) is still on this slab.
    const inUse = db.prepare(
      "SELECT COUNT(*) AS cnt FROM students WHERE fee_structure_id = ?"
    ).get(id);
    if (inUse.cnt > 0) {
      return res.status(400).json({
        error: `Cannot delete: ${inUse.cnt} student${inUse.cnt === 1 ? ' is' : 's are'} still assigned to this fee slab. Reassign them first.`
      });
    }
    db.prepare("DELETE FROM fee_structures WHERE fee_structure_id = ?").run(id);
    broadcastChange("settings");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
