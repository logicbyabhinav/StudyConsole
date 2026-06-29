const { db } = require('../db/init');

// 'HH:MM' -> minutes since midnight
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Normalize a time range to {start, end} in minutes, where end > start.
// If end <= start, the range crosses midnight (e.g. 22:00 -> 04:00), so add 24h to end.
function normalizeRange(startStr, endStr) {
  const start = toMinutes(startStr);
  let end = toMinutes(endStr);
  if (end <= start) end += 1440;
  return { start, end };
}

function durationHours(startStr, endStr) {
  const { start, end } = normalizeRange(startStr, endStr);
  return (end - start) / 60;
}

// These are daily-recurring schedules, not one-off events, so we check overlap
// across the 24h cycle: shift one range by -1440/0/+1440 minutes and test each.
function rangesOverlap(a, b) {
  for (const shift of [-1440, 0, 1440]) {
    if (a.start < b.end + shift && b.start + shift < a.end) return true;
  }
  return false;
}

/**
 * Returns all active seats that do NOT have any active allocation
 * overlapping the requested time range.
 * @param {string} startTime - 'HH:MM'
 * @param {string} endTime - 'HH:MM'
 * @param {number|null} excludeAllocationId - ignore this allocation (used when reallocating)
 * @param {string|null} targetDate - 'YYYY-MM-DD'
 */
function getAvailableSeats(startTime, endTime, excludeAllocationId = null, targetDate = null) {
  const dateToCheck = targetDate || new Date().toISOString().slice(0, 10);
  const requested = normalizeRange(startTime, endTime);

  const seats = db.prepare('SELECT * FROM seats WHERE active = 1 ORDER BY CAST(seat_number AS INTEGER)').all();

  const allocations = excludeAllocationId
    ? db.prepare('SELECT * FROM seat_allocations WHERE active = 1 AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?) AND allocation_id != ?').all(dateToCheck, dateToCheck, excludeAllocationId)
    : db.prepare('SELECT * FROM seat_allocations WHERE active = 1 AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)').all(dateToCheck, dateToCheck);

  const allocsBySeat = {};
  for (const a of allocations) {
    (allocsBySeat[a.seat_id] = allocsBySeat[a.seat_id] || []).push(a);
  }

  return seats.filter((seat) => {
    const seatAllocs = allocsBySeat[seat.seat_id] || [];
    return !seatAllocs.some((a) => rangesOverlap(requested, normalizeRange(a.start_time, a.end_time)));
  });
}

/**
 * Checks if a SPECIFIC seat is free for the requested time range.
 * Used to re-validate on save (never trust the client's earlier read).
 */
function isSeatAvailable(seatId, startTime, endTime, excludeAllocationId = null, targetDate = null) {
  const available = getAvailableSeats(startTime, endTime, excludeAllocationId, targetDate);
  return available.some((s) => s.seat_id === seatId);
}

module.exports = {
  toMinutes,
  normalizeRange,
  durationHours,
  rangesOverlap,
  getAvailableSeats,
  isSeatAvailable,
};
