const db = require('./db');
const players = require('./playersCache');
const { getOrCreateOwner } = require('./sleeperSync');

const API = 'https://api.sleeper.app/v1';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper request failed: ${url} (${res.status})`);
  return res.json();
}

async function getOrCreateSeasonByYear(year, leagueId) {
  const existing = await db.query('SELECT * FROM seasons WHERE year = $1', [year]);
  if (existing.rows.length) {
    if (leagueId && !existing.rows[0].sleeper_league_id) {
      await db.query('UPDATE seasons SET sleeper_league_id = $1 WHERE id = $2', [leagueId, existing.rows[0].id]);
    }
    return existing.rows[0];
  }
  const created = await db.query(
    `INSERT INTO seasons (year, platform, sleeper_league_id) VALUES ($1,'sleeper',$2) RETURNING *`,
    [year, leagueId || null]
  );
  return created.rows[0];
}

async function getCareerProfile(ownerId) {
  const result = await db.query(`
    SELECT
      COUNT(sr.id) AS seasons_played,
      COALESCE(SUM(sr.wins),0) AS total_wins,
      COALESCE(SUM(sr.losses),0) AS total_losses,
      COALESCE(SUM(sr.points_for),0) AS total_points_for,
      COALESCE(SUM(sr.points_against),0) AS total_points_against,
      COUNT(*) FILTER (WHERE sr.made_playoffs) AS playoff_appearances,
      COUNT(*) FILTER (WHERE sr.won_championship) AS championships,
      COUNT(*) FILTER (WHERE sr.last_place) AS times_last_place
    FROM season_results sr WHERE sr.owner_id = $1
  `, [ownerId]);
  return result.rows[0];
}

async function getHeadToHead(ownerAId, ownerBId) {
  const result = await db.query(`
    SELECT mr.*, s.year FROM matchup_results mr
    JOIN seasons s ON s.id = mr.season_id
    WHERE mr.owner_id = $1 AND mr.opponent_owner_id = $2
    ORDER BY s.year DESC, mr.week DESC
  `, [ownerAId, ownerBId]);
  const rows = result.rows;
  const wins = rows.filter(r => r.result === 'W').length;
  const losses = rows.filter(r => r.result === 'L').length;
  const ties = rows.filter(r => r.result === 'T').length;
  const recent = rows.slice(0, 3).map(r => `${r.year} wk${r.week}: ${r.result} ${Number(r.points).toFixed(1)}-${Number(r.opponent_points).toFixed(1)}`);
  return { wins, losses, ties, meetings: rows.length, recent };
}

async function getRecentForm(ownerId, currentSeasonId, beforeWeek) {
  const result = await db.query(`
    SELECT week, points, result FROM matchup_results
    WHERE owner_id = $1 AND season_id = $2 AND week < $3
    ORDER BY week DESC LIMIT 3
  `, [ownerId, currentSeasonId, beforeWeek]);
  return result.rows;
}

async function buildTeamLineup(roster, user) {
  const starters = roster.starters || [];
  const lineup = [];
  for (const pid of starters) {
    if (!pid || pid === '0') continue;
    const p = await players.getPlayer(pid);
    if (!p) { lineup.push({ name: pid, position: '?', injury: null }); continue; }
    lineup.push({
      name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      position: p.position || '',
      team: p.team || 'FA',
      injury: p.injury_status || null
    });
  }
  return lineup;
}

function formatLineup(lineup) {
  return lineup.map(p => `${p.position} ${p.name} (${p.team}${p.injury ? `, ${p.injury}` : ''})`).join('; ');
}

async function callClaude(apiKey, teamAContext, teamBContext, week, year) {
  const system = `You are a witty, knowledgeable fantasy football analyst writing a short weekly matchup preview for a private home league. You know real NFL players and can speak to positional strengths/weaknesses. Keep it fun and a little irreverent, like a good league group chat, not a corporate sports column. Ground everything in the specific data given — do not invent stats, records, or player details not present in the data. If data is sparse (e.g. no history between these two), just say so briefly rather than padding. Write 3-5 short paragraphs, plain text, no headers or markdown.`;

  const user = `Week ${week}, ${year} season.

TEAM A: ${teamAContext.teamName} (managed by ${teamAContext.ownerName})
This season: ${teamAContext.wins}-${teamAContext.losses}
Career: ${teamAContext.careerWins}-${teamAContext.careerLosses} across ${teamAContext.seasonsPlayed} season(s), ${teamAContext.playoffAppearances} playoff appearance(s), ${teamAContext.championships} championship(s), finished last ${teamAContext.timesLastPlace} time(s)
Recent form (last games this season): ${teamAContext.recentForm || 'no prior games yet'}
This week's starting lineup: ${teamAContext.lineup}

TEAM B: ${teamBContext.teamName} (managed by ${teamBContext.ownerName})
This season: ${teamBContext.wins}-${teamBContext.losses}
Career: ${teamBContext.careerWins}-${teamBContext.careerLosses} across ${teamBContext.seasonsPlayed} season(s), ${teamBContext.playoffAppearances} playoff appearance(s), ${teamBContext.championships} championship(s), finished last ${teamBContext.timesLastPlace} time(s)
Recent form (last games this season): ${teamBContext.recentForm || 'no prior games yet'}
This week's starting lineup: ${teamBContext.lineup}

HEAD-TO-HEAD HISTORY: ${teamAContext.h2h}

