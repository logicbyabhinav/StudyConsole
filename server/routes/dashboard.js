const express = require("express");
const router = express.Router();
const { db } = require("../db/init");
const {
  normalizeRange,
  rangesOverlap,
} = require("../services/seatAvailability");

router.get("/", (req, res) => {
  const activeStudents = db
    .prepare("SELECT COUNT(*) c FROM students WHERE status = 'Active'")
    .get().c;
  const totalSeats = db
    .prepare("SELECT COUNT(*) c FROM seats WHERE active = 1")
    .get().c;
  const todayStr = new Date().toISOString().slice(0, 10);
  const occupiedSeats = db
    .prepare(
      `
    SELECT COUNT(DISTINCT seat_id) c FROM seat_allocations 
    WHERE active = 1 AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
  `,
    )
    .get(todayStr, todayStr).c;

  const currentMonth = new Date().toISOString().slice(0, 7);
  const billingThisMonth = db
    .prepare("SELECT * FROM billing_records WHERE billing_month = ?")
    .all(currentMonth);
  const monthlyRevenue = billingThisMonth.reduce(
    (sum, b) => sum + (b.amount_paid || 0),
    0,
  );
  const expectedRevenue = billingThisMonth.reduce(
    (sum, b) => sum + b.base_fee + b.admission_fee + b.fine_amount,
    0,
  );
  const outstandingRevenue = expectedRevenue - monthlyRevenue;

  // Overdue is a BILLING status, not a student status — count distinct students
  // with at least one 'Overdue' billing record (their fee is overdue and fined,
  // but they remain Active and keep their seat unless/until auto-suspended).
  const overdueStudents = db
    .prepare(
      `
    SELECT COUNT(DISTINCT student_id) c FROM billing_records WHERE status = 'Overdue'
  `,
    )
    .get().c;

  // Expiring soon: billing for this month due within 7 days (using audit day as the
  // due date) and not yet paid.
  const auditSettings = db
    .prepare("SELECT * FROM audit_settings WHERE setting_id = 1")
    .get();
  const today = new Date();
  const expiringSoon = (() => {
    if (!auditSettings) return 0;
    const dueDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      auditSettings.audit_day,
    );
    const daysUntilDue = Math.ceil((dueDate - today) / 86400000);
    if (daysUntilDue < 0 || daysUntilDue > 7) return 0;
    return billingThisMonth.filter((b) => b.status !== "Paid").length;
  })();

  // Revenue trend: last 6 billing months, collected vs expected.
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  const revenueTrend = months.map((m) => {
    const rows = db
      .prepare("SELECT * FROM billing_records WHERE billing_month = ?")
      .all(m);
    const collected = rows.reduce((s, b) => s + (b.amount_paid || 0), 0);
    const expected = rows.reduce((s, b) => s + b.base_fee + b.admission_fee + b.fine_amount, 0);
    return { month: m, collected, expected };
  });

  // Currently checked in: active allocations whose time range covers right now.
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowRange = { start: nowMinutes, end: nowMinutes + 1 };
  const liveAllocations = db
    .prepare(
      `
    SELECT sa.*, se.seat_number, st.name, st.gender, st.father_name, st.student_id
    FROM seat_allocations sa
    JOIN seats se ON se.seat_id = sa.seat_id
    JOIN students st ON st.student_id = sa.student_id
    WHERE sa.active = 1 AND st.status = 'Active'
      AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
  `,
    )
    .all(todayStr, todayStr);
  const currentlyCheckedIn = liveAllocations.filter((a) =>
    rangesOverlap(nowRange, normalizeRange(a.start_time, a.end_time)),
  );


  res.json({
    activeStudents,
    totalSeats,
    occupiedSeats,
    availableSeats: totalSeats - occupiedSeats,
    monthlyRevenue,
    expectedRevenue,
    outstandingRevenue,
    overdueStudents,
    expiringSoon,
    occupancyPercent: totalSeats
      ? Math.round((occupiedSeats / totalSeats) * 100)
      : 0,
    revenueTrend,
    currentlyCheckedIn: currentlyCheckedIn.map((a) => ({
      student_id: a.student_id,
      name: a.name,
      gender: a.gender,
      father_name: a.father_name,
      seat_number: a.seat_number,
      start_time: a.start_time,
      end_time: a.end_time,
    })),

    note:
      billingThisMonth.length === 0
        ? "No students admitted yet this month."
        : null,
  });
});

module.exports = router;
