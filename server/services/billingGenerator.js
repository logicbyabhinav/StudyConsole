const { db, nowIso } = require("../db/init");

// Returns an inclusive array of 'YYYY-MM' strings from `fromYYYYMM` to `toYYYYMM`.
// e.g. monthsBetween('2026-04', '2026-07') -> ['2026-04','2026-05','2026-06','2026-07']
function monthsBetween(fromYYYYMM, toYYYYMM) {
  const months = [];
  let [fy, fm] = fromYYYYMM.split("-").map(Number);
  const [ty, tm] = toYYYYMM.split("-").map(Number);

  // Safety guard against accidental runaway loops (bad data, swapped args, etc.)
  let guard = 0;
  while ((fy < ty || (fy === ty && fm <= tm)) && guard < 600) {
    months.push(`${fy}-${String(fm).padStart(2, "0")}`);
    fm++;
    if (fm > 12) {
      fm = 1;
      fy++;
    }
    guard++;
  }
  return months;
}

/**
 * Promotes any scheduled price changes whose pending_from <= currentMonth.
 * Called at the start of runBillingGenerator so new bills always use the right price.
 */
function promotePendingPrices(currentMonth) {
  const pending = db
    .prepare("SELECT * FROM fee_structures WHERE pending_monthly_fee IS NOT NULL AND pending_from <= ?")
    .all(currentMonth);
  for (const slab of pending) {
    db.prepare(
      "UPDATE fee_structures SET monthly_fee = pending_monthly_fee, pending_monthly_fee = NULL, pending_from = NULL WHERE fee_structure_id = ?"
    ).run(slab.fee_structure_id);
    console.log(`[billing] Promoted fee for ${slab.hours_per_day}h: ₹${slab.monthly_fee} → ₹${slab.pending_monthly_fee} (effective ${slab.pending_from})`);
  }
  return pending.length;
}

/**
 * Catch-up billing generator. Not a literal "runs on the 1st" cron — this app
 * isn't always running, so instead: every time the server starts, for every
 * Active student, fill in any missing monthly billing_records row from their
 * joining month up to the current month. Suspended and Archived students do
 * not accrue new dues (their seat is freed and billing stops the moment they're
 * suspended/archived). Idempotent — safe to call repeatedly, already-existing
 * months are never touched or duplicated.
 */
function runBillingGenerator() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const appSettings = db.prepare("SELECT * FROM app_settings WHERE setting_id = 1").get();
  const instituteName = appSettings?.institute_name || "StudySpace";

  // Step 1: Promote any pending price changes that are now due.
  const promoted = promotePendingPrices(currentMonth);

  const activeStudents = db
    .prepare("SELECT * FROM students WHERE status = 'Active'")
    .all();

  const existingMonthsStmt = db.prepare(
    "SELECT billing_month FROM billing_records WHERE student_id = ?",
  );
  const feeStmt = db.prepare(
    "SELECT * FROM fee_structures WHERE fee_structure_id = ?",
  );
  const insertStmt = db.prepare(`
    INSERT INTO billing_records (
      student_id, billing_month, base_fee, admission_fee, fine_amount,
      amount_paid, due_amount, bill_number, payment_mode, payment_date, status, created_at, note
    )
    VALUES (?, ?, ?, 0, 0, NULL, ?, NULL, NULL, NULL, 'Due', ?, NULL)
  `);

  let generated = 0;
  const skippedNoFeeStructure = [];
  const newBillsToSend = [];

  const tx = db.transaction(() => {
    for (const student of activeStudents) {
      const feeStructure = feeStmt.get(student.fee_structure_id);
      if (!feeStructure) {
        skippedNoFeeStructure.push(student.student_id);
        continue;
      }

      const existingMonths = new Set(
        existingMonthsStmt.all(student.student_id).map((r) => r.billing_month),
      );
      const admissionMonth = student.joining_date.slice(0, 7);
      const startMonth = student.billing_start_month || admissionMonth;

      for (const month of monthsBetween(startMonth, currentMonth)) {
        if (!existingMonths.has(month)) {
          const res = insertStmt.run(
            student.student_id,
            month,
            feeStructure.monthly_fee,
            feeStructure.monthly_fee,
            nowIso(),
          );
          const billingId = res.lastInsertRowid;
          generated++;

          // Generate dues reminder WhatsApp message text
          const [y, m] = month.split("-");
          const monthLabel = new Date(+y, +m - 1, 1).toLocaleString("en-US", {
            month: "long",
            year: "numeric",
          });

          const msgText = `Dear ${student.name},\n\nThis is an official payment reminder from ${instituteName} regarding your allocated seat.\n\nOur records indicate the following outstanding dues:\n- ${monthLabel}: ₹${feeStructure.monthly_fee} due (Base Fee: ₹${feeStructure.monthly_fee})\n\nTo ensure uninterrupted access to your assigned seat, please clear these dues at the reception desk. If you have already made the payment, please share your receipt suffix code.\n\nThank you for your cooperation.\n\nBest regards,\n${instituteName} Management`;

          const contactPhone = student.whatsapp || student.phone;

          db.prepare(`
            INSERT INTO whatsapp_queue (
              student_id, phone, message_type, message_text, status, reference_id, created_at, updated_at
            )
            VALUES (?, ?, 'Dues', ?, 'Pending', ?, ?, ?)
          `).run(
            student.student_id,
            contactPhone,
            msgText,
            billingId,
            nowIso(),
            nowIso()
          );

          newBillsToSend.push({
            student,
            bill: {
              billing_month: month,
              base_fee: feeStructure.monthly_fee,
              due_amount: feeStructure.monthly_fee,
              fine_amount: 0,
            },
          });
        }
      }
    }
  });
  tx();
  if (generated > 0) {
    try {
      const { broadcastChange } = require("./liveStream");
      broadcastChange("messages", `${generated} monthly study bill(s) generated`);
    } catch (e) {
      console.error("[billing] Error broadcasting messages change:", e);
    }
  }

  // Send invoice emails asynchronously after database transaction finishes successfully
  if (newBillsToSend.length > 0) {
    const { sendInvoiceEmail } = require("./emailService");
    for (const item of newBillsToSend) {
      if (item.student.email && item.student.email.trim() !== "") {
        sendInvoiceEmail(item.student, item.bill).catch((err) => {
          console.error(`[email] Error sending invoice email for student ${item.student.student_id}:`, err);
        });
      }
    }
  }

  return { generated, promoted, month: currentMonth, skippedNoFeeStructure };
}

module.exports = { runBillingGenerator, monthsBetween };
