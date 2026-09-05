const db = require('./db');

const API = 'https://api.sleeper.app/v1';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper request failed: ${url} (${res.status})`);
  return res.json();
}

async function callClaude(system, user) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (process.env.ANTHROPIC_WORKSPACE_ID) headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find(b => b.type === 'text');
  return block ? block.text.trim() : null;
}

async function generatePowerRankings(league, leagueId, week, year) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ready: false, reason: 'No Anthropic API key configured on the server.' };

  const [rosters, users] = await Promise.all([
    fetchJSON(`${API}/league/${leagueId}/rosters`),
    fetchJSON(`${API}/league/${leagueId}/users`)
  ]);
  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });

  // Recent form: last up to 3 completed weeks before this one
  const recentByRoster = {};
  for (let w = Math.max(1, week - 3); w < week; w++) {
    let matchups;
    try { matchups = await fetchJSON(`${API}/league/${leagueId}/matchups/${w}`); } catch (e) { continue; }
    (matchups || []).forEach(m => {
      if (!m.points) return;
      (recentByRoster[m.roster_id] = recentByRoster[m.roster_id] || []).push(m.points);
    });
  }

  const teams = rosters.map(r => {
    const user = userById[r.owner_id] || {};
    const teamName = (user.metadata && user.metadata.team_name) || user.display_name || 'Team';
    const s = r.settings || {};
    const recent = recentByRoster[r.roster_id] || [];
    return {
      teamName,
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      recent
    };
  });

  if (!teams.length) return { ready: false, reason: 'Could not find any teams for this league.' };

  const dataBlock = teams.map(t =>
    `${t.teamName}: record ${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}, points for ${t.pf.toFixed(1)}, points against ${t.pa.toFixed(1)}, last ${t.recent.length} game score(s): ${t.recent.length ? t.recent.map(p => p.toFixed(1)).join(', ') : 'none yet'}`
  ).join('\n');

  const system = `You are a sharp, opinionated fantasy football analyst writing this week's power rankings for a private home league. Power rankings are NOT the same as standings — rank teams by who is actually playing the best right now, blending record, point differential, and recent scoring form. A team with a good record but fading form should rank below a team on a hot streak with a worse record, and vice versa when the data supports it. Have a real point of view, don't just re-list the standings order. Ground everything in the data given, never invent stats or details not present. Respond with ONLY a valid JSON array, no other text, no markdown fences, in exactly this shape:
[{"rank":1,"teamName":"...","blurb":"1-2 witty, specific sentences explaining why they're ranked here"}]
Include every team exactly once, ranked 1 through N, most dominant first.`;

  const user = `Week ${week}, ${year} season. Team data:\n\n${dataBlock}\n\nWrite this week's power rankings now.`;

  const text = await callClaude(system, user);
  if (!text) return { ready: false, reason: 'Could not generate power rankings.' };

  let rankings;
  try {
    rankings = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { ready: false, reason: 'Could not parse the generated rankings.' };
  }

  await db.query(
    `INSERT INTO power_rankings (sleeper_league_id, year, week, rankings, model)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (sleeper_league_id, year, week) DO UPDATE SET
       rankings = EXCLUDED.rankings, model = EXCLUDED.model, generated_at = now()`,
    [leagueId, year, week, JSON.stringify(rankings), ANTHROPIC_MODEL]
  );

  return { ready: true, year, week, rankings, cached: false };
}

async function getPowerRankings(leagueId, week) {
  const league = await fetchJSON(`${API}/league/${leagueId}`);
  const year = parseInt(league.season, 10);

  const cached = await db.query(
    'SELECT * FROM power_rankings WHERE sleeper_league_id=$1 AND year=$2 AND week=$3',
    [leagueId, year, week]
  );
  if (cached.rows.length) {
    return { ready: true, year, week, rankings: cached.rows[0].rankings, cached: true };
  }
  return generatePowerRankings(league, leagueId, week, year);
}

async function clearPowerRankings(leagueId, year, week) {
  await db.query('DELETE FROM power_rankings WHERE sleeper_league_id=$1 AND year=$2 AND week=$3', [leagueId, year, week]);
}

module.exports = { getPowerRankings, clearPowerRankings };
