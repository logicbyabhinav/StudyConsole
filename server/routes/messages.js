const express = require("express");
const router = express.Router();
const { db } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");

// GET /api/messages/pending - Fetch all pending WhatsApp messages with rich metadata
router.get("/pending", (req, res) => {
  try {
    const pending = db.prepare(`
      SELECT 
        wq.queue_id,
        wq.student_id,
        wq.phone,
        wq.message_type,
        wq.message_text,
        wq.reference_id,
        s.name AS student_name,
        s.joining_date,
        s.duration_hours,
        br.billing_month,
        br.due_amount,
        br.base_fee,
        br.admission_fee,
        br.fine_amount,
        br.bill_number,
        br.payment_mode,
        br.payment_date,
        (SELECT amount_paid FROM payment_transactions WHERE billing_id = br.billing_id ORDER BY created_at DESC LIMIT 1) as tx_amount
      FROM whatsapp_queue wq
      JOIN students s ON s.student_id = wq.student_id
      LEFT JOIN billing_records br ON br.billing_id = wq.reference_id
      WHERE wq.status = 'Pending'
      ORDER BY wq.created_at DESC
    `).all();

    // Query active seats for each student active today
    const todayStr = new Date().toISOString().slice(0, 10);
    const seatStmt = db.prepare(`
      SELECT DISTINCT se.seat_number
      FROM seat_allocations sa
      JOIN seats se ON se.seat_id = sa.seat_id
      WHERE sa.student_id = ? AND sa.active = 1
        AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
    `);

    const result = pending.map(item => {
      const seats = seatStmt.all(item.student_id, todayStr, todayStr).map(r => r.seat_number);
      return {
        ...item,
        seats: seats.length > 0 ? seats.join(", ") : "N/A"
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:queueId/sent - Mark a WhatsApp message as sent
router.post("/:queueId/sent", (req, res) => {
  try {
    const queueId = req.params.queueId;
    
    // Verify the record exists
    const record = db.prepare("SELECT * FROM whatsapp_queue WHERE queue_id = ?").get(queueId);
    if (!record) {
      return res.status(404).json({ error: "Message queue record not found." });
    }

    db.prepare("UPDATE whatsapp_queue SET status = 'Sent', updated_at = ? WHERE queue_id = ?").run(
      new Date().toISOString(),
      queueId
    );

    // Backward compatibility: If it was a Dues reminder, update billing_records as well
    if (record.message_type === "Dues" && record.reference_id) {
      db.prepare("UPDATE billing_records SET reminder_sent = 1 WHERE billing_id = ?").run(record.reference_id);
    }
    
    broadcastChange("messages", `WhatsApp message marked as sent for ${record.phone}`);
    broadcastChange("payments");
    broadcastChange("students");
    res.json({ success: true, message: "Message marked as sent successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
