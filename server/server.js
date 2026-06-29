const express = require("express");
const path = require("path");
const fs = require("fs");
const { init, db } = require("./db/init");
const { runBillingGenerator } = require("./services/billingGenerator");
const { runAuditEngine } = require("./services/auditEngine");

// Bug 9 fix: prevent any unhandled throw or rejected promise from killing the
// Node process. For an "install and forget" deployment with no auto-restart,
// keeping the server alive is more important than crashing clean.
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception — server kept alive:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error(
    "[fatal] Unhandled promise rejection — server kept alive:",
    reason,
  );
});

// ── Auto-Backup ───────────────────────────────────────────────────────────────
// Pure fs.copyFileSync — no packages, no async, nothing to fail.
// Runs on startup (before audit engine), every 2 hours, and on clean shutdown.
// Keeps the last 5 backups per trigger type; older ones are deleted automatically.
const DATA_DIR = path.join(__dirname, "../data");
const AUTO_BACKUP_DIR = path.join(DATA_DIR, "auto-backups");
const DB_PATH = path.join(DATA_DIR, "studycenter.db");
const PHOTOS_DB_PATH = path.join(DATA_DIR, "photos.db");
const AUTO_BACKUP_KEEP = 5;

function runAutoBackup(trigger) {
  try {
    if (!fs.existsSync(AUTO_BACKUP_DIR))
      fs.mkdirSync(AUTO_BACKUP_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const tag = `${trigger}-${ts}`;

    // Copy both db files
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(
        DB_PATH,
        path.join(AUTO_BACKUP_DIR, `studycenter-${tag}.db`),
      );
    }
    if (fs.existsSync(PHOTOS_DB_PATH)) {
      fs.copyFileSync(
        PHOTOS_DB_PATH,
        path.join(AUTO_BACKUP_DIR, `photos-${tag}.db`),
      );
    }

    // Prune: keep only the last AUTO_BACKUP_KEEP pairs for this trigger type
    const allFiles = fs.readdirSync(AUTO_BACKUP_DIR);
    ["studycenter", "photos"].forEach((prefix) => {
      const files = allFiles
        .filter((f) => f.startsWith(`${prefix}-${trigger}-`))
        .sort(); // ISO timestamps sort lexicographically = chronologically
      if (files.length > AUTO_BACKUP_KEEP) {
        files.slice(0, files.length - AUTO_BACKUP_KEEP).forEach((f) => {
          try {
            fs.unlinkSync(path.join(AUTO_BACKUP_DIR, f));
          } catch (_) {}
        });
      }
    });

    console.log(`[auto-backup] ${trigger} snapshot saved (${tag})`);
  } catch (err) {
    // Never crash the server over a backup failure — just log it
    console.error(`[auto-backup] ${trigger} snapshot failed:`, err.message);
  }
}

init(); // create tables + seed defaults if first run

// ── Session Wipe on Startup ───────────────────────────────────────────────────
// All sessions from the previous run are deleted the moment the server starts.
// This means every browser cookie issued before this restart is immediately
// invalid — nobody can land on a protected page without logging in fresh.
// This is the fix for the "opens straight to dashboard" problem: the old
// session_token cookie the browser kept is now dead on the server side, so
// the HTML Guard below will redirect to /login.html instead of accepting it.
try {
  const wiped = db.prepare("DELETE FROM sessions").run();
  console.log(
    `[startup] Sessions cleared (${wiped.changes} wiped). Fresh login required.`,
  );
} catch (err) {
  console.error("[startup] Could not wipe sessions:", err.message);
}

// Startup snapshot — captures state before billing/audit engine modifies anything
runAutoBackup("startup");

// Catch-up jobs: idempotent on every startup
const billingResult = runBillingGenerator();
const auditResult = runAuditEngine();
console.log(
  `Billing generator: ${billingResult.generated} record(s) created for ${billingResult.month}.`,
);
console.log(
  `Audit engine: ${auditResult.finesApplied} fine(s) applied, ${auditResult.finesReverted || 0} fine(s) reverted, ${auditResult.suspended} student(s) suspended, ${auditResult.reactivated} reactivated.`,
);

const app = express();
app.use(express.json());

// ── Security Headers ──────────────────────────────────────────────────────────
// Applied to every response. Prevents clickjacking, MIME sniffing, and leaking
// the server tech stack. Not a substitute for auth, but hardens the surface.
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Powered-By", ""); // don't advertise Express
  res.removeHeader("X-Powered-By");
  // Prevent browsers from caching authenticated pages
  if (req.path.endsWith(".html") || req.path === "/") {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private",
    );
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

// ── Cookie Parser ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      if (parts.length >= 2) {
        req.cookies[parts[0].trim()] = parts.slice(1).join("=").trim();
      }
    });
  }
  next();
});

const { getSession } = require("./services/auth");

// ── Login Brute-Force Rate Limiter ────────────────────────────────────────────
// Tracks failed login attempts per IP. After 10 failures in a 15-minute window
// the IP is locked out for 15 minutes. This is in-memory and resets on server
// restart — suitable for a single-machine local deployment.
const loginAttempts = new Map(); // ip -> { count, firstAt, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min

