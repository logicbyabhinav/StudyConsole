const { db } = require('../db/init');
const { normalizeRange, rangesOverlap } = require('./seatAvailability');

// ---------------------------------------------------------------------------
// Gender-Segregation Seat Allocator
//
// Priority order (hard tiers, not just scores):
//   Tier 1 — Existing pure same-gender section (no opposite gender at all)
//   Tier 2 — Empty section (nearest to same-gender cluster)
//   Tier 3 — Mixed section (both genders already present)
//   Tier 4 — Pure opposite-gender section (absolute last resort)
//
// Within each tier, seats are scored by:
//   + same-gender neighbour adjacency   (+60)
//   + lower seat number               (natural sort tiebreak)
//
// The tier boundary is hard: Tier 2 only activates when zero Tier 1 seats
// exist, Tier 3 only when both Tier 1 and Tier 2 are exhausted, etc.
// This guarantees mixing never happens as long as any clean option exists,
// regardless of vacancy rates.
// ---------------------------------------------------------------------------

/**
 * Build shared context used by both proposeSeat and validateSeatSelection.
 * Returns: { allSeats, seatOccupants, sectionStats, vacantSeats }
 */
function buildContext(startTime, endTime, targetDate = null, excludeStudentId = null) {
  const dateToCheck = targetDate || new Date().toISOString().slice(0, 10);
  const requested = normalizeRange(startTime, endTime);

  const settings = db.prepare('SELECT section_size FROM app_settings WHERE setting_id = 1').get();
  const sectionSize = (settings && settings.section_size > 0) ? settings.section_size : 10;

  const allSeats = db.prepare(
    'SELECT * FROM seats WHERE active = 1 ORDER BY CAST(seat_number AS INTEGER)'
  ).all();

  // Attach computed section labels
  for (const s of allSeats) {
    const n = parseInt(s.seat_number, 10);
    if (!isNaN(n)) {
      s.section = String.fromCharCode(65 + Math.floor((n - 1) / sectionSize));
    } else {
      s.section = s.section || 'A';
    }
  }

  const allocations = db.prepare(`
    SELECT sa.*, st.gender, st.name
    FROM seat_allocations sa
    JOIN students st ON st.student_id = sa.student_id
    WHERE sa.active = 1
      AND st.status = 'Active'
      AND sa.valid_from <= ?
      AND (sa.valid_to IS NULL OR sa.valid_to >= ?)
  `).all(dateToCheck, dateToCheck);

  // Only keep allocations that time-overlap with the request
  const overlapping = allocations.filter(a =>
    a.student_id !== excludeStudentId &&
    rangesOverlap(requested, normalizeRange(a.start_time, a.end_time))
  );

  // seat_id -> [{ gender, name }, ...]
  const seatOccupants = {};
  for (const a of overlapping) {
    (seatOccupants[a.seat_id] = seatOccupants[a.seat_id] || []).push(
      { gender: a.gender, name: a.name }
    );
  }

  // section -> { maleCount, femaleCount, totalCount }
  const sectionStats = {};
  for (const s of allSeats) {
    if (!sectionStats[s.section]) {
      sectionStats[s.section] = { maleCount: 0, femaleCount: 0, totalCount: 0 };
    }
    sectionStats[s.section].totalCount++;
    const occupants = seatOccupants[s.seat_id] || [];
    for (const o of occupants) {
      if (o.gender === 'Male')   sectionStats[s.section].maleCount++;
      if (o.gender === 'Female') sectionStats[s.section].femaleCount++;
    }
  }

  const vacantSeats = allSeats.filter(
    s => !seatOccupants[s.seat_id] || seatOccupants[s.seat_id].length === 0
  );

  return { allSeats, seatOccupants, sectionStats, vacantSeats };
}

/**
 * Classify a section for a given target gender.
 *   'same'     — only target gender present (or empty with adjacency bonus)
 *   'empty'    — no one seated here yet
 *   'mixed'    — both genders present
 *   'opposite' — only opposite gender present
 */
