const express = require("express");
const router = express.Router();
const { db, nowIso } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");
const os = require("os");

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

// GET /api/app-settings/public - minimal public info for the registration form only.
// Returns ONLY institute_name. No SMTP, no audit config, no internal IP addresses.
router.get("/public", (req, res) => {
  try {
    const appSettings = db
      .prepare("SELECT institute_name FROM app_settings WHERE setting_id = 1")
      .get();
    res.json({ institute_name: appSettings?.institute_name || "StudySpace" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/app-settings - full settings (admin sessions only, enforced by API Guard)
router.get("/", (req, res) => {
  try {
    const appSettings = db
      .prepare("SELECT * FROM app_settings WHERE setting_id = 1")
      .get();
    const auditSettings = db
      .prepare("SELECT * FROM audit_settings WHERE setting_id = 1")
      .get();
    const emailSettings = db
      .prepare("SELECT * FROM email_settings WHERE setting_id = 1")
      .get();

    const localIp = getLocalIp();
    const port = req.socket?.localPort || 3000;
    const registrationUrl = `http://${localIp}:${port}/login.html`;

    res.json({
      ...appSettings,
      operational_start_month: appSettings?.operational_start_month || null,
      audit_date: auditSettings?.audit_day,
      fine_amount: auditSettings?.fine_amount,
      admission_fee: auditSettings?.admission_fee,
      partial_fine_amount: auditSettings?.partial_fine_amount,
      partial_exemption_months: auditSettings?.partial_exemption_months,
      suspension_threshold: auditSettings?.suspension_threshold_months,

      // SMTP Email configuration fields
      smtp_host: emailSettings?.smtp_host || "smtp.gmail.com",
      smtp_port: emailSettings?.smtp_port || 465,
      smtp_secure: emailSettings?.smtp_secure ?? 1,
      sender_email: emailSettings?.sender_email || "",
      email_active: emailSettings?.active ?? 0,
      has_sender_password: emailSettings?.sender_password ? 1 : 0,

      // Local network info
      local_ip: localIp,
      registration_url: registrationUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/app-settings - update settings
router.put("/", (req, res) => {
  const {
    institute_name,
    institute_address,
    institute_phone,
    total_seats,
    section_size,
    operational_start_month,
    audit_date,
    fine_amount,
    admission_fee,
    partial_fine_amount,
    partial_exemption_months,
    suspension_threshold,
  } = req.body;

  try {
    // Ensure settings rows exist (safety check)
    const settingsExists = db
      .prepare("SELECT 1 FROM app_settings WHERE setting_id = 1")
      .get();
    if (!settingsExists) {
      db.prepare(
        "INSERT INTO app_settings (setting_id, total_seats, section_size, created_at) VALUES (1, 0, 0, ?)",
      ).run(nowIso());
    }
    const auditExists = db
      .prepare("SELECT 1 FROM audit_settings WHERE setting_id = 1")
      .get();
    if (!auditExists) {
      db.prepare(
        "INSERT INTO audit_settings (setting_id, audit_day, fine_amount, admission_fee, partial_fine_amount, partial_exemption_months, suspension_threshold_months, updated_at) VALUES (1, 28, 0, 0, 0, 0, 1, ?)",
      ).run(nowIso());
    }

    // Update app_settings
    // Update operational_start_month if provided (stored on app_settings)
    if (operational_start_month !== undefined) {
      // Allow null/empty to clear the field
      const val =
        operational_start_month && /^\d{4}-\d{2}$/.test(operational_start_month)
          ? operational_start_month
          : null;
      db.prepare(
        "UPDATE app_settings SET operational_start_month = ? WHERE setting_id = 1",
      ).run(val);
    }

    if (
      institute_name !== undefined ||
      institute_address !== undefined ||
      institute_phone !== undefined ||
      total_seats !== undefined ||
      section_size !== undefined
    ) {
      if (total_seats !== undefined && section_size !== undefined) {
        // Changing seat configuration dynamically adds or removes seats without losing student/billing data
        const runSeatUpdate = db.transaction(() => {
          // 1. Generate target seats
          const targetSeats = [];
          for (let i = 1; i <= total_seats; i++) {
            const seatNumber = String(i);
            const gx = (i - 1) % 12;
            const gy = Math.floor((i - 1) / 12);
            const sectionIndex = Math.floor((i - 1) / section_size);
            const sectionLetter = String.fromCharCode(65 + sectionIndex);
            targetSeats.push({ seatNumber, sectionLetter, gx, gy });
          }

          // 2. Fetch existing seats
          const existingSeats = db.prepare("SELECT * FROM seats").all();
          const existingMap = new Map();
          existingSeats.forEach((s) => existingMap.set(s.seat_number, s));

          // 3. Determine additions
          const insertSeat = db.prepare(`
            INSERT INTO seats (seat_number, section, active, grid_x, grid_y, created_at) VALUES (?, ?, 1, ?, ?, ?)
          `);
          targetSeats.forEach((ts) => {
            if (!existingMap.has(ts.seatNumber)) {
              insertSeat.run(
                ts.seatNumber,
                ts.sectionLetter,
                ts.gx,
                ts.gy,
                nowIso(),
              );
            }
          });

          // 4. Determine deletions
          const targetSeatNumbers = new Set(
            targetSeats.map((ts) => ts.seatNumber),
          );
          const deleteSeat = db.prepare("DELETE FROM seats WHERE seat_id = ?");
          const checkAlloc = db.prepare(
            "SELECT COUNT(*) c FROM seat_allocations WHERE seat_id = ? AND active = 1",
          );

          existingSeats.forEach((es) => {
            if (!targetSeatNumbers.has(es.seat_number)) {
              // Check if seat is actively allocated
              const activeCount = checkAlloc.get(es.seat_id).c;
              if (activeCount > 0) {
                throw new Error(
                  `Cannot delete or rename seat "${es.seat_number}" because it has active student allocations. Please release those seats first.`,
                );
              }
              // Delete unused seat
              deleteSeat.run(es.seat_id);
            }
          });

          // 5. Update settings
          db.prepare(
            `
            UPDATE app_settings 
            SET total_seats = ?, section_size = ? 
            WHERE setting_id = 1
          `,
          ).run(total_seats, section_size);
        });
        runSeatUpdate();
      } else {
        const updates = [];
        const values = [];
        if (institute_name !== undefined) {
          updates.push("institute_name = ?");
          values.push(institute_name);
        }
        if (institute_address !== undefined) {
          updates.push("institute_address = ?");
          values.push(institute_address);
        }
        if (institute_phone !== undefined) {
          updates.push("institute_phone = ?");
          values.push(institute_phone);
        }
        if (total_seats !== undefined) {
          updates.push("total_seats = ?");
          values.push(total_seats);
        }
        if (section_size !== undefined) {
          updates.push("section_size = ?");
          values.push(section_size);
        }
        if (updates.length > 0) {
          values.push(1);
          db.prepare(
            `UPDATE app_settings SET ${updates.join(", ")} WHERE setting_id = ?`,
          ).run(...values);
        }
      }
    }

    // Update audit_settings
    if (
      audit_date !== undefined ||
      fine_amount !== undefined ||
      admission_fee !== undefined ||
      partial_fine_amount !== undefined ||
      partial_exemption_months !== undefined ||
      suspension_threshold !== undefined
    ) {
      const auditUpdates = [];
      const auditValues = [];
      if (audit_date !== undefined) {
        auditUpdates.push("audit_day = ?");
        // February bug fix: clamp to 28 so day 29/30/31 never overflows into March.
        auditValues.push(Math.min(parseInt(audit_date, 10) || 1, 28));
      }
      if (fine_amount !== undefined) {
        auditUpdates.push("fine_amount = ?");
        auditValues.push(fine_amount);
      }
      if (admission_fee !== undefined) {
        auditUpdates.push("admission_fee = ?");
        auditValues.push(admission_fee);
      }
      if (partial_fine_amount !== undefined) {
        auditUpdates.push("partial_fine_amount = ?");
        auditValues.push(partial_fine_amount);
      }
      if (partial_exemption_months !== undefined) {
        auditUpdates.push("partial_exemption_months = ?");
        auditValues.push(partial_exemption_months);
      }
      if (suspension_threshold !== undefined) {
        auditUpdates.push("suspension_threshold_months = ?");
        auditValues.push(suspension_threshold);
      }
      auditUpdates.push("updated_at = ?");
      auditValues.push(nowIso());
      auditValues.push(1);
      db.prepare(
        `UPDATE audit_settings SET ${auditUpdates.join(", ")} WHERE setting_id = ?`,
      ).run(...auditValues);
    }

    // Update email_settings
    const {
      smtp_host,
      smtp_port,
      smtp_secure,
      sender_email,
      sender_password,
      email_active,
    } = req.body;

    if (
      smtp_host !== undefined ||
      smtp_port !== undefined ||
      smtp_secure !== undefined ||
      sender_email !== undefined ||
      sender_password !== undefined ||
      email_active !== undefined
    ) {
      const emailUpdates = [];
      const emailValues = [];
      if (smtp_host !== undefined) {
        emailUpdates.push("smtp_host = ?");
        emailValues.push(smtp_host);
      }
      if (smtp_port !== undefined) {
        emailUpdates.push("smtp_port = ?");
        emailValues.push(smtp_port);
      }
      if (smtp_secure !== undefined) {
        emailUpdates.push("smtp_secure = ?");
        emailValues.push(smtp_secure);
      }
      if (sender_email !== undefined) {
        emailUpdates.push("sender_email = ?");
        emailValues.push(sender_email);
      }
      if (sender_password !== undefined && sender_password.trim() !== "") {
        emailUpdates.push("sender_password = ?");
        emailValues.push(sender_password);
      }
      if (email_active !== undefined) {
        emailUpdates.push("active = ?");
        emailValues.push(email_active);
      }
      if (emailUpdates.length > 0) {
        emailValues.push(1);
        db.prepare(
          `UPDATE email_settings SET ${emailUpdates.join(", ")} WHERE setting_id = ?`,
        ).run(...emailValues);
      }
    }

    // Sync seat sections in database if settings changed
    const appSettings = db
      .prepare("SELECT section_size FROM app_settings WHERE setting_id = 1")
      .get();
    const sectionSize =
      (appSettings && appSettings.section_size) > 0
        ? appSettings.section_size
        : 10;
    const seats = db.prepare("SELECT * FROM seats").all();
    const updateStmt = db.prepare(
      "UPDATE seats SET section = ? WHERE seat_id = ?",
    );
    const tx = db.transaction(() => {
      for (const s of seats) {
        const seatNum = parseInt(s.seat_number, 10);
        if (!isNaN(seatNum)) {
          const idx = Math.floor((seatNum - 1) / sectionSize);
          const sect = String.fromCharCode(65 + idx);
          if (s.section !== sect) {
            updateStmt.run(sect, s.seat_id);
          }
        }
      }
    });
    tx();

    broadcastChange("settings");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/app-settings/test-email - send a test email to verify SMTP configuration
router.post("/test-email", async (req, res) => {
  const { toEmail } = req.body;
  if (!toEmail) {
    return res.status(400).json({ error: "Recipient email is required." });
  }

  const { sendMail } = require("../services/emailService");
  try {
    const appSettings = db
      .prepare("SELECT institute_name FROM app_settings WHERE setting_id = 1")
      .get();
    const institute = appSettings?.institute_name || "StudySpace";

    const success = await sendMail({
      to: toEmail,
      subject: `${institute} SMTP Test Email`,
      text: `Hello! This is a test email from your ${institute} Study Center Management System. If you are reading this, your SMTP configuration is correct and active!`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; border: 1px solid #c6f6d5; border-radius: 12px; background-color: #f0fff4; color: #2d3748; box-shadow: 0 4px 12px rgba(0,0,0,0.02);">
          <h2 style="color: #22543d; margin-top: 0; border-bottom: 1px solid #c6f6d5; padding-bottom: 12px; font-weight: 700; letter-spacing: -0.02em;">SMTP Test Successful!</h2>
          <p>Hello,</p>
          <p>This is a test email confirming that your <strong>${institute}</strong> SMTP configurations are correct and active.</p>
          <p>You can now receive automated student registrations, monthly fee alerts, and receipt notifications.</p>
          <hr style="border: 0; border-top: 1px solid #c6f6d5; margin: 24px 0;">
          <p style="font-size: 11px; color: #718096; text-align: center;">${institute} Study Center Management System</p>
        </div>
      `,
    });

    if (success) {
      res.json({ success: true, message: "Test email sent successfully." });
    } else {
      res.status(500).json({
        error: "Failed to send email. Check your SMTP configurations or logs.",
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
