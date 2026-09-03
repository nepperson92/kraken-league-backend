const db = require('./db');

async function getSetting(key) {
  const result = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return result.rows.length ? result.rows[0].value : null;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

module.exports = { getSetting, setSetting };
