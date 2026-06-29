const { db, nowIso } = require("../db/init");

// Has the audit day for this billing_month already passed, as of `today`?
// billingMonth: 'YYYY-MM', auditDay: 1-28 (kept <=28 in Settings to avoid month-length edge cases)
function isAuditDayPassed(billingMonth, auditDay, today = new Date()) {
  const [y, m] = billingMonth.split("-").map(Number);
  // February bug fix: clamp to the actual last day of the month so day 29/30/31
  // in February doesn't silently overflow into March and fire fines late.
  const lastDay = new Date(y, m, 0).getDate();
  const safeDay = Math.min(auditDay, lastDay);
  const auditDate = new Date(y, m - 1, safeDay);
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  return todayMidnight >= auditDate;
}

// Helper to update pending dues WhatsApp message text with the new late fine details
function updatePendingDuesMessage(billingId) {
  try {
    const wqRecord = db
      .prepare(
        "SELECT * FROM whatsapp_queue WHERE message_type = 'Dues' AND reference_id = ? AND status = 'Pending'",
      )
      .get(billingId);
    if (wqRecord) {
      const freshBill = db
        .prepare("SELECT * FROM billing_records WHERE billing_id = ?")
        .get(billingId);
      const student = db
        .prepare("SELECT * FROM students WHERE student_id = ?")
        .get(freshBill.student_id);
      const appSettings = db
        .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
        .get();
      const instituteName = appSettings?.institute_name || "StudySpace";

      const [y, m] = freshBill.billing_month.split("-");
      const monthLabel = new Date(+y, +m - 1, 1).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
      });

      const feeComponents = [];
      if (freshBill.base_fee > 0)
        feeComponents.push(`Base Fee: ₹${freshBill.base_fee}`);
      if (freshBill.admission_fee > 0)
        feeComponents.push(`Admission Fee: ₹${freshBill.admission_fee}`);
      if (freshBill.fine_amount > 0)
        feeComponents.push(`Late Payment Fine: ₹${freshBill.fine_amount}`);
      const componentsText = feeComponents.join(", ");

      const updatedMsg = `Dear ${student.name},\n\nThis is an official payment reminder from ${instituteName} regarding your allocated seat.\n\nOur records indicate the following outstanding dues:\n- ${monthLabel}: ₹${freshBill.due_amount} due (${componentsText})\n\nTo ensure uninterrupted access to your assigned seat, please clear these dues at the reception desk. If you have already made the payment, please share your receipt suffix code.\n\nThank you for your cooperation.\n\nBest regards,\n${instituteName} Management`;

      db.prepare(
        "UPDATE whatsapp_queue SET message_text = ?, updated_at = ? WHERE queue_id = ?",
      ).run(updatedMsg, nowIso(), wqRecord.queue_id);
    }
  } catch (err) {
    console.error(
      "[whatsapp] Failed to update pending dues message after fine:",
      err,
    );
  }
}

/**
 * Catch-up audit engine, run right after the billing generator on every server start
 * (plus a manual "Run audit now" trigger from Settings). Two passes:
 *
 * 1. Fine pass: any 'Due' billing record whose billing month's audit day has passed
 *    gets the configured fine applied and flips to 'Overdue'. Already-fined records
 *    are untouched (idempotent). 'Overdue' is a BILLING status only — it never
 *    touches students.status.
 *
 * 2. Suspension pass: any 'Active' student whose live count of 'Overdue' billing
 *    records reaches the configured threshold gets suspended — status flips to
 *    'Suspended' and their active seat allocation(s) are deactivated (seat freed,
 *    no further billing accrues). This is one-directional: the audit engine never
 *    auto-reactivates anyone. Reactivation is always a manual admin action
 *    (see POST /students/:id/reactivate), since it requires picking a new seat.
 */