function classifySection(section, gender, sectionStats) {
  const stat = sectionStats[section];
  if (!stat) return 'empty';

  const isFemale = gender === 'Female';
  const sameCount     = isFemale ? stat.femaleCount : stat.maleCount;
  const oppositeCount = isFemale ? stat.maleCount   : stat.femaleCount;

  if (sameCount === 0 && oppositeCount === 0) return 'empty';
  if (sameCount >  0 && oppositeCount === 0) return 'same';
  if (sameCount === 0 && oppositeCount >  0) return 'opposite';
  return 'mixed';
}

/**
 * Alphabetical distance between two section labels (e.g. 'A', 'C' -> 2).
 */
function sectionDistance(a, b) {
  return Math.abs(a.charCodeAt(0) - b.charCodeAt(0));
}

/**
 * Nearest distance (in section labels) from `sect` to any section in `targets`.
 * Returns Infinity if targets is empty.
 */
function minDistToSections(sect, targets) {
  if (targets.length === 0) return Infinity;
  return Math.min(...targets.map(t => sectionDistance(sect, t)));
}

/**
 * Score a seat WITHIN its tier (used only to rank seats of the same priority).
 * Tiebreak rules:
 *   1. +60 if adjacent seat has same-gender occupant
 *   2. Lower seat number (handled by sort after scoring)
 */
function inTierScore(seat, gender, allSeats, seatOccupants) {
  const seatNum = parseInt(seat.seat_number, 10);
  if (isNaN(seatNum)) return 0;

  const neighbours = allSeats.filter(
    s => s.section === seat.section &&
         Math.abs(parseInt(s.seat_number, 10) - seatNum) === 1
  );

  const hasSameNeighbour = neighbours.some(s =>
    (seatOccupants[s.seat_id] || []).some(o => o.gender === gender)
  );

  return hasSameNeighbour ? 60 : 0;
}

/**
 * Main seat proposal engine.
 *
 * @param {'Male'|'Female'|'Other'} gender
 * @param {string} startTime  'HH:MM'
 * @param {string} endTime    'HH:MM'
 * @param {string|null} targetDate  'YYYY-MM-DD'
 * @param {number|null} excludeStudentId
 */
