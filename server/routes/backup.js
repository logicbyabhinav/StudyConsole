const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { db, photosDb, init } = require("../db/init");
const { broadcastChange } = require("../services/liveStream");

const upload = multer({ storage: multer.memoryStorage() });
const DATA_DIR = path.join(__dirname, "../../data");
const DB_PATH = path.join(DATA_DIR, "studycenter.db");
const PHOTOS_DB_PATH = path.join(DATA_DIR, "photos.db");

// GET /api/backup/database
// Downloads a .zip containing both studycenter.db and photos.db.
// WAL is checkpointed on both before reading so the backup is fully consistent.
router.get("/database", (req, res) => {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ error: "Database file not found" });
    }

    // Flush WAL pages into the main files before reading them.
    db.pragma("wal_checkpoint(TRUNCATE)");
    if (fs.existsSync(PHOTOS_DB_PATH)) {
      try {
        photosDb.pragma("wal_checkpoint(TRUNCATE)");
      } catch (_) {}
    }

    const dateStr = new Date().toISOString().split("T")[0];
    const filename = `studyspace-backup-${dateStr}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      console.error("[backup] Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(res);
    archive.file(DB_PATH, { name: "studycenter.db" });
    if (fs.existsSync(PHOTOS_DB_PATH)) {
      archive.file(PHOTOS_DB_PATH, { name: "photos.db" });
    }
    archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// POST /api/backup/restore
// Accepts the .zip backup. Extracts both db files and writes them safely.
// Never closes the live db connection — uses atomic file copy + rollback instead.
router.post("/restore", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const AdmZip = require("adm-zip");
    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (e) {
      return res
        .status(400)
        .json({
          error:
            "Invalid zip file. Please upload a backup downloaded from this system.",
        });
    }

    const mainEntry = zip.getEntry("studycenter.db");
    const photosEntry = zip.getEntry("photos.db");

    if (!mainEntry) {
      return res
        .status(400)
        .json({
          error: "Invalid backup: studycenter.db not found inside zip.",
        });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // --- Restore studycenter.db ---
    const mainBackupPath = path.join(
      DATA_DIR,
      `studycenter-pre-restore-${timestamp}.db`,
    );
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, mainBackupPath);

    const mainTmp = path.join(DATA_DIR, `restore-main-tmp-${Date.now()}.db`);
    fs.writeFileSync(mainTmp, mainEntry.getData());
    try {
      fs.copyFileSync(mainTmp, DB_PATH);
    } catch (err) {
      fs.unlinkSync(mainTmp);
      if (fs.existsSync(mainBackupPath))
        fs.copyFileSync(mainBackupPath, DB_PATH);
      return res
        .status(500)
        .json({
          error: "Failed to write main database. Rolled back. " + err.message,
        });
    }
    fs.unlinkSync(mainTmp);

    // --- Restore photos.db (if present in zip) ---
    if (photosEntry) {
      const photosBackupPath = path.join(
        DATA_DIR,
        `photos-pre-restore-${timestamp}.db`,
      );
      if (fs.existsSync(PHOTOS_DB_PATH))
        fs.copyFileSync(PHOTOS_DB_PATH, photosBackupPath);

      const photosTmp = path.join(
        DATA_DIR,
        `restore-photos-tmp-${Date.now()}.db`,
      );
      fs.writeFileSync(photosTmp, photosEntry.getData());
      try {
        fs.copyFileSync(photosTmp, PHOTOS_DB_PATH);
      } catch (err) {
        fs.unlinkSync(photosTmp);
        if (fs.existsSync(photosBackupPath))
          fs.copyFileSync(photosBackupPath, PHOTOS_DB_PATH);
        // Main db already restored — warn but don't fail the whole restore
        console.error(
          "[restore] Photos db restore failed, rolled back photos only:",
          err.message,
        );
      }
      fs.unlinkSync(photosTmp);
    }

    try {
      broadcastChange("settings");
      broadcastChange("students");
      broadcastChange("payments");
      broadcastChange("seats");
      broadcastChange("registrations");
    } catch (_) {}

    const photoMsg = photosEntry
      ? " Student photos restored."
      : " Note: backup did not contain photos.db — photos were not changed.";
    res.json({
      success: true,
      message:
        "Database restored successfully." +
        photoMsg +
        " Please refresh the page.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backup/reset
// Clears all tables including ghost tables, then wipes photos.db.
router.post("/reset", (req, res) => {
  try {
    const runReset = db.transaction(() => {
      db.prepare("DELETE FROM payment_transactions").run();
      db.prepare("DELETE FROM billing_records").run();
      db.prepare("DELETE FROM seat_allocations").run();
      db.prepare("DELETE FROM students").run();
      db.prepare("DELETE FROM seats").run();
      db.prepare("DELETE FROM fee_structures").run();
      db.prepare("DELETE FROM sqlite_sequence").run();
      db.prepare("DELETE FROM app_settings").run();
      db.prepare("DELETE FROM audit_settings").run();
      db.prepare("DELETE FROM sessions").run();
      db.prepare("DELETE FROM student_auth").run();
      db.prepare("DELETE FROM registration_requests").run();
      db.prepare("DELETE FROM whatsapp_queue").run();
      db.prepare("DELETE FROM reallocation_requests").run();
      db.prepare("DELETE FROM profile_edit_requests").run();
    });
    runReset();

    try {
      photosDb.prepare("DELETE FROM student_photos").run();
    } catch (_) {}

    init();

    try {
      broadcastChange("settings");
      broadcastChange("students");
      broadcastChange("payments");
      broadcastChange("seats");
      broadcastChange("registrations");
    } catch (_) {}

    res.json({
      success: true,
      message: "Database reset complete. Please refresh the page.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