function checkLoginRateLimit(ip) {
  const now = Date.now();
  let record = loginAttempts.get(ip);

  if (record?.lockedUntil) {
    if (now < record.lockedUntil) {
      const secsLeft = Math.ceil((record.lockedUntil - now) / 1000);
      return { blocked: true, secsLeft };
    }
    // Lockout expired — reset
    loginAttempts.delete(ip);
    record = null;
  }

  if (record && now - record.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    record = null;
  }

  return { blocked: false, record };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, firstAt: now };
  record.count++;
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
  loginAttempts.set(ip, record);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// Expose helpers so auth.js route can call them
app.locals.rateLimiter = {
  checkLoginRateLimit,
  recordFailedLogin,
  clearLoginAttempts,
};

// ── HTML Guard ────────────────────────────────────────────────────────────────
// Every .html request (and /) is intercepted here. No HTML page is served
// without a valid, correctly-typed session — except /login.html itself.
// The root path / always redirects to /login.html (not /dashboard.html).
//
// NOTE: /login.html is NEVER auto-redirected away from, even if a session
// cookie exists. Since sessions are wiped on every server start, a stale
// cookie from a previous run will simply fail getSession() and the user
// sees the login form. This is the intended behaviour.
app.use((req, res, next) => {
  const urlPath = req.path;
  const isHtmlRequest = urlPath.endsWith(".html") || urlPath === "/";

  if (!isHtmlRequest) return next();

  // Root → always login page
  if (urlPath === "/") {
    return res.redirect("/login.html");
  }

  const page = urlPath;
  const token = req.cookies.session_token;
  const session = getSession(token);

  // /login.html — always serve it. Never auto-redirect to dashboard.
  // If someone has a valid active session they can navigate there themselves
  // after logging in. We never skip the login step on their behalf.
  if (page === "/login.html") {
    return next();
  }

  // /register.html — always public (prospective student intake form)
  if (page === "/register.html") {
    return next();
  }

  // All other pages require a valid session
  if (!session) {
    return res.redirect("/login.html");
  }

  // Role-based page access
  if (page === "/student-portal.html") {
    if (session.user_type !== "student") return res.redirect("/dashboard.html");
    return next();
  } else {
    // Every other page is admin-only
    if (session.user_type !== "admin")
      return res.redirect("/student-portal.html");
    return next();
  }
});

// ── API Guard ─────────────────────────────────────────────────────────────────
// Strictly enumerate what is public. Everything else requires a valid session.
// Students can only reach /api/student/* paths.
app.use("/api", (req, res, next) => {
  const p = req.path;
  const method = req.method;

  // Public API endpoints — keep this list as short as possible
  const isPublic =
    p === "/student/login" || // login
    p === "/student/logout" || // safe to call even unauthenticated
    (p === "/registrations" && method === "POST") || // public registration form submit
    (p === "/registrations/config" && method === "GET") || // registration form config
    (p === "/app-settings/public" && method === "GET") || // only institute_name for register page
    (p === "/seats/available" && method === "GET"); // seat picker on register form

  if (isPublic) return next();

  // All other API routes require a valid session
  const token = req.cookies.session_token;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }

  req.session = session;

  // Students may only call /api/student/* routes
  if (session.user_type !== "admin" && !p.startsWith("/student/")) {
    return res.status(403).json({ error: "Forbidden." });
  }

  next();
});

// ── Static Files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/student", require("./routes/auth"));

app.use("/api/students", require("./routes/students"));
app.use("/api/seats", require("./routes/seats"));
app.use("/api/fees", require("./routes/fees"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/app-settings", require("./routes/settings"));
app.use("/api/backup", require("./routes/backup"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/registrations", require("./routes/registrations"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/reallocations", require("./routes/reallocations"));

// ── Live Stream (SSE) ─────────────────────────────────────────────────────────
// Auth-gated: only authenticated sessions may subscribe to change events.
const { registerClient, broadcastChange } = require("./services/liveStream");

app.get("/api/live-stream", (req, res) => {
  const token = req.cookies.session_token;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  registerClient(req, res);
});

// ── Dev Live Reloader ─────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, "../public");
let reloadTimer;
if (fs.existsSync(publicDir)) {
  fs.watch(publicDir, { recursive: true }, (eventType, filename) => {
    if (filename) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log(`[watcher] Live reload triggered for: ${filename}`);
        broadcastChange("reload");
      }, 150);
    }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Study Center server running at http://localhost:${PORT}`);
});

// ── Periodic Auto-Backup (every 2 hours) ─────────────────────────────────────
setInterval(() => runAutoBackup("interval"), 2 * 60 * 60 * 1000);

// ── Shutdown Reminder + Backup ────────────────────────────────────────────────
// First Ctrl+C saves a shutdown snapshot and prints a reminder.
// Second Ctrl+C exits.
let shutdownWarned = false;
process.on("SIGINT", () => {
  if (!shutdownWarned) {
    shutdownWarned = true;
    runAutoBackup("shutdown");
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║  ⚠  Auto-backup saved to data/auto-backups/             ║");
    console.log(
      "║     You can also download a manual backup from Settings.  ║",
    );
    console.log("║     Press Ctrl+C again to exit.                          ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log("\n");
  } else {
    console.log("[shutdown] Exiting. Goodbye!");
    process.exit(0);
  }
});