function proposeSeat(gender, startTime, endTime, targetDate = null, excludeStudentId = null) {
  const { allSeats, seatOccupants, sectionStats, vacantSeats } = buildContext(
    startTime, endTime, targetDate, excludeStudentId
  );

  if (allSeats.length === 0) {
    return { proposed_seat: null, confidence: 'Low',
             reasons: ['No active seats configured in the system.'] };
  }
  if (vacantSeats.length === 0) {
    return { proposed_seat: null, confidence: 'Low',
             reasons: ['All seats are occupied during the requested timings.'] };
  }

  // For 'Other' gender: no segregation rules — pick lowest available seat
  if (gender !== 'Male' && gender !== 'Female') {
    const seat = vacantSeats[0];
    return {
      proposed_seat: seat.seat_number,
      confidence: 'High',
      reasons: ['Neutral allocation — no gender preference applied.']
    };
  }

  // ── Classify every vacant seat into a hard tier ──────────────────────────
  //
  // Tier 1: pure same-gender section (safest, top priority)
  // Tier 2: empty section (no one seated; safe expansion zone)
  // Tier 3: mixed section (both genders already there, unavoidable mixing)
  // Tier 4: pure opposite-gender section (last resort, forces mixing)

  const sameSections     = Object.keys(sectionStats).filter(s => classifySection(s, gender, sectionStats) === 'same');
  const emptySections    = Object.keys(sectionStats).filter(s => classifySection(s, gender, sectionStats) === 'empty');
  const mixedSections    = Object.keys(sectionStats).filter(s => classifySection(s, gender, sectionStats) === 'mixed');
  const oppositeSections = Object.keys(sectionStats).filter(s => classifySection(s, gender, sectionStats) === 'opposite');

  const tier1 = vacantSeats.filter(s => sameSections.includes(s.section));
  const tier2 = vacantSeats.filter(s => emptySections.includes(s.section));
  const tier3 = vacantSeats.filter(s => mixedSections.includes(s.section));
  const tier4 = vacantSeats.filter(s => oppositeSections.includes(s.section));

  // ── Pick the highest non-empty tier ──────────────────────────────────────

  let candidates = [];
  let tierLabel  = '';
  let tierNum    = 0;

  if (tier1.length > 0) {
    candidates = tier1;
    tierLabel  = `Existing ${gender} section`;
    tierNum    = 1;
  } else if (tier2.length > 0) {
    // Within Tier 2, prefer empty sections closest to an existing same-gender section
    // so the gender cluster expands naturally.
    candidates = tier2;
    tierLabel  = 'Empty section (gender-safe expansion)';
    tierNum    = 2;
  } else if (tier3.length > 0) {
    candidates = tier3;
    tierLabel  = 'Mixed section (no pure option available)';
    tierNum    = 3;
  } else {
    candidates = tier4;
    tierLabel  = 'Opposite-gender section (last resort — centre is full)';
    tierNum    = 4;
  }

  // ── Score within the tier ─────────────────────────────────────────────────

  const scored = candidates.map(seat => {
    let score = inTierScore(seat, gender, allSeats, seatOccupants);

    // Tier 2 only: add proximity-to-same-gender-cluster bonus so expansion
    // happens in the section nearest the existing gender cluster, keeping
    // boys and girls as far apart as possible.
    if (tierNum === 2) {
      const dist = minDistToSections(seat.section, sameSections);
      // dist=0 means adjacent section; dist=Infinity means no same-gender cluster yet
      // Closer is better when a cluster already exists; if no cluster yet, score neutrally.
      score += dist === Infinity ? 20 : Math.max(0, 40 - dist * 10);
    }

    return { seat, score };
  });

  // Sort: highest score first, then lowest seat number for stable tiebreaking
  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : parseInt(a.seat.seat_number, 10) - parseInt(b.seat.seat_number, 10)
  );

  const best = scored[0].seat;

  // ── Build human-readable reasons ─────────────────────────────────────────

  const reasons = [];
  reasons.push(tierLabel);

  if (tierNum === 1) {
    reasons.push(`Section ${best.section} is a pure ${gender} section — no mixing required.`);
  } else if (tierNum === 2) {
    if (sameSections.length > 0) {
      const nearest = sameSections.reduce((a, b) =>
        sectionDistance(best.section, a) <= sectionDistance(best.section, b) ? a : b
      );
      reasons.push(`Section ${best.section} is empty. Nearest ${gender} cluster: Section ${nearest}.`);
    } else {
      reasons.push(`Section ${best.section} is empty. No ${gender} cluster yet — starting one here.`);
    }
  } else if (tierNum === 3) {
    reasons.push(
      `No pure or empty section available. Section ${best.section} already has both genders — ` +
      `unavoidable mixing.`
    );
  } else {
    reasons.push(
      `Centre is extremely full. Section ${best.section} has only opposite-gender students. ` +
      `This is a last-resort allocation.`
    );
  }

  const seatNum = parseInt(best.seat_number, 10);
  const neighbours = allSeats.filter(
    s => s.section === best.section &&
         Math.abs(parseInt(s.seat_number, 10) - seatNum) === 1
  );
  const hasSameNeighbour = neighbours.some(s =>
    (seatOccupants[s.seat_id] || []).some(o => o.gender === gender)
  );
  if (hasSameNeighbour) {
    reasons.push(`Seat ${best.seat_number} is adjacent to a ${gender} student.`);
  }

  const confidence = tierNum <= 2 ? 'High' : tierNum === 3 ? 'Medium' : 'Low';

  return {
    proposed_seat: best.seat_number,
    confidence,
    tier: tierNum,
    reasons
  };
}

