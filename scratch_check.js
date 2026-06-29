// Automated verification for date-based seat reallocation
const { db, nowIso } = require("./server/db/init");

async function runTest() {
  console.log("Starting verification test...");
  const todayStrStr = new Date().toISOString().slice(0, 10);
  
  // Ensure we have at least one active student
  let student = db.prepare("SELECT * FROM students WHERE status = 'Active' LIMIT 1").get();
  if (!student) {
    console.log("No active student found. Creating one...");
    const timestamp = nowIso();
    const insertStudent = db.prepare(`
      INSERT INTO students (name, gender, dob, phone, whatsapp, email, aadhaar_number, father_name, mother_name, address, joining_date, duration_hours, status, created_at, updated_at)
      VALUES ('Vikram Test', 'Male', '2000-01-01', '9999999999', '9999999999', 'vikram@example.com', '123456789012', 'Father Name', 'Mother Name', '123 Test St', '2026-06-01', 6, 'Active', ?, ?)
    `);
    const info = insertStudent.run(timestamp, timestamp);
    student = { student_id: info.lastInsertRowid, name: 'Vikram Test', gender: 'Male' };
  }
  const studentId = student.student_id;
  console.log("Using student_id:", studentId);

  // Clean up any previous test allocations to start fresh
  db.prepare("DELETE FROM seat_allocations WHERE student_id = ?").run(studentId);

  // Create an active allocation today
  const seat = db.prepare("SELECT * FROM seats WHERE active = 1 LIMIT 1").get();
  if (!seat) {
    console.error("Test failed: No active seat in seats table.");
    process.exit(1);
  }
  db.prepare(`
    INSERT INTO seat_allocations (student_id, seat_id, start_time, end_time, valid_from, active, created_at)
    VALUES (?, ?, '09:00', '15:00', ?, 1, ?)
  `).run(studentId, seat.seat_id, todayStrStr, nowIso());

  // Create a pending reallocation request for this student if not exists
  let testRequest = db.prepare("SELECT * FROM reallocation_requests WHERE student_id = ? AND status = 'Pending'").get(studentId);
  if (!testRequest) {
    console.log("Creating pending reallocation request...");
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO reallocation_requests (student_id, preferred_seat, preferred_start_time, preferred_end_time, reason, status, created_at, updated_at)
      VALUES (?, '25', '09:00', '15:00', 'Desire a seat closer to the window/air conditioner for better concentration.', 'Pending', ?, ?)
    `).run(studentId, timestamp, timestamp);
    testRequest = db.prepare("SELECT * FROM reallocation_requests WHERE student_id = ? AND status = 'Pending'").get(studentId);
  }

  console.log("Found pending request:", testRequest);
  
  // Get student's current allocations before reallocation
  const currentAlocsBefore = db.prepare("SELECT * FROM seat_allocations WHERE student_id = ? AND active = 1").all(studentId);
  console.log("Active allocations before:", currentAlocsBefore);
  
  // 2. Fetch available seats on 2026-07-01 for 09:00-15:00
  const availRes = await fetch("http://localhost:3000/api/seats/available?start=09:00&end=15:00&date=2026-07-01");
  const availSeats = await availRes.json();
  console.log("Available seats on 2026-07-01:", availSeats);
  
  if (availSeats.length === 0) {
    console.error("Test failed: No vacant seats available on 2026-07-01 during 09:00 - 15:00.");
    process.exit(1);
  }
  
  const testSeat = availSeats[0];
  console.log("Selected test seat for reallocation:", testSeat);

  // Approve request using Mid-Month Pro-rata
  const approvalPayload = {
    seat_number: testSeat,
    start_time: "09:00",
    end_time: "15:00",
    billing_rule: "prorated",
    effective_date: todayStrStr,
    override_reason: "Student request for today"
  };
  
  console.log("Approving request with payload:", approvalPayload);
  
  const approveRes = await fetch(`http://localhost:3000/api/reallocations/${testRequest.request_id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(approvalPayload)
  });
  
  const approveResult = await approveRes.json();
  console.log("Approval response:", approveResult);
  
  if (approveRes.status !== 200) {
    console.error("Test failed: Approval API returned status", approveRes.status);
    process.exit(1);
  }
  
  // 3. Verify allocations in the database
  const allStudentAllocs = db.prepare("SELECT * FROM seat_allocations WHERE student_id = ?").all(studentId);
  console.log("All seat allocations for student after approval:", allStudentAllocs);
  
  // Calculate expected dayBeforeEffectiveDate based on today
  const dateObj = new Date(todayStrStr);
  dateObj.setDate(dateObj.getDate() - 1);
  const expectedDayBefore = dateObj.toISOString().slice(0, 10);
  
  // Find the old allocation (which should have valid_to set to expectedDayBefore)
  const oldAlloc = allStudentAllocs.find(a => a.valid_to === expectedDayBefore);
  if (!oldAlloc) {
    console.error(`Assertion failed: Could not find old allocation ending on ${expectedDayBefore}`);
    process.exit(1);
  }
  
  if (oldAlloc.active !== 0) {
    console.error("Assertion failed: Old allocation active state should be 0 (since effective date is today/past)");
    process.exit(1);
  }
  
  // Find the new allocation starting today (which has valid_to as null)
  const newAlloc = allStudentAllocs.find(a => a.valid_from === todayStrStr && a.valid_to === null);
  if (!newAlloc) {
    console.error(`Assertion failed: Could not find new allocation starting on ${todayStrStr}`);
    process.exit(1);
  }
  
  if (newAlloc.active !== 1) {
    console.error("Assertion failed: New allocation active state should be 1");
    process.exit(1);
  }
  
  console.log(`Assertions passed successfully! Old allocation set to end ${expectedDayBefore} (active=0). New allocation starts today ${todayStrStr} (active=1).`);
  console.log("ALL TESTS COMPLETED SUCCESSFULLY!");
}

runTest().catch(err => {
  console.error("Unhandled test error:", err);
  process.exit(1);
});
