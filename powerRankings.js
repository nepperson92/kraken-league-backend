const db = require('./db');
const { getOrCreateOwner } = require('./sleeperSync');
const { getCareerProfile } = require('./writeupGenerator');

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
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2500, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find(b => b.type === 'text');
  return block ? block.text.trim() : null;
}

function computeCustomPoints(stats, scoringSettings) {
  let total = 0;
  for (const key in scoringSettings) {
    const v = stats[key], w = scoringSettings[key];
    if (typeof v === 'number' && typeof w === 'number') total += v * w;
  }
  return total;
}

// Roster strength: this week's starting lineup, run through projections + league scoring —
// the only meaningful signal in week 1, before any games have actually been played.
async function getRosterStrengthByRoster(year, week, scoringSettings, rosters) {
  const strength = {};
  try {
    const url = `https://api.sleeper.app/projections/nfl/${year}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&position[]=FLEX`;
    const data = await fetchJSON(url);
    const projMap = {};
    (Array.isArray(data) ? data : Object.values(data || {})).forEach(item => {
      const pid = item.player_id || item.playerId;
      if (!pid) return;
      projMap[pid] = computeCustomPoints(item.stats || {}, scoringSettings);
    });
    rosters.forEach(r => {
      strength[r.roster_id] = (r.starters || []).reduce((sum, pid) => sum + (projMap[pid] || 0), 0);
    });
  } catch (e) { /* roster strength is a bonus signal — leave empty on failure */ }
  return strength;
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

  // Roster strength (projected lineup this week) and manager career history — always gathered,
  // but weighted more heavily by the prompt in early weeks when in-season data is thin.
  const strengthByRoster = await getRosterStrengthByRoster(year, week, league.scoring_settings || {}, rosters);
  const careerByRoster = {};
  for (const r of rosters) {
    const user = userById[r.owner_id];
    if (!user) continue;
    try {
      const owner = await getOrCreateOwner(user.user_id, user.display_name);
      careerByRoster[r.roster_id] = await getCareerProfile(owner.id);
    } catch (e) { /* career history is a bonus signal — skip on failure */ }
  }

  const teams = rosters.map(r => {
    const user = userById[r.owner_id] || {};
    const teamName = (user.metadata && user.metadata.team_name) || user.display_name || 'Team';
    const s = r.settings || {};
    const recent = recentByRoster[r.roster_id] || [];
    const career = careerByRoster[r.roster_id];
    return {
      teamName,
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      recent,
      rosterStrength: strengthByRoster[r.roster_id] || 0,
      career
    };
  });

  if (!teams.length) return { ready: false, reason: 'Could not find any teams for this league.' };

  const dataBlock = teams.map(t => {
    const careerStr = t.career
      ? `career record ${t.career.total_wins}-${t.career.total_losses} across ${t.career.seasons_played} season(s), ${t.career.championships} championship(s), ${t.career.playoff_appearances} playoff appearance(s)`
      : 'no career history on file (new to the league)';
    return `${t.teamName}: record ${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}, points for ${t.pf.toFixed(1)}, points against ${t.pa.toFixed(1)}, last ${t.recent.length} game score(s): ${t.recent.length ? t.recent.map(p => p.toFixed(1)).join(', ') : 'none yet'}, this week's projected starting lineup: ${t.rosterStrength.toFixed(1)} pts, ${careerStr}`;
  }).join('\n');

  const weightingNote = week === 1
    ? `This is Week 1 — there is no in-season data yet, so base the rankings primarily on each team's projected roster strength this week and the manager's career track record (championships, career win rate). Treat the 0-0 records as uninformative.`
    : week === 2
      ? `This is Week 2 — lean heavily on how each team actually scored in Week 1, using projected roster strength and career history as secondary context, not the primary factor anymore.`
      : `Blend actual record, point differential, and recent scoring form as the primary signal at this point in the season. Projected roster strength and career history are useful tiebreakers or context, but in-season performance should now dominate the ranking.`;

  const system = `You are a sharp, opinionated fantasy football analyst writing this week's power rankings for a private home league. Power rankings are NOT the same as standings — rank teams by who is actually playing the best right now. ${weightingNote} Have a real point of view, don't just re-list the standings order. Ground everything in the data given, never invent stats or details not present. Respond with ONLY a valid JSON array, no other text, no markdown fences, in exactly this shape:
[{"rank":1,"teamName":"...","blurb":"1-2 witty, specific sentences explaining why they're ranked here"}]
Include every team exactly once, ranked 1 through N, most dominant first.`;

  const user = `Week ${week}, ${year} season. Team data:\n\n${dataBlock}\n\nWrite this week's power rankings now.`;

  const text = await callClaude(system, user);
  if (!text) return { ready: false, reason: 'Could not generate power rankings.' };

  let rankings;
  try {
    let cleaned = text.replace(/```json|```/g, '').trim();
    // Claude sometimes adds a stray sentence before/after the array despite instructions —
    // pull out just the [...] portion rather than failing on the whole response.
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
    rankings = JSON.parse(cleaned);
    if (!Array.isArray(rankings) || !rankings.length) throw new Error('Empty or non-array result');
  } catch (e) {
    return { ready: false, reason: `Could not parse the generated rankings (${e.message}).` };
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

async function getPreviousWeekRankByTeam(leagueId, year, week) {
  if (week <= 1) return {};
  const prev = await db.query(
    'SELECT rankings FROM power_rankings WHERE sleeper_league_id=$1 AND year=$2 AND week=$3',
    [leagueId, year, week - 1]
  );
  if (!prev.rows.length) return {};
  const byTeam = {};
  prev.rows[0].rankings.forEach(r => { byTeam[r.teamName] = r.rank; });
  return byTeam;
}

function attachChange(rankings, previousRankByTeam) {
  return rankings.map(r => {
    const prevRank = previousRankByTeam[r.teamName];
    const change = prevRank != null ? prevRank - r.rank : null; // positive = moved up
    return { ...r, change };
  });
}

async function getPowerRankings(leagueId, week) {
  const league = await fetchJSON(`${API}/league/${leagueId}`);
  const year = parseInt(league.season, 10);

  const cached = await db.query(
    'SELECT * FROM power_rankings WHERE sleeper_league_id=$1 AND year=$2 AND week=$3',
    [leagueId, year, week]
  );
  const previousRankByTeam = await getPreviousWeekRankByTeam(leagueId, year, week);

  if (cached.rows.length) {
    return { ready: true, year, week, rankings: attachChange(cached.rows[0].rankings, previousRankByTeam), cached: true };
  }
  const result = await generatePowerRankings(league, leagueId, week, year);
  if (!result.ready) return result;
  return { ...result, rankings: attachChange(result.rankings, previousRankByTeam) };
}

async function clearPowerRankings(leagueId, year, week) {
  await db.query('DELETE FROM power_rankings WHERE sleeper_league_id=$1 AND year=$2 AND week=$3', [leagueId, year, week]);
}

module.exports = { getPowerRankings, clearPowerRankings };
