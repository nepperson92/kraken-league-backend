const API = 'https://api.sleeper.app/v1';

let cache = null; // { byId: {...}, bySearchName: Map }
let fetchedAt = 0;
const ONE_DAY = 1000 * 60 * 60 * 24;

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.'’-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

async function loadPlayers() {
  if (cache && Date.now() - fetchedAt < ONE_DAY) return cache;
  const res = await fetch(`${API}/players/nfl`);
  if (!res.ok) throw new Error('Could not fetch Sleeper player directory');
  const all = await res.json();
  const bySearchName = new Map();
  Object.entries(all).forEach(([id, p]) => {
    if (!p || !p.position) return;
    const key = normalizeName(`${p.first_name || ''} ${p.last_name || ''}`);
    if (!key) return;
    // Prefer active/skill-position entries if a name collides
    if (!bySearchName.has(key)) bySearchName.set(key, []);
    bySearchName.get(key).push({ id, ...p });
  });
  cache = { byId: all, bySearchName };
  fetchedAt = Date.now();
  return cache;
}

// Find a Sleeper player_id for a name from an external rankings list.
// Uses position to disambiguate when multiple players share a normalized name.
async function findPlayerId(name, position) {
  const { bySearchName } = await loadPlayers();
  const key = normalizeName(name);
  const matches = bySearchName.get(key);
  if (!matches || !matches.length) return null;
  if (matches.length === 1) return matches[0].id;
  if (position) {
    const posMatch = matches.find(m => (m.position || '').toUpperCase() === position.toUpperCase());
    if (posMatch) return posMatch.id;
  }
  return matches[0].id; // best effort
}

async function getPlayer(id) {
  const { byId } = await loadPlayers();
  return byId[id] || null;
}

module.exports = { loadPlayers, findPlayerId, getPlayer, normalizeName };
