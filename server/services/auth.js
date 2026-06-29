const crypto = require("crypto");
const _bcryptImport = require("bcryptjs");
// bcryptjs v3 may wrap exports in a default property depending on bundler/Node version
const bcrypt = (_bcryptImport && typeof _bcryptImport.compareSync === "function")
  ? _bcryptImport
  : (_bcryptImport.default || _bcryptImport);
const { db, nowIso } = require("../db/init");

// Password hashing helpers
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

// Session helpers
function createSession(userId, userType) {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expiry = new Date();
  
  // Custom timeouts: 4 hours for admin, 60 minutes for student
  const minutes = userType === "admin" ? 240 : 60;
  expiry.setMinutes(expiry.getMinutes() + minutes);
  
  const created = nowIso();
  const expiresAt = expiry.toISOString();

  db.prepare(`
    INSERT INTO sessions (session_id, user_type, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionToken, userType, userId || null, expiresAt, created);

  return {
    token: sessionToken,
    expiresAt: expiry
  };
}

function getSession(token) {
  if (!token) return null;

  try {
    const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(token);
    if (!session) return null;

    const now = new Date();
    const expires = new Date(session.expires_at);

    if (now > expires) {
      deleteSession(token);
      return null;
    }

    return session;
  } catch (err) {
    console.error("[auth] Error fetching session:", err);
    return null;
  }
}

function deleteSession(token) {
  if (!token) return;
  try {
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(token);
  } catch (err) {
    console.error("[auth] Error deleting session:", err);
  }
}

function cleanupExpiredSessions() {
  try {
    const now = nowIso();
    const result = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    if (result.changes > 0) {
      console.log(`[auth] Cleaned up ${result.changes} expired session(s).`);
    }
  } catch (err) {
    console.error("[auth] Error cleaning up sessions:", err);
  }
}

// Run cleanup on startup
cleanupExpiredSessions();

// Run cleanup every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

module.exports = {
  hashPassword,
  comparePassword,
  createSession,
  getSession,
  deleteSession,
  cleanupExpiredSessions
};