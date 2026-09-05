const db = require('./db');
const players = require('./playersCache');

async function getOrCreateSeasonByYear(year) {
  const existing = await db.query('SELECT * FROM seasons WHERE year = $1', [year]);
  if (existing.rows.length) return existing.rows[0];
  const created = await db.query(
    `INSERT INTO seasons (year, platform) VALUES ($1,'sleeper') RETURNING *`,
    [year]
  );
  return created.rows[0];
}

// The core rule: cost drops by one round for every year kept, capped at a 1st-round pick.
function costForYear(draftYear, draftRound, targetYear) {
  const yearsKept = targetYear - draftYear;
  return Math.max(1, Math.round(draftRound) - yearsKept);
}

// Builds the full "2027 - 3rd, 2028 - 2nd, 2029 and beyond - 1st" style schedule for display.
function buildSchedule(draftYear, draftRound) {
  const schedule = [];
  let year = draftYear + 1;
  let cost = costForYear(draftYear, draftRound, year);
  while (cost > 1) {
    schedule.push({ year, round: cost, label: String(year) });
    year++;
    cost = costForYear(draftYear, draftRound, year);
  }
  schedule.push({ year, round: 1, label: `${year} and beyond` });
  return schedule;
}

async function addOrUpdateKeeper({ ownerId, playerName, position, team, draftYear, draftRound, notes, active }) {
  const season = await getOrCreateSeasonByYear(draftYear);
  let sleeperPlayerId = null;
  try { sleeperPlayerId = await players.findPlayerId(playerName, position); } catch (e) { /* non-fatal */ }

  const result = await db.query(
    `INSERT INTO keepers (season_id, owner_id, sleeper_player_id, player_name, position, team, draft_year, draft_round, active, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (season_id, owner_id, player_name) DO UPDATE SET
       sleeper_player_id = EXCLUDED.sleeper_player_id, position = EXCLUDED.position,
       team = EXCLUDED.team, draft_year = EXCLUDED.draft_year, draft_round = EXCLUDED.draft_round,
       active = EXCLUDED.active, notes = EXCLUDED.notes
     RETURNING *`,
    [season.id, ownerId, sleeperPlayerId, playerName, position || null, team || null, draftYear, draftRound, active !== false, notes || null]
  );
  return result.rows[0];
}

async function updateKeeperById(id, { ownerId, playerName, position, team, draftYear, draftRound, notes, active }) {
  let sleeperPlayerId = null;
  try { sleeperPlayerId = await players.findPlayerId(playerName, position); } catch (e) { /* non-fatal */ }
  const result = await db.query(
    `UPDATE keepers SET
       owner_id = $1, sleeper_player_id = $2, player_name = $3, position = $4, team = $5,
       draft_year = $6, draft_round = $7, active = $8, notes = $9
     WHERE id = $10 RETURNING *`,
    [ownerId, sleeperPlayerId, playerName, position || null, team || null, draftYear, draftRound, active !== false, notes || null, id]
  );
  return result.rows[0] || null;
}

async function getKeeperById(id) {
  const result = await db.query('SELECT * FROM keepers WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// Every active keeper, with the computed cost/schedule for a given year — this is what
// actually powers the site's Keepers tab and the admin list.
async function listKeepers(year) {
  const result = await db.query(`
    SELECT k.*, o.name AS owner_name, o.sleeper_user_id
    FROM keepers k
    JOIN owners o ON o.id = k.owner_id
    WHERE k.active = true AND k.draft_year IS NOT NULL AND k.draft_round IS NOT NULL
    ORDER BY o.name ASC, k.player_name ASC
  `);
  return result.rows.map(k => {
    const draftYear = Number(k.draft_year), draftRound = Number(k.draft_round);
    return {
      ...k,
      current_cost: year != null ? costForYear(draftYear, draftRound, year) : null,
      schedule: buildSchedule(draftYear, draftRound)
    };
  });
}

// All keepers regardless of active flag — for the admin management list
async function listAllKeepers() {
  const result = await db.query(`
    SELECT k.*, o.name AS owner_name FROM keepers k
    JOIN owners o ON o.id = k.owner_id
    ORDER BY o.name ASC, k.player_name ASC
  `);
  return result.rows.map(k => {
    if (k.draft_year == null || k.draft_round == null) return { ...k, schedule: [] };
    return { ...k, schedule: buildSchedule(Number(k.draft_year), Number(k.draft_round)) };
  });
}

module.exports = { addOrUpdateKeeper, updateKeeperById, getKeeperById, listKeepers, listAllKeepers, getOrCreateSeasonByYear, costForYear, buildSchedule };
