const { db } = require("../db/init");

/**
 * Returns true if the system is currently in transition mode
 * (current month is strictly less than operational_start_month).
 */
function isTransitionMode() {
  const s = db.prepare("SELECT operational_start_month FROM app_settings WHERE setting_id = 1").get();
  const opMonth = s?.operational_start_month || null;
  if (!opMonth) return false;

  const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  return currentMonth < opMonth;
}

/**
 * Computes the correct billing_start_month for a student.
 * - Transition mode: returns operational_start_month
 * - Normal mode: returns current calendar month
 */
function getBillingStartMonth() {
  const s = db.prepare("SELECT operational_start_month FROM app_settings WHERE setting_id = 1").get();
  const opMonth = s?.operational_start_month || null;
  const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

  if (opMonth && currentMonth < opMonth) {
    return opMonth;
  }
  return currentMonth;
}

module.exports = { isTransitionMode, getBillingStartMonth };