Write the matchup preview now.`;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

async function generateMatchupWriteups(leagueId, week) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ready: false, reason: 'No Anthropic API key configured on the server.' };

  const [league, rosters, users] = await Promise.all([
    fetchJSON(`${API}/league/${leagueId}`),
    fetchJSON(`${API}/league/${leagueId}/rosters`),
    fetchJSON(`${API}/league/${leagueId}/users`)
  ]);
  const year = parseInt(league.season, 10);
  const season = await getOrCreateSeasonByYear(year, leagueId);

  const matchups = await fetchJSON(`${API}/league/${leagueId}/matchups/${week}`);
  if (!matchups || !matchups.length) return { ready: false, reason: 'No matchups posted for this week yet.' };

  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });
  const rosterById = {};
  rosters.forEach(r => { rosterById[r.roster_id] = r; });

  const byMatchup = {};
  matchups.forEach(m => {
    if (m.matchup_id == null) return;
    (byMatchup[m.matchup_id] = byMatchup[m.matchup_id] || []).push(m);
  });

  const results = [];
  for (const pair of Object.values(byMatchup)) {
    if (pair.length < 2) continue; // bye/odd team out, skip
    const [ma, mb] = pair;
    const rosterA = rosterById[ma.roster_id], rosterB = rosterById[mb.roster_id];
    if (!rosterA || !rosterB) continue;
    const userA = userById[rosterA.owner_id], userB = userById[rosterB.owner_id];
    if (!userA || !userB) continue;

    const ownerA = await getOrCreateOwner(userA.user_id, userA.display_name);
    const ownerB = await getOrCreateOwner(userB.user_id, userB.display_name);

    // Check cache first
    const cached = await db.query(
      `SELECT * FROM matchup_writeups WHERE sleeper_league_id=$1 AND year=$2 AND week=$3
       AND ((owner_a_id=$4 AND owner_b_id=$5) OR (owner_a_id=$5 AND owner_b_id=$4))`,
      [leagueId, year, week, ownerA.id, ownerB.id]
    );
    if (cached.rows.length) {
      results.push(toWriteupResult(cached.rows[0], rosterA, rosterB, userA, userB));
      continue;
    }

    const [careerA, careerB, h2h, formA, formB, lineupA, lineupB] = await Promise.all([
      getCareerProfile(ownerA.id), getCareerProfile(ownerB.id),
      getHeadToHead(ownerA.id, ownerB.id),
      getRecentForm(ownerA.id, season.id, week), getRecentForm(ownerB.id, season.id, week),
      buildTeamLineup(rosterA, userA), buildTeamLineup(rosterB, userB)
    ]);

    const teamNameA = (userA.metadata && userA.metadata.team_name) || userA.display_name || 'Team A';
    const teamNameB = (userB.metadata && userB.metadata.team_name) || userB.display_name || 'Team B';

    const h2hSummary = h2h.meetings
      ? `${h2h.wins}-${h2h.losses}${h2h.ties ? `-${h2h.ties}` : ''} (${teamNameA}'s record vs ${teamNameB}) over ${h2h.meetings} meeting(s). Recent: ${h2h.recent.join('; ') || 'none'}`
      : 'These two have no recorded meetings on file.';

    const ctxA = {
      teamName: teamNameA, ownerName: userA.display_name,
      wins: rosterA.settings?.wins || 0, losses: rosterA.settings?.losses || 0,
      careerWins: careerA.total_wins, careerLosses: careerA.total_losses, seasonsPlayed: careerA.seasons_played,
      playoffAppearances: careerA.playoff_appearances, championships: careerA.championships, timesLastPlace: careerA.times_last_place,
      recentForm: formA.map(f => `wk${f.week}: ${f.result} ${Number(f.points).toFixed(1)}`).join(', '),
      lineup: formatLineup(lineupA), h2h: h2hSummary
    };
    const ctxB = {
      teamName: teamNameB, ownerName: userB.display_name,
      wins: rosterB.settings?.wins || 0, losses: rosterB.settings?.losses || 0,
      careerWins: careerB.total_wins, careerLosses: careerB.total_losses, seasonsPlayed: careerB.seasons_played,
      playoffAppearances: careerB.playoff_appearances, championships: careerB.championships, timesLastPlace: careerB.times_last_place,
      recentForm: formB.map(f => `wk${f.week}: ${f.result} ${Number(f.points).toFixed(1)}`).join(', '),
      lineup: formatLineup(lineupB)
    };

    const content = await callClaude(apiKey, ctxA, ctxB, week, year);

    const saved = await db.query(
      `INSERT INTO matchup_writeups (sleeper_league_id, year, week, owner_a_id, owner_b_id, content, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (sleeper_league_id, year, week, owner_a_id, owner_b_id) DO UPDATE SET
         content = EXCLUDED.content, model = EXCLUDED.model, generated_at = now()
       RETURNING *`,
      [leagueId, year, week, ownerA.id, ownerB.id, content, ANTHROPIC_MODEL]
    );
    results.push(toWriteupResult(saved.rows[0], rosterA, rosterB, userA, userB));
  }

  return { ready: true, week, year, results };
}

function toWriteupResult(row, rosterA, rosterB, userA, userB) {
  return {
    teamA: (userA.metadata && userA.metadata.team_name) || userA.display_name,
    teamB: (userB.metadata && userB.metadata.team_name) || userB.display_name,
    scoreA: rosterA ? undefined : undefined,
    content: row.content,
    generatedAt: row.generated_at
  };
}

async function clearWriteups(leagueId, year, week) {
  await db.query('DELETE FROM matchup_writeups WHERE sleeper_league_id=$1 AND year=$2 AND week=$3', [leagueId, year, week]);
}

module.exports = { generateMatchupWriteups, clearWriteups, getHeadToHead, getCareerProfile };
