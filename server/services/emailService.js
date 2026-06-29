const nodemailer = require("nodemailer");
const { db } = require("../db/init");

/**
 * Helper to format "YYYY-MM" to "Month YYYY"
 */
function formatBillingMonth(ym) {
  if (!ym) return "N/A";
  const parts = ym.split("-");
  if (parts.length !== 2) return ym;
  const [year, month] = parts;
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthIdx = parseInt(month, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return ym;
  return `${monthNames[monthIdx]} ${year}`;
}

/**
 * Loads the current SMTP settings and returns a nodemailer transporter.
 * Returns null if email notifications are disabled or settings are incomplete.
 */
async function getTransporter() {
  try {
    const settings = db
      .prepare("SELECT * FROM email_settings WHERE setting_id = 1")
      .get();
    if (
      !settings ||
      !settings.active ||
      !settings.sender_email ||
      !settings.sender_password
    ) {
      return null;
    }
    return nodemailer.createTransport({
      host: settings.smtp_host,
      port: Number(settings.smtp_port),
      secure: settings.smtp_secure === 1, // true for 465, false for 587
      auth: {
        user: settings.sender_email,
        pass: settings.sender_password,
      },
    });
  } catch (err) {
    console.error("[email] Error initializing transporter:", err);
    return null;
  }
}

/**
 * Sends a generic email if active.
 */
async function sendMail({ to, subject, html, text }) {
  const transporter = await getTransporter();
  if (!transporter) {
    console.log(
      `[email] Email service inactive or unconfigured. Skipped sending to: ${to}`,
    );
    return false;
  }

  const appSettings = db
    .prepare("SELECT institute_name FROM app_settings WHERE setting_id = 1")
    .get();
  const institute = appSettings?.institute_name || "StudySpace";

  const settings = db
    .prepare("SELECT sender_email FROM email_settings WHERE setting_id = 1")
    .get();
  const mailOptions = {
    from: `"${institute}" <${settings.sender_email}>`,
    to,
    subject,
    text,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[email] Sent successfully: ${info.messageId} to ${to}`);
    return true;
  } catch (err) {
    console.error(`[email] Failed to send email to ${to}:`, err);
    return false;
  }
}

/**
 * Sends a welcome email upon successful direct admission.
 */
async function sendWelcomeEmail(
  student,
  bill,
  requestedSeat = null,
  temporaryPassword = null,
) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  // Query actual seat and shift time allocations from db with SQL join to get seat_number
  const todayStr = new Date().toISOString().slice(0, 10);
  const seatAllocations = db
    .prepare(
      `
    SELECT se.seat_number, sa.start_time, sa.end_time 
    FROM seat_allocations sa
    JOIN seats se ON se.seat_id = sa.seat_id
    WHERE sa.student_id = ? AND sa.active = 1
      AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
    ORDER BY sa.start_time
  `,
    )
    .all(student.student_id, todayStr, todayStr);

  let seatNumber = "N/A";
  let startTime = "N/A";
  let endTime = "N/A";
  let seatDisplay = "N/A";
  let shiftDisplay = "N/A";
  let seatChanged = false;

  if (seatAllocations.length > 0) {
    const allocatedSeatNums = seatAllocations.map((sa) =>
      sa.seat_number.trim().toUpperCase(),
    );
    if (requestedSeat) {
      const reqSeatUpper = requestedSeat.trim().toUpperCase();
      seatChanged = !allocatedSeatNums.includes(reqSeatUpper);
    }

    const uniqueSeats = [
      ...new Set(seatAllocations.map((sa) => sa.seat_number)),
    ];
    seatNumber = uniqueSeats.join(", ");
    seatDisplay = uniqueSeats.map((num) => `Seat ${num}`).join(", ");

    const shifts = seatAllocations.map(
      (sa) => `${sa.start_time} - ${sa.end_time}`,
    );
    startTime = seatAllocations[0].start_time;
    endTime = seatAllocations[0].end_time;
    shiftDisplay = `${student.duration_hours} hours/day (${shifts.join(", ")})`;
  } else {
    shiftDisplay = `${student.duration_hours} hours/day`;
  }

  const seatAdjustmentNotice = seatChanged
    ? `
    <div style="background-color: #fffdef; border: 1px solid #ffeeba; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; color: #7b6000; margin-bottom: 24px; font-weight: 500;">
      <strong>Seat Assignment Notice:</strong> You have been allocated <strong>Seat ${seatNumber}</strong> instead of your requested seat (Seat ${requestedSeat}) due to timing constraints or availability.
    </div>
  `
    : "";

  const subject = `Welcome to ${instituteName}! Your Admission Confirmation`;
  let text = `Dear ${student.name},\n\nWelcome to ${instituteName}! Your admission is confirmed.\n\nStudent ID: STC-${String(student.student_id).padStart(4, "0")}\nJoining Date: ${student.joining_date}\nSeat: Seat ${seatNumber}${seatChanged ? ` (Requested: Seat ${requestedSeat})` : ""}\nStudy Hours: ${shiftDisplay}\n`;
  if (temporaryPassword) {
    text += `\nTemporary Password: ${temporaryPassword}\n(Please change your temporary password upon logging into the student portal for the first time)\n`;
  }
  text += `\nAdmission Invoice Summary:\nMonthly Fee: ₹${bill.base_fee}\nAdmission Fee: ₹${bill.admission_fee}\nTotal Payable: ₹${bill.base_fee + bill.admission_fee}\nAmount Paid: ₹${bill.amount_paid || 0}\n${bill.payment_id ? `Payment ID: ${bill.payment_id}\n` : ""}Remaining Due: ₹${bill.due_amount}\n\nThank you,\n${instituteName} Management`;

  const dueWarningNote =
    bill.due_amount > 0
      ? `
    <div style="background-color: #fff5f5; border: 1px solid #feb2b2; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; color: #c53030; margin-bottom: 24px; font-weight: 500;">
      Note: Please clear your pending dues at the front desk before the audit date to avoid penalty fines.
    </div>
  `
      : "";

  const tempPasswordRow = temporaryPassword
    ? `
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Temporary Password</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #cb2431; text-align: right;">${temporaryPassword}</td>
          </tr>
      `
    : "";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #0366d6; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Admission Confirmation</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Welcome to <strong>${instituteName}</strong>! We are pleased to confirm your admission. Your seat and timing allocation have been successfully configured.</p>

      ${seatAdjustmentNotice}

      <div style="background-color: #f6f8fa; border: 1px solid #e1e4e6; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 12px; font-weight: 700; color: #24292e; text-transform: uppercase; letter-spacing: 0.03em;">Registration Summary</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Student ID</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #24292e; text-align: right;">STC-${String(student.student_id).padStart(4, "0")}</td>
          </tr>
          ${tempPasswordRow}
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Joining Date</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${student.joining_date}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Assigned Seat</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #0366d6; text-align: right;">Seat ${seatNumber}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Study Shift</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${shiftDisplay}</td>
          </tr>
        </table>
      </div>

      <h3 style="font-size: 12px; font-weight: 700; color: #24292e; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 12px;">Admission Invoice Details</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px;">
        <thead>
          <tr style="border-bottom: 1px solid #e1e4e6;">
            <th style="text-align: left; padding: 8px 0; color: #586069; font-weight: 500;">Fee Component</th>
            <th style="text-align: right; padding: 8px 0; color: #586069; font-weight: 500;">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding: 8px 0; color: #24292e;">Monthly Study Fee</td>
            <td style="text-align: right; padding: 8px 0; color: #24292e;">₹${bill.base_fee}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #24292e;">One-time Admission Fee</td>
            <td style="text-align: right; padding: 8px 0; color: #24292e;">₹${bill.admission_fee}</td>
          </tr>
          <tr style="font-weight: 600; border-top: 1px solid #e1e4e6;">
            <td style="padding: 10px 0; color: #24292e;">Total Payable</td>
            <td style="text-align: right; padding: 10px 0; color: #24292e;">₹${bill.base_fee + bill.admission_fee}</td>
          </tr>
          <tr style="color: #28a745;">
            <td style="padding: 8px 0;">Amount Paid</td>
            <td style="text-align: right; padding: 8px 0;">- ₹${bill.amount_paid || 0}</td>
          </tr>
          ${
            bill.payment_id
              ? `
          <tr style="color: #28a745; font-size: 12px;">
            <td style="padding: 4px 0; font-style: italic;">Payment ID</td>
            <td style="text-align: right; padding: 4px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600;">${bill.payment_id}</td>
          </tr>
          `
              : ""
          }
          <tr style="font-weight: 700; border-top: 1px dashed #e1e4e6; color: ${bill.due_amount > 0 ? "#cb2431" : "#24292e"};">
            <td style="padding: 10px 0;">Remaining Due Balance</td>
            <td style="text-align: right; padding: 10px 0;">₹${bill.due_amount}</td>
          </tr>
        </tbody>
      </table>

      ${dueWarningNote}

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends a welcome email upon successful self-registration request approval.
 */
async function sendRequestWelcomeEmail(
  student,
  billingStartMonthRaw,
  requestedSeat = null,
  temporaryPassword = null,
) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  // Query actual seat and shift time allocations from db with SQL join to get seat_number
  const todayStr = new Date().toISOString().slice(0, 10);
  const seatAllocations = db
    .prepare(
      `
    SELECT se.seat_number, sa.start_time, sa.end_time 
    FROM seat_allocations sa
    JOIN seats se ON se.seat_id = sa.seat_id
    WHERE sa.student_id = ? AND sa.active = 1
      AND sa.valid_from <= ? AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
    ORDER BY sa.start_time
  `,
    )
    .all(student.student_id, todayStr, todayStr);

  let seatNumber = "N/A";
  let startTime = "N/A";
  let endTime = "N/A";
  let seatDisplay = "N/A";
  let shiftDisplay = "N/A";
  let seatChanged = false;

  if (seatAllocations.length > 0) {
    const allocatedSeatNums = seatAllocations.map((sa) =>
      sa.seat_number.trim().toUpperCase(),
    );
    if (requestedSeat) {
      const reqSeatUpper = requestedSeat.trim().toUpperCase();
      seatChanged = !allocatedSeatNums.includes(reqSeatUpper);
    }

    const uniqueSeats = [
      ...new Set(seatAllocations.map((sa) => sa.seat_number)),
    ];
    seatNumber = uniqueSeats.join(", ");
    seatDisplay = uniqueSeats.map((num) => `Seat ${num}`).join(", ");

    const shifts = seatAllocations.map(
      (sa) => `${sa.start_time} - ${sa.end_time}`,
    );
    startTime = seatAllocations[0].start_time;
    endTime = seatAllocations[0].end_time;
    shiftDisplay = `${student.duration_hours} hours/day (${shifts.join(", ")})`;
  } else {
    shiftDisplay = `${student.duration_hours} hours/day`;
  }

  const seatAdjustmentNotice = seatChanged
    ? `
    <div style="background-color: #fffdef; border: 1px solid #ffeeba; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; color: #7b6000; margin-bottom: 24px; font-weight: 500;">
      <strong>Seat Assignment Notice:</strong> You have been allocated <strong>Seat ${seatNumber}</strong> instead of your requested seat (Seat ${requestedSeat}) due to timing constraints or availability.
    </div>
  `
    : "";

  const billingStartMonth = formatBillingMonth(billingStartMonthRaw);

  const subject = `Welcome to ${instituteName}! Your Registration Request is Approved`;
  let text = `Dear ${student.name},\n\nWelcome to ${instituteName}! Your self-registration request has been approved.\n\nStudent ID: STC-${String(student.student_id).padStart(4, "0")}\nJoining Date: ${student.joining_date}\nSeat: Seat ${seatNumber}${seatChanged ? ` (Requested: Seat ${requestedSeat})` : ""}\nStudy Hours: ${shiftDisplay}\n`;
  if (temporaryPassword) {
    text += `\nTemporary Password: ${temporaryPassword}\n(Please change your temporary password upon logging into the student portal for the first time)\n`;
  }
  text += `\nBilling Start: Your billing cycle will officially begin on 1st ${billingStartMonth}. No initial admission fee or base fee is due at this time.\n\nThank you,\n${instituteName} Management`;

  const tempPasswordRow = temporaryPassword
    ? `
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Temporary Password</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #cb2431; text-align: right;">${temporaryPassword}</td>
          </tr>
      `
    : "";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #0366d6; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Registration Confirmed</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Welcome to <strong>${instituteName}</strong>! Your self-registration request has been approved and your seat configuration is now active.</p>

      ${seatAdjustmentNotice}

      <div style="background-color: #f6f8fa; border: 1px solid #e1e4e6; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 12px; font-weight: 700; color: #24292e; text-transform: uppercase; letter-spacing: 0.03em;">Registration Details</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Student ID</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #24292e; text-align: right;">STC-${String(student.student_id).padStart(4, "0")}</td>
          </tr>
          ${tempPasswordRow}
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Joining Date</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${student.joining_date}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Allocated Seat</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #0366d6; text-align: right;">Seat ${seatNumber}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Study Shift</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${shiftDisplay}</td>
          </tr>
        </table>
      </div>

      <div style="background-color: #f1f8ff; border: 1px solid #c8e1ff; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; color: #0366d6; margin-bottom: 24px;">
        <strong>Billing Start:</strong> Your billing cycle will officially begin on <strong>1st ${billingStartMonth}</strong>. No initial admission fee or base fee is due at this time.
      </div>

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends a monthly fee invoice.
 */
async function sendInvoiceEmail(student, bill) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const monthFormatted = formatBillingMonth(bill.billing_month);
  const subject = `${instituteName} Fee Invoice for ${monthFormatted}`;
  const text = `Dear ${student.name},\n\nYour study fee invoice for the month of ${monthFormatted} has been generated.\n\nAmount Due: ₹${bill.due_amount}\nBase Fee: ₹${bill.base_fee}\n${bill.fine_amount > 0 ? `Late Fines: ₹${bill.fine_amount}\n` : ""}\nPlease clear your dues at the front desk before the audit day to avoid late payment penalties.\n\nThank you,\n${instituteName} Management`;

  const finesRow =
    bill.fine_amount > 0
      ? `
    <tr>
      <td style="padding: 6px 0; color: #cb2431; font-weight: bold;">Late Fines</td>
      <td style="padding: 6px 0; text-align: right; color: #cb2431; font-weight: bold;">+ ₹${bill.fine_amount}</td>
    </tr>`
      : "";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #0366d6; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Monthly Fee Invoice</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Your study fee invoice for the billing month of <strong>${monthFormatted}</strong> has been generated.</p>

      <div style="background-color: #fffdef; border: 1px solid #ffeeba; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #7b6000; font-weight: 600;">Billing Period</td>
            <td style="padding: 6px 0; font-weight: 700; color: #24292e; text-align: right;">${monthFormatted}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Monthly Base Fee</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">₹${bill.base_fee}</td>
          </tr>
          ${finesRow}
          <tr style="font-weight: 700; font-size: 16px; border-top: 1px solid #ffeeba;">
            <td style="padding: 10px 0; color: #b05c00;">Total Pending Due</td>
            <td style="padding: 10px 0; text-align: right; color: #b05c00;">₹${bill.due_amount}</td>
          </tr>
        </table>
      </div>

      <p style="font-size: 14px; line-height: 1.6; color: #4a5568;">
        Please clear this outstanding payment at the front desk to continue accessing your allocated study seat. If you have already made this payment, please ignore this email or present your receipt suffix code to the admin.
      </p>
      
      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends a payment receipt.
 */
async function sendPaymentReceiptEmail(student, bill, txAmount) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const monthFormatted = formatBillingMonth(bill.billing_month);
  const subject = `${instituteName} Payment Receipt - Bill ${bill.bill_number}`;
  const text = `Dear ${student.name},\n\nThank you for your payment.\n\nReceipt/Bill No: ${bill.bill_number}\nAmount Paid in Transaction: ₹${txAmount}\nPayment Mode: ${bill.payment_mode}\nDate: ${bill.payment_date}\n\nRemaining Due Balance: ₹${bill.due_amount}\n\nThank you,\n${instituteName} Management`;

  const dueColor = bill.due_amount > 0 ? "#cb2431" : "#22543d";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #28a745; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Payment Receipt</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Thank you for your payment. We have successfully processed and recorded your transaction details.</p>

      <div style="background-color: #f0fff4; border: 1px solid #c6f6d5; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #22543d; font-weight: 600;">Receipt / Bill No</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 700; color: #22543d; text-align: right;">${bill.bill_number}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Billing Period</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${monthFormatted}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Payment Mode</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${bill.payment_mode}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Payment Date</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${bill.payment_date}</td>
          </tr>
          <tr style="font-weight: 700; font-size: 16px; border-top: 1px solid #c6f6d5;">
            <td style="padding: 10px 0; color: #28a745;">Amount Paid</td>
            <td style="padding: 10px 0; text-align: right; color: #28a745;">₹${txAmount}</td>
          </tr>
          <tr style="font-weight: 600; border-top: 1px dashed #c6f6d5; color: #24292e;">
            <td style="padding: 8px 0; color: #586069; font-weight: 500;">Remaining Balance Due</td>
            <td style="padding: 8px 0; text-align: right; color: ${dueColor};">₹${bill.due_amount}</td>
          </tr>
        </table>
      </div>

      <p style="font-size: 13.5px; color: #586069; font-style: italic; text-align: center;">Please preserve this receipt voucher for your personal records.</p>
      
      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends an overdue warning email.
 */
async function sendOverdueWarningEmail(student, bill) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const monthFormatted = formatBillingMonth(bill.billing_month);
  const subject = `URGENT: Overdue Fee Warning - ${instituteName}`;
  const text = `Dear ${student.name},\n\nYour study fee for ${monthFormatted} is now OVERDUE.\n\nOverdue Balance: ₹${bill.due_amount} (includes late fine of ₹${bill.fine_amount})\n\nPlease pay immediately at the desk to avoid suspension of your study seat.\n\nThank you,\n${instituteName} Management`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #feb2b2; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #feb2b2; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #cb2431; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #c53030; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Overdue Payment Warning</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">This is an official notice that your study fee for the billing month of <strong>${monthFormatted}</strong> is now **OVERDUE**.</p>

      <div style="background-color: #fff5f5; border: 1px solid #fed7d7; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #9b2c2c; font-weight: 600;">Billing Period</td>
            <td style="padding: 6px 0; font-weight: 700; color: #9b2c2c; text-align: right;">${monthFormatted}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Monthly Base Fee</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">₹${bill.base_fee}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #c53030; font-weight: 600;">Late Penalty Fee</td>
            <td style="padding: 6px 0; color: #c53030; font-weight: 700; text-align: right;">+ ₹${bill.fine_amount}</td>
          </tr>
          <tr style="font-weight: 700; font-size: 16px; border-top: 1px solid #feb2b2;">
            <td style="padding: 10px 0; color: #c53030;">Total Overdue Due</td>
            <td style="padding: 10px 0; text-align: right; color: #c53030;">₹${bill.due_amount}</td>
          </tr>
        </table>
      </div>

      <div style="background-color: #fff5f5; border: 1px solid #feb2b2; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; color: #c53030; margin-bottom: 24px; font-weight: 500;">
        <strong>Important Notice:</strong> Failure to pay your overdue balance immediately may result in automatic suspension of your seat allocation and library gate pass restriction.
      </div>
      
      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends an email notification when a registration request is rejected/cancelled.
 */
async function sendRegistrationCancellationEmail(registration) {
  if (!registration.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const subject = `Registration Request Update - ${instituteName}`;
  const text = `Dear ${registration.name},\n\nThank you for your interest in ${instituteName}.\n\nWe regret to inform you that your registration request has been cancelled or could not be accommodated at this time.\n\nThis may be due to timing clashes, unavailability of seats during your preferred shift, or other administrative constraints.\n\nIf you have any questions or would like to re-submit a request with different seat/timing preferences, please contact our front desk at ${institutePhone} or visit us at the center.\n\nBest regards,\n${instituteName} Management`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #cb2431; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Registration Request Update</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${registration.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Thank you for your interest in joining <strong>${instituteName}</strong>.</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">We regret to inform you that your registration request has been cancelled or could not be accommodated at this time.</p>

      <div style="background-color: #f6f8fa; border: 1px solid #e1e4e6; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; color: #586069; margin: 24px 0;">
        This may be due to timing clashes, unavailability of seats during your preferred shift, or other administrative capacity constraints.
      </div>

      <p style="font-size: 14px; line-height: 1.6; color: #24292e;">
        If you have any questions, would like to discuss alternative timing options, or wish to submit a new request, please do not hesitate to contact our front desk or visit us at the center.
      </p>

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: registration.email, subject, html, text });
}

/**
 * Sends an email notification when a student is suspended.
 */
async function sendSuspensionEmail(student, reason) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const subject = `Urgent Notice: Account Suspension - ${instituteName}`;
  const text = `Dear ${student.name},\n\nThis is an official notice that your account at ${instituteName} (Student ID: STC-${String(student.student_id).padStart(4, "0")}) has been suspended.\n\nReason for Suspension: ${reason}\n\nAs a result of this suspension, your seat allocations have been released and billing has been paused. Access to the study center has been restricted.\n\nTo resolve this suspension and discuss reactivation, please visit the reception desk or contact center management at ${institutePhone}.\n\nThank you,\n${instituteName} Management`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #feb2b2; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #feb2b2; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #cb2431; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #c53030; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Account Suspension Notice</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">This is an official notice regarding your membership at <strong>${instituteName}</strong> (Student ID: <strong>STC-${String(student.student_id).padStart(4, "0")}</strong>).</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Your account has been suspended by center management.</p>

      <div style="background-color: #fff5f5; border: 1px solid #fed7d7; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin-top: 0; margin-bottom: 8px; font-size: 12px; font-weight: 700; color: #c53030; text-transform: uppercase; letter-spacing: 0.03em;">Reason for Suspension</h3>
        <p style="margin: 0; font-size: 14.5px; line-height: 1.5; color: #24292e; font-weight: 500;">${reason}</p>
      </div>

      <div style="background-color: #f6f8fa; border: 1px solid #e1e4e6; border-radius: 8px; padding: 16px; font-size: 13.5px; line-height: 1.5; color: #586069; margin-bottom: 24px;">
        <strong>Note:</strong> Your active seat allocations have been released and recurring billing has been paused. Study center gate access pass is currently restricted.
      </div>

      <p style="font-size: 14px; line-height: 1.6; color: #24292e;">
        To resolve this suspension, clear outstanding dues, or discuss reactivation, please visit the reception desk or contact management at your earliest convenience.
      </p>

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends an email notification when a student account is archived.
 */
async function sendArchiveEmail(student, reason) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const subject = `Account Archived Confirmation - ${instituteName}`;
  const text = `Dear ${student.name},\n\nThis email confirms that your student account at ${instituteName} (Student ID: STC-${String(student.student_id).padStart(4, "0")}) has been officially archived.\n\nYour active seat allocations have been released and all recurring billing cycles have been stopped.\n\nArchive Reason/Notes: ${reason}\n\nWe want to thank you for choosing ${instituteName} for your studies and wish you the very best in your upcoming exams and future goals.\n\nIf you ever wish to rejoin us, please feel free to visit or contact our front desk.\n\nBest regards,\n${instituteName} Management`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #586069; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Account Archived</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">This email confirms that your student membership at <strong>${instituteName}</strong> (Student ID: <strong>STC-${String(student.student_id).padStart(4, "0")}</strong>) has been officially archived.</p>
      
      <div style="background-color: #f6f8fa; border: 1px solid #e1e4e6; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.5; color: #586069; margin: 24px 0;">
        <strong>Details:</strong> Your active seat allocations have been released and all recurring billing cycles have been stopped. 
        ${reason ? `<br><br><strong>Departure Reason / Notes:</strong> ${reason}` : ""}
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">
        We want to thank you for choosing <strong>${instituteName}</strong> as your study space and wish you the absolute best in your upcoming competitive exams and professional goals. Keep pushing forward!
      </p>

      <p style="font-size: 14px; line-height: 1.6; color: #586069; margin-top: 24px;">
        If you ever wish to rejoin our center in the future, please feel free to stop by the reception desk or contact us.
      </p>

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends an email notification when a student is reactivated.
 */
async function sendReactivationEmail(student, blocks) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  // Look up the active fee structure for this student
  const feeStructure = student.fee_structure_id
    ? db
        .prepare("SELECT * FROM fee_structures WHERE fee_structure_id = ?")
        .get(student.fee_structure_id)
    : null;
  const monthlyFee = feeStructure ? feeStructure.monthly_fee : 0;

  const seatList = blocks
    .map((b) => `Seat ${b.seat_number} (${b.start_time} - ${b.end_time})`)
    .join(", ");

  const subject = `Welcome Back! Account Reactivated - ${instituteName}`;
  const text = `Dear ${student.name},\n\nWelcome back to ${instituteName}! Your student account (Student ID: STC-${String(student.student_id).padStart(4, "0")}) has been successfully reactivated.\n\nYour new seat assignment details are as follows:\nSeat(s): ${seatList}\n\nBilling Cycle Details:\nMonthly Study Fee: ₹${monthlyFee}/month\nBilling starts immediately. Please ensure your active month fees are settled.\n\nThank you,\n${instituteName} Management`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #28a745; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Account Reactivated</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Welcome back to <strong>${instituteName}</strong>! We are pleased to confirm that your account has been successfully reactivated and your seat configuration is live.</p>

      <div style="background-color: #f0fff4; border: 1px solid #c6f6d5; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 12px; font-weight: 700; color: #22543d; text-transform: uppercase; letter-spacing: 0.03em;">New Seat Assignment</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Student ID</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #24292e; text-align: right;">STC-${String(student.student_id).padStart(4, "0")}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">New Assigned Seat(s)</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; font-weight: 700; color: #0366d6; text-align: right;">${seatList}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Reactivation Date</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${new Date().toISOString().slice(0, 10)}</td>
          </tr>
          <tr style="border-top: 1px solid #c6f6d5; font-weight: 700;">
            <td style="padding: 10px 0; color: #22543d;">Monthly Base Fee Plan</td>
            <td style="padding: 10px 0; text-align: right; color: #22543d;">₹${monthlyFee}/month</td>
          </tr>
        </table>
      </div>

      <p style="font-size: 14px; line-height: 1.6; color: #24292e;">
        Your recurring billing cycle will resume immediately from this month. Please visit the reception desk to settle any active month fees if applicable.
      </p>

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends an email notification when a student's seat allocation is changed/reallocated.
 */
async function sendSeatChangedEmail(student, oldSeatStr, newSeatStr) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const subject = `Seat Reallocation Notice - ${instituteName}`;
  const text = `Dear ${student.name},\n\nThis is an official notice that your seat allocation at ${instituteName} has been adjusted by center management.\n\nOld Seat Assignment: ${oldSeatStr}\nNew Seat Assignment: ${newSeatStr}\n\nIf you have any questions regarding this change, please contact the front desk at ${institutePhone}.\n\nThank you,\n${instituteName} Management`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #0366d6; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #586069; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Seat Reallocation Notice</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">This is an official notice regarding your seat assignment at <strong>${instituteName}</strong>.</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Your seat allocation has been adjusted by the administrator.</p>

      <div style="background-color: #f1f8ff; border: 1px solid #c8e1ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 12px; font-weight: 700; color: #0366d6; text-transform: uppercase; letter-spacing: 0.03em;">Seat Allocation Adjustments</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Previous Seat Assignment</td>
            <td style="padding: 6px 0; font-family: 'JetBrains Mono', monospace; text-decoration: line-through; color: #cb2431; text-align: right;">${oldSeatStr}</td>
          </tr>
          <tr style="font-weight: 700;">
            <td style="padding: 8px 0; color: #24292e;">New Assigned Seat(s)</td>
            <td style="padding: 8px 0; font-family: 'JetBrains Mono', monospace; color: #28a745; text-align: right; font-size: 15px;">${newSeatStr}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #586069; font-weight: 500;">Date of Effect</td>
            <td style="padding: 6px 0; color: #24292e; text-align: right;">${new Date().toISOString().slice(0, 10)}</td>
          </tr>
        </table>
      </div>

      <p style="font-size: 14px; line-height: 1.6; color: #24292e;">
        If you have any questions or require further assistance regarding this reallocation, please do not hesitate to speak to the administration at the reception desk.
      </p>

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

/**
 * Sends an absence notice email to a student who did not log in on a given date.
 */
async function sendAbsenceNoticeEmail(student, date) {
  if (!student.email) return;

  const appSettings = db
    .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
    .get();
  const instituteName = appSettings?.institute_name || "StudySpace";
  const instituteAddress = appSettings?.institute_address || "";
  const institutePhone = appSettings?.institute_phone || "";

  const formattedDate = new Date(date).toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const studentCode = `STC-${String(student.student_id).padStart(4, "0")}`;

  const subject = `Attendance Notice – ${formattedDate} | ${instituteName}`;
  const text = `Dear ${student.name},\n\nWe noticed that your attendance was not recorded at ${instituteName} on ${formattedDate}.\n\nIf you were present but faced any login issues, please contact the administration desk.\n\nRegular attendance is important for your progress. We encourage you to maintain consistent attendance.\n\nBest regards,\n${instituteName} Management`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff; border: 1px solid #e1e4e6; border-radius: 12px; color: #24292e; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <div style="text-align: center; border-bottom: 1px solid #e1e4e6; padding-bottom: 24px; margin-bottom: 24px;">
        <span style="font-size: 24px; font-weight: 700; color: #24292e; letter-spacing: -0.02em;">${instituteName}</span>
        <div style="font-size: 11px; text-transform: uppercase; color: #e36209; letter-spacing: 0.05em; font-weight: 600; margin-top: 4px;">Attendance Notice</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e; margin-top: 0;">Dear <strong>${student.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">We noticed that your attendance was <strong>not recorded</strong> at <strong>${instituteName}</strong> on:</p>

      <div style="background-color: #fff8f0; border: 1px solid #f9c513; border-left: 4px solid #e36209; border-radius: 8px; padding: 16px; font-size: 15px; font-weight: 600; color: #24292e; margin: 20px 0; text-align: center;">
        ${formattedDate}
      </div>

      <p style="font-size: 14px; line-height: 1.6; color: #586069;">Student ID: <strong>${studentCode}</strong></p>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">If you were physically present but encountered any login or technical issues, please visit the administration desk so we can update your attendance record.</p>

      <p style="font-size: 15px; line-height: 1.6; color: #24292e;">Regular and consistent attendance is key to achieving your academic goals. We encourage you to maintain regular attendance going forward.</p>

      <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e4e6; text-align: center; font-size: 12px; color: #586069; line-height: 1.5;">
        <strong>${instituteName} Management</strong><br>
        ${instituteAddress}<br>
        Contact: ${institutePhone}<br>
        <span style="font-size: 11px; color: #9aa3af; display: block; margin-top: 12px;">This is an automated operational notification. Please do not reply directly to this email.</span>
      </div>
    </div>
  `;

  return sendMail({ to: student.email, subject, html, text });
}

module.exports = {
  sendMail,
  sendWelcomeEmail,
  sendRequestWelcomeEmail,
  sendInvoiceEmail,
  sendPaymentReceiptEmail,
  sendOverdueWarningEmail,
  sendRegistrationCancellationEmail,
  sendSuspensionEmail,
  sendArchiveEmail,
  sendReactivationEmail,
  sendSeatChangedEmail,
  sendAbsenceNoticeEmail,
};
