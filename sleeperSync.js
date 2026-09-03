const db = require('./db');

const API = 'https://api.sleeper.app/v1';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper request failed: ${url} (${res.status})`);
  return res.json();
}

// Walk previous_league_id backwards from a starting league to discover every
// season this league has run on Sleeper. Returns most-recent-first.
async function discoverSleeperChain(startLeagueId) {
  const chain = [];
  let id = startLeagueId;
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const league = await fetchJSON(`${API}/league/${id}`);
    chain.push(league);
    id = league.previous_league_id || null;
  }
  return chain;
}

async function getOrCreateOwner(sleeperUserId, displayName) {
  const existing = await db.query('SELECT * FROM owners WHERE sleeper_user_id = $1', [sleeperUserId]);
  if (existing.rows.length) return existing.rows[0];
  const created = await db.query(
    'INSERT INTO owners (name, sleeper_user_id) VALUES ($1, $2) RETURNING *',
    [displayName || 'Unknown owner', sleeperUserId]
  );
  return created.rows[0];
}

async function getOrCreateSeason(year, sleeperLeagueId, numTeams) {
  const existing = await db.query('SELECT * FROM seasons WHERE year = $1', [year]);
  if (existing.rows.length) {
    await db.query(
      'UPDATE seasons SET sleeper_league_id = $1, num_teams = $2, platform = $3 WHERE id = $4',
      [sleeperLeagueId, numTeams, 'sleeper', existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  const created = await db.query(
    `INSERT INTO seasons (year, platform, sleeper_league_id, num_teams) VALUES ($1,'sleeper',$2,$3) RETURNING id`,
    [year, sleeperLeagueId, numTeams]
  );
  return created.rows[0].id;
}

// Sync a single Sleeper season (by league_id) into the database.
async function syncSeason(leagueId) {
  const [league, rosters, users] = await Promise.all([
    fetchJSON(`${API}/league/${leagueId}`),
    fetchJSON(`${API}/league/${leagueId}/rosters`),
    fetchJSON(`${API}/league/${leagueId}/users`)
  ]);

  const year = parseInt(league.season, 10);
  const numTeams = rosters.length;
  const seasonId = await getOrCreateSeason(year, leagueId, numTeams);

  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });

  // Regular season ranking: wins desc, then points for desc (same logic as the live site)
  const ranked = [...rosters].sort((a, b) => {
    const aw = a.settings?.wins || 0, bw = b.settings?.wins || 0;
    if (bw !== aw) return bw - aw;
    const afp = (a.settings?.fpts || 0) + (a.settings?.fpts_decimal || 0) / 100;
    const bfp = (b.settings?.fpts || 0) + (b.settings?.fpts_decimal || 0) / 100;
    return bfp - afp;
  });
  const rankByRosterId = {};
  ranked.forEach((r, i) => { rankByRosterId[r.roster_id] = i + 1; });

  const playoffTeams = league.settings?.playoff_teams || 0;

  // Try to pull playoff results from the bracket endpoints (only present once playoffs happen)
  let winnersBracket = [];
  let losersBracket = [];
  try { winnersBracket = await fetchJSON(`${API}/league/${leagueId}/winners_bracket`); } catch (e) { /* not available */ }
  try { losersBracket = await fetchJSON(`${API}/league/${leagueId}/losers_bracket`); } catch (e) { /* not available */ }

  const playoffWins = {}, playoffLosses = {};
  let championRosterId = null, runnerUpRosterId = null, lastPlaceRosterId = null;

  (winnersBracket || []).forEach(m => {
    if (m.w) playoffWins[m.w] = (playoffWins[m.w] || 0) + 1;
    if (m.l) playoffLosses[m.l] = (playoffLosses[m.l] || 0) + 1;
    if (m.p === 1) { // championship game
      championRosterId = m.w;
      runnerUpRosterId = m.l;
    }
  });
  (losersBracket || []).forEach(m => {
    if (m.p === 1) { // last-place game
      lastPlaceRosterId = m.l;
    }
  });
  // Fallback: if no losers bracket last-place game, use worst regular season rank
  if (!lastPlaceRosterId && ranked.length) {
    lastPlaceRosterId = ranked[ranked.length - 1].roster_id;
  }

  for (const roster of rosters) {
    const user = userById[roster.owner_id];
    if (!user) continue; // orphaned roster, skip
    const owner = await getOrCreateOwner(user.user_id, user.display_name);
    const teamName = (user.metadata && user.metadata.team_name) || user.display_name || 'Team';
    const s = roster.settings || {};
    const rank = rankByRosterId[roster.roster_id];

    await db.query(
      `INSERT INTO season_results
        (season_id, owner_id, team_name, wins, losses, ties, points_for, points_against,
         regular_season_rank, made_playoffs, playoff_wins, playoff_losses,
         made_championship, won_championship, last_place)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (season_id, owner_id) DO UPDATE SET
         team_name = EXCLUDED.team_name, wins = EXCLUDED.wins, losses = EXCLUDED.losses,
         ties = EXCLUDED.ties, points_for = EXCLUDED.points_for, points_against = EXCLUDED.points_against,
         regular_season_rank = EXCLUDED.regular_season_rank, made_playoffs = EXCLUDED.made_playoffs,
         playoff_wins = EXCLUDED.playoff_wins, playoff_losses = EXCLUDED.playoff_losses,
         made_championship = EXCLUDED.made_championship, won_championship = EXCLUDED.won_championship,
         last_place = EXCLUDED.last_place`,
      [
        seasonId, owner.id, teamName,
        s.wins || 0, s.losses || 0, s.ties || 0,
        (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
        (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
        rank,
        rank ? rank <= playoffTeams : false,
        playoffWins[roster.roster_id] || 0,
        playoffLosses[roster.roster_id] || 0,
        roster.roster_id === championRosterId || roster.roster_id === runnerUpRosterId,
        roster.roster_id === championRosterId,
        roster.roster_id === lastPlaceRosterId
      ]
    );
  }

  return { year, seasonId, teams: rosters.length };
}

// Discover every Sleeper season in this league's history and sync all of them.
async function syncAllSleeperHistory(startLeagueId) {
  const chain = await discoverSleeperChain(startLeagueId);
  const results = [];
  for (const league of chain) {
    const result = await syncSeason(league.league_id);
    results.push(result);
  }
  return results;
}

module.exports = { syncSeason, syncAllSleeperHistory, discoverSleeperChain };
