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

async function addOrUpdateKeeper({ year, ownerId, playerName, position, team, cost, notes }) {
  const season = await getOrCreateSeasonByYear(year);
  let sleeperPlayerId = null;
  try { sleeperPlayerId = await players.findPlayerId(playerName, position); } catch (e) { /* non-fatal */ }

  const result = await db.query(
    `INSERT INTO keepers (season_id, owner_id, sleeper_player_id, player_name, position, team, cost, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (season_id, owner_id, player_name) DO UPDATE SET
       sleeper_player_id = EXCLUDED.sleeper_player_id, position = EXCLUDED.position,
       team = EXCLUDED.team, cost = EXCLUDED.cost, notes = EXCLUDED.notes
     RETURNING *`,
    [season.id, ownerId, sleeperPlayerId, playerName, position || null, team || null, cost || null, notes || null]
  );
  return result.rows[0];
}

// Update a specific keeper row directly by id — used for edits, including renaming the player,
// which the insert-based upsert above can't safely do (name is part of its conflict key).
async function updateKeeperById(id, { ownerId, playerName, position, team, cost, notes }) {
  let sleeperPlayerId = null;
  try { sleeperPlayerId = await players.findPlayerId(playerName, position); } catch (e) { /* non-fatal */ }
  const result = await db.query(
    `UPDATE keepers SET
       owner_id = $1, sleeper_player_id = $2, player_name = $3,
       position = $4, team = $5, cost = $6, notes = $7
     WHERE id = $8 RETURNING *`,
    [ownerId, sleeperPlayerId, playerName, position || null, team || null, cost || null, notes || null, id]
  );
  return result.rows[0] || null;
}

async function getKeeperById(id) {
  const result = await db.query('SELECT * FROM keepers WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function listKeepers(year) {
  const result = await db.query(`
    SELECT k.*, o.name AS owner_name, o.sleeper_user_id FROM keepers k
    JOIN owners o ON o.id = k.owner_id
    JOIN seasons s ON s.id = k.season_id
    WHERE s.year = $1
    ORDER BY o.name ASC, k.player_name ASC
  `, [year]);
  return result.rows;
}

module.exports = { addOrUpdateKeeper, updateKeeperById, getKeeperById, listKeepers, getOrCreateSeasonByYear };