function runAuditEngine() {
  const settings = db
    .prepare("SELECT * FROM audit_settings WHERE setting_id = 1")
    .get();
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  let finesApplied = 0;
  let suspended = 0;
  const overdueBillsToSend = [];
  const autoSuspendedStudents = [];

  const tx = db.transaction(() => {
    // Pass 1a: apply fines to overdue 'Due' billing records (billing-level only).
    const dueRecords = db
      .prepare("SELECT * FROM billing_records WHERE status = 'Due'")
      .all();
    const fineStmt = db.prepare(
      `UPDATE billing_records SET status = 'Overdue', fine_amount = fine_amount + ?, due_amount = due_amount + ? WHERE billing_id = ?`,
    );
    for (const rec of dueRecords) {
      if (isAuditDayPassed(rec.billing_month, settings.audit_day, today)) {
        fineStmt.run(
          settings.fine_amount,
          settings.fine_amount,
          rec.billing_id,
        );
        finesApplied++;
        overdueBillsToSend.push(rec.billing_id);

        // Update pending WhatsApp reminder with fine details
        updatePendingDuesMessage(rec.billing_id);
      }
    }

    // Pass 1b: apply partial fines to 'Partial' billing records if they exceed exemption months threshold
    const partialRecords = db
      .prepare(
        `
        SELECT br.*, s.joining_date
        FROM billing_records br
        JOIN students s ON s.student_id = br.student_id
        WHERE br.status = 'Partial'
      `,
      )
      .all();
    for (const rec of partialRecords) {
      if (isAuditDayPassed(rec.billing_month, settings.audit_day, today)) {
        const joinMonth = rec.joining_date.slice(0, 7);
        const [jYear, jMonth] = joinMonth.split("-").map(Number);
        const [bYear, bMonth] = rec.billing_month.split("-").map(Number);
        const diffMonths = (bYear - jYear) * 12 + (bMonth - jMonth);

        // Bug 2 fix: only fine when partial_fine_amount > 0. If it's 0 the UPDATE
        // is a no-op and the record stays 'Partial', getting "fined" with ₹0 on
        // every server restart indefinitely.
        if (
          diffMonths >= settings.partial_exemption_months &&
          settings.partial_fine_amount > 0
        ) {
          fineStmt.run(
            settings.partial_fine_amount,
            settings.partial_fine_amount,
            rec.billing_id,
          );
          finesApplied++;
          overdueBillsToSend.push(rec.billing_id);

          // Update pending WhatsApp reminder with fine details
          updatePendingDuesMessage(rec.billing_id);
        }
      }
    }

    // Pass 2: auto-suspend Active students who've crossed the overdue threshold.
    const activeStudents = db
      .prepare("SELECT * FROM students WHERE status = 'Active'")
      .all();
    const overdueCountStmt = db.prepare(
      `SELECT COUNT(*) c FROM billing_records WHERE student_id = ? AND status = 'Overdue'`,
    );
    const suspendStudentStmt = db.prepare(
      `UPDATE students SET status = 'Suspended', leaving_date = ?, suspension_type = 'system', suspension_reason = ?, updated_at = ? WHERE student_id = ?`,
    );
    const deactivateSeatsStmt = db.prepare(
      `UPDATE seat_allocations SET active = 0, valid_to = ? WHERE student_id = ? AND active = 1`,
    );

    for (const student of activeStudents) {
      const overdueCount = overdueCountStmt.get(student.student_id).c;
      if (overdueCount >= settings.suspension_threshold_months) {
        const reason = `Overdue fees for ${overdueCount} month(s).`;
        suspendStudentStmt.run(todayStr, reason, nowIso(), student.student_id);
        deactivateSeatsStmt.run(todayStr, student.student_id);
        suspended++;

        autoSuspendedStudents.push({ student, reason });
      }
    }

    // Pass 3: clean up historically active allocations that have expired (valid_to is in the past)
    db.prepare(
      `
      UPDATE seat_allocations 
      SET active = 0 
      WHERE active = 1 AND valid_to IS NOT NULL AND valid_to < ?
    `,
    ).run(todayStr);
  });
  tx();

  // Send overdue warning emails asynchronously after database transaction finishes successfully
  if (overdueBillsToSend.length > 0) {
    const { sendOverdueWarningEmail } = require("./emailService");
    for (const billingId of overdueBillsToSend) {
      try {
        const bill = db
          .prepare("SELECT * FROM billing_records WHERE billing_id = ?")
          .get(billingId);
        const student = db
          .prepare("SELECT * FROM students WHERE student_id = ?")
          .get(bill.student_id);
        if (student && student.email && student.email.trim() !== "") {
          sendOverdueWarningEmail(student, bill).catch((err) => {
            console.error(
              `[email] Error sending overdue warning to student ${student.student_id}:`,
              err,
            );
          });
        }
      } catch (err) {
        console.error("[email] Failed to initiate overdue warning email:", err);
      }
    }
  }

  // Send suspension emails and queue WhatsApp messages for auto-suspended students
  if (autoSuspendedStudents.length > 0) {
    const { sendSuspensionEmail } = require("./emailService");
    const appSettings = db
      .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
      .get();
    const instituteName = appSettings?.institute_name || "StudySpace";

    for (const item of autoSuspendedStudents) {
      // 1. Send email
      if (item.student.email && item.student.email.trim() !== "") {
        sendSuspensionEmail(item.student, item.reason).catch((err) => {
          console.error(
            `[email] Error sending auto-suspension email to student ${item.student.student_id}:`,
            err,
          );
        });
      }

      // 2. Queue WhatsApp suspension notice
      try {
        const msgText = `Dear ${item.student.name},\n\nThis is an official notice that your account at ${instituteName} (Student ID: STC-${String(item.student.student_id).padStart(4, "0")}) has been suspended by management.\n- Reason: ${item.reason}\n\nAs a result of this suspension, your seat allocations have been released and billing has been paused. Gate pass access is currently restricted. To discuss resolution or reactivation, please contact the front desk.\n\nBest regards,\n${instituteName} Management`;

        const contactPhone = item.student.whatsapp || item.student.phone;

        db.prepare(
          `
          INSERT INTO whatsapp_queue (
            student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at
          )
          VALUES (?, ?, 'Status', ?, 'Pending', NULL, ?, ?)
        `,
        ).run(
          item.student.student_id,
          contactPhone,
          msgText,
          nowIso(),
          nowIso(),
        );
      } catch (e) {
        console.error(
          "[whatsapp] Error queuing auto-suspension WhatsApp message:",
          e,
        );
      }
    }
  }

  // Broadcast changes to the frontend if any modifications occurred
  if (finesApplied > 0 || suspended > 0) {
    try {
      const { broadcastChange } = require("./liveStream");
      let auditMsg = "Late payment fines applied and overdue accounts audited";
      if (suspended > 0) {
        auditMsg = `Late fines applied; ${suspended} account(s) automatically suspended due to overdue balances`;
      }
      broadcastChange("messages", auditMsg);
    } catch (e) {
      console.error("[audit] Error broadcasting messages change:", e);
    }
  }

  return { finesApplied, suspended };
}

module.exports = { runAuditEngine, isAuditDayPassed };
