const express = require("express");
const router = express.Router();
const { db, nowIso } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");

function generatePaymentId(db) {
  while (true) {
    const pId = String(Math.floor(1000000000 + Math.random() * 9000000000));
    const duplicate = db.prepare("SELECT 1 FROM payment_transactions WHERE payment_id = ?").get(pId);
    if (!duplicate) return pId;
  }
}


// GET /api/payments - list all billing records joined with student name, phone, father name
router.get("/", (req, res) => {
  try {
    const { status, month, student_id } = req.query;

    let query = `
      SELECT br.*, s.name as student_name, s.phone as student_phone, s.father_name,
             (SELECT group_concat(bill_number, ',') FROM payment_transactions WHERE billing_id = br.billing_id) as all_bill_numbers
      FROM billing_records br
      JOIN students s ON s.student_id = br.student_id
    `;
    const conditions = [];
    const values = [];

    if (status) {
      conditions.push("br.status = ?");
      values.push(status);
    } else {
      // Refunded records live on the Refunds page, never on the Payments page.
      conditions.push("br.status != 'Refunded'");
    }
    if (month) {
      conditions.push("br.billing_month = ?");
      values.push(month);
    }
    if (student_id) {
      conditions.push("br.student_id = ?");
      values.push(student_id);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY br.billing_month DESC, br.created_at DESC";

    const records = db.prepare(query).all(...values);
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/summary - get dashboard summary cards for revenue
router.get("/summary", (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const month = req.query.month || currentMonth;

    // Total expected/billed this month = base_fee + admission_fee + fine_amount
    const totals = db.prepare(`
      SELECT 
        SUM(base_fee + admission_fee + fine_amount) as total_billed,
        SUM(COALESCE(amount_paid, 0)) as total_collected,
        SUM(due_amount) as total_outstanding
      FROM billing_records
      WHERE billing_month = ?
    `).get(month);

    const allTimeOutstanding = db.prepare(`
      SELECT SUM(due_amount) as outstanding FROM billing_records
    `).get().outstanding || 0;

    res.json({
      month,
      total_billed: totals.total_billed || 0,
      total_collected: totals.total_collected || 0,
      total_outstanding: totals.total_outstanding || 0,
      all_time_outstanding: allTimeOutstanding
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/:id/pay - record payment for a billing record
router.post("/:id/pay", (req, res) => {
  const billingId = req.params.id;
  const { amount_paid, bill_number, payment_mode } = req.body;

  if (amount_paid === undefined || amount_paid === null || isNaN(Number(amount_paid)) || Number(amount_paid) < 0) {
    return res.status(400).json({ error: "Amount Paid must be a valid non-negative number." });
  }
  if (!payment_mode || !["Cash", "UPI", "Other"].includes(payment_mode)) {
    return res.status(400).json({ error: "Payment Mode must be Cash, UPI, or Other." });
  }
  if (!bill_number || !/^\d{4,5}$/.test(String(bill_number).trim())) {
    return res.status(400).json({ error: "Bill Number must be a 4 or 5 digit number." });
  }

  try {
    const rec = db.prepare("SELECT * FROM billing_records WHERE billing_id = ?").get(billingId);
    if (!rec) {
      return res.status(404).json({ error: "Billing record not found." });
    }

    const student = db.prepare("SELECT * FROM students WHERE student_id = ?").get(rec.student_id);
    if (!student) {
      return res.status(404).json({ error: "Student not found." });
    }

    const year = rec.billing_month.slice(0, 4);
    const suffix = String(bill_number).trim();
    const duplicate = db.prepare(`
      SELECT 1 FROM billing_records WHERE bill_number LIKE ?
      UNION ALL
      SELECT 1 FROM payment_transactions WHERE bill_number LIKE ?
      LIMIT 1
    `).get(`${year}-%-${suffix}`, `${year}-%-${suffix}`);
    if (duplicate) {
      return res.status(400).json({ error: `Bill number suffix ${suffix} has already been used in ${year}.` });
    }

    const currentPaid = rec.amount_paid || 0;
    const newTotalPaid = currentPaid + Number(amount_paid);
    const totalExpected = rec.base_fee + rec.admission_fee + rec.fine_amount;
    const newDueAmount = Math.max(0, totalExpected - newTotalPaid);
    const newStatus = newTotalPaid >= totalExpected ? "Paid" : (newTotalPaid > 0 ? "Partial" : "Due");
    const formattedBillNo = `${rec.billing_month}-${String(bill_number).trim()}`;
    const today = new Date().toISOString().slice(0, 10);
    const paymentId = generatePaymentId(db);

    const runTx = db.transaction(() => {
      // 1. Insert payment transaction history record
      db.prepare(`
        INSERT INTO payment_transactions (
          payment_id, billing_id, amount_paid, bill_number, payment_mode, payment_date, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        paymentId,
        billingId,
        Number(amount_paid),
        formattedBillNo,
        payment_mode,
        today,
        nowIso()
      );

      // 2. Update the parent billing record summary fields
      db.prepare(`
        UPDATE billing_records
        SET amount_paid = ?,
            due_amount = ?,
            bill_number = ?,
            payment_mode = ?,
            payment_date = ?,
            status = ?
        WHERE billing_id = ?
      `).run(
        newTotalPaid,
        newDueAmount,
        formattedBillNo,
        payment_mode,
        today,
        newStatus,
        billingId
      );

      // 3. Delete any pending dues reminders in whatsapp_queue for this billing record since it is paid/partially paid
      db.prepare(`
        DELETE FROM whatsapp_queue 
        WHERE message_type = 'Dues' AND reference_id = ? AND status = 'Pending'
      `).run(billingId);
    });

    runTx();

    // Trigger payment receipt email asynchronously if student email exists
    try {
      if (student && student.email && student.email.trim() !== "") {
        const { sendPaymentReceiptEmail } = require("../services/emailService");
        const updatedBill = {
          payment_id: paymentId,
          bill_number: formattedBillNo,
          billing_month: rec.billing_month,
          amount_paid: newTotalPaid,
          payment_mode,
          payment_date: today,
          due_amount: newDueAmount,
        };
        sendPaymentReceiptEmail(student, updatedBill, Number(amount_paid)).catch((err) => {
          console.error("[email] Error sending payment receipt email:", err);
        });
      }
    } catch (err) {
      console.error("[email] Failed to initiate payment receipt email:", err);
    }

    // Insert receipt WhatsApp message into queue
    try {
      const appSettings = db.prepare("SELECT * FROM app_settings WHERE setting_id = 1").get();
      const instituteName = appSettings?.institute_name || "StudySpace";
      
      const receiptMsg = `Dear ${student.name},\n\nThank you for your payment. We have successfully recorded your transaction. Here is your receipt summary:\n- Payment ID: ${paymentId}\n- Receipt/Bill No: ${formattedBillNo}\n- Payment Date: ${today}\n- Payment Mode: ${payment_mode}\n- Amount Paid: ₹${Number(amount_paid)}\n- Remaining Balance: ₹${newDueAmount}\n\nPlease preserve this receipt for your records.\n\nBest regards,\n${instituteName} Management`;

      const contactPhone = student.whatsapp || student.phone;

      db.prepare(`
        INSERT INTO whatsapp_queue (student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at)
        VALUES (?, ?, 'Receipt', ?, 'Pending', ?, ?, ?)
      `).run(student.student_id, contactPhone, receiptMsg, billingId, nowIso(), nowIso());
    } catch (e) {
      console.error("[whatsapp] Error queuing payment receipt message:", e);
    }

    broadcastChange("payments", `Payment of ₹${Number(amount_paid)} recorded for ${student.name}`);
    broadcastChange("students");
    broadcastChange("messages"); // Notify messages outbox
    res.json({ message: "Payment recorded successfully.", billing_id: billingId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/payments/:id/admission-fee - update admission fee for a billing record
router.put("/:id/admission-fee", (req, res) => {
  const billingId = req.params.id;
  const { admission_fee } = req.body;

  if (admission_fee === undefined || admission_fee === null || isNaN(Number(admission_fee)) || Number(admission_fee) < 0) {
    return res.status(400).json({ error: "Admission Fee must be a valid non-negative number." });
  }

  try {
    const rec = db.prepare("SELECT * FROM billing_records WHERE billing_id = ?").get(billingId);
    if (!rec) {
      return res.status(404).json({ error: "Billing record not found." });
    }

    const newAdmissionFee = Number(admission_fee);
    const amountPaid = rec.amount_paid || 0;
    const totalExpected = rec.base_fee + newAdmissionFee + rec.fine_amount;
    const newDueAmount = Math.max(0, totalExpected - amountPaid);
    
    // Status transition:
    let newStatus = rec.status;
    if (amountPaid >= totalExpected) {
      newStatus = "Paid";
    } else if (amountPaid > 0) {
      newStatus = "Partial";
    } else {
      const currentMonth = new Date().toISOString().slice(0, 7);
      if (rec.billing_month < currentMonth) {
        newStatus = "Overdue";
      } else {
        newStatus = "Due";
      }
    }

    db.prepare(`
      UPDATE billing_records
      SET admission_fee = ?,
          due_amount = ?,
          status = ?
      WHERE billing_id = ?
    `).run(newAdmissionFee, newDueAmount, newStatus, billingId);

    broadcastChange("payments", `Admission fee adjusted to ₹${newAdmissionFee} for ${rec.student_name || 'student'}`);
    broadcastChange("students");
    res.json({
      message: "Admission fee updated successfully.",
      billing_id: billingId,
      admission_fee: newAdmissionFee,
      due_amount: newDueAmount,
      status: newStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/:id/transactions - get transaction history for a billing record
router.get("/:id/transactions", (req, res) => {
  try {
    const transactions = db
      .prepare("SELECT * FROM payment_transactions WHERE billing_id = ? ORDER BY created_at DESC")
      .all(req.params.id);
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
