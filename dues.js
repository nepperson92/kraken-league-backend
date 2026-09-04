const db = require('./db');
const { getOrCreateSeasonByYear } = require('./keepers');

// Every current owner, with their paid status for a season (unpaid/no row = false)
async function listDues(year) {
  const seasonRes = await db.query('SELECT id FROM seasons WHERE year = $1', [year]);
  const seasonId = seasonRes.rows[0]?.id || null;
  const result = await db.query(`
    SELECT o.id AS owner_id, o.name, o.sleeper_user_id,
      COALESCE(d.paid, false) AS paid, d.paid_at
    FROM owners o
    LEFT JOIN dues d ON d.owner_id = o.id AND d.season_id = $1
    ORDER BY o.name ASC
  `, [seasonId]);
  return result.rows;
}

async function setPaid(year, ownerId, paid) {
  const season = await getOrCreateSeasonByYear(year);
  const result = await db.query(
    `INSERT INTO dues (season_id, owner_id, paid, paid_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (season_id, owner_id) DO UPDATE SET paid = EXCLUDED.paid, paid_at = EXCLUDED.paid_at
     RETURNING *`,
    [season.id, ownerId, paid, paid ? new Date() : null]
  );
  return result.rows[0];
}

module.exports = { listDues, setPaid };