/**
 * Validate an admin-selected seat against gender segregation rules.
 * Returns { valid, tier, violations, reason }.
 *
 * Note: this never blocks a save — it informs the admin of violations so they
 * can log an override if they choose to proceed anyway. The hard block on
 * double-booking (time conflict) lives in isSeatAvailable(), not here.
 */
function validateSeatSelection(seatNumber, gender, startTime, endTime, targetDate = null, excludeStudentId = null) {
  const { allSeats, seatOccupants, sectionStats } = buildContext(
    startTime, endTime, targetDate, excludeStudentId
  );

  const seat = allSeats.find(s => s.seat_number.trim() === String(seatNumber).trim());
  if (!seat) {
    return { valid: false, tier: null, violations: ['Seat not found or disabled.'], reason: 'Seat not found or disabled.' };
  }

  // Hard block: seat already occupied during this time range
  const occupants = seatOccupants[seat.seat_id] || [];
  if (occupants.length > 0) {
    // Determine occupant gender for a meaningful message
    const genders = [...new Set(occupants.map(o => o.gender).filter(Boolean))];
    let occupiedBy = 'another student';
    if (genders.length === 1) {
      occupiedBy = genders[0] === 'Male'   ? 'a male student'
                 : genders[0] === 'Female' ? 'a female student'
                 : 'another student';
    } else if (genders.length > 1) {
      occupiedBy = 'students of multiple genders';
    }
    const msg = `Seat ${seat.seat_number} is currently occupied by ${occupiedBy} during this time slot. Please select a different seat or timing.`;
    return { valid: false, tier: null, occupied: true, occupiedBy, violations: [msg], reason: msg };
  }

  const violations = [];

  if (gender === 'Male' || gender === 'Female') {
    const sectionClass = classifySection(seat.section, gender, sectionStats);

    if (sectionClass === 'opposite') {
      violations.push(`Section ${seat.section} is occupied only by ${gender === 'Female' ? 'Male' : 'Female'} students — placing a ${gender} student here causes direct mixing.`);
    } else if (sectionClass === 'mixed') {
      violations.push(`Section ${seat.section} already has both genders seated — this seat adds to an existing mixed section.`);
    }

    // Adjacent seat opposite-gender check
    const seatNum = parseInt(seat.seat_number, 10);
    if (!isNaN(seatNum)) {
      const neighbours = allSeats.filter(
        s => s.section === seat.section &&
             Math.abs(parseInt(s.seat_number, 10) - seatNum) === 1
      );
      const hasOppositeNeighbour = neighbours.some(s =>
        (seatOccupants[s.seat_id] || []).some(
          o => o.gender === (gender === 'Female' ? 'Male' : 'Female')
        )
      );
      if (hasOppositeNeighbour) {
        violations.push(`Seat ${seatNumber} is directly adjacent to a ${gender === 'Female' ? 'Male' : 'Female'} student.`);
      }
    }
  }

  // Determine the tier this seat would fall into (for informational display)
  const sameSections     = Object.keys(sectionStats).filter(s => classifySection(s, gender, sectionStats) === 'same');
  const emptySections    = Object.keys(sectionStats).filter(s => classifySection(s, gender, sectionStats) === 'empty');
  const mixedSections    = Object.keys(sectionStats).filter(s => classifySection(s, gender, sectionStats) === 'mixed');

  let tier = 4;
  if (sameSections.includes(seat.section))  tier = 1;
  else if (emptySections.includes(seat.section)) tier = 2;
  else if (mixedSections.includes(seat.section)) tier = 3;

  return {
    valid: violations.length === 0,
    tier,
    violations,
    reason: violations.join(' | ')
  };
}

module.exports = { proposeSeat, validateSeatSelection, hasOppositeGenderAdjacent: null };