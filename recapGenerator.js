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

// A week's games are considered done once the NFL's own current week has moved past it.
// This avoids guessing at individual game states (byes, Monday/Thursday stragglers, etc.).
async function isWeekComplete(week) {
  try {
    const state = await fetchJSON(`${API}/state/nfl`);
    return (state.week || 1) > week;
  } catch (e) {
    return false;
  }
}

async function getActualPointsMap(year, week, scoringSettings) {
  const map = {};
  try {
    const url = `https://api.sleeper.app/stats/nfl/${year}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&position[]=FLEX`;
    const data = await fetchJSON(url);
    const entries = Array.isArray(data) ? data : Object.values(data || {});
    entries.forEach(item => {
      const pid = item.player_id || item.playerId;
      if (!pid) return;
      const stats = item.stats || {};
      let total = 0;
      for (const key in scoringSettings) {
        const v = stats[key], w = scoringSettings[key];
        if (typeof v === 'number' && typeof w === 'number') total += v * w;
      }
      map[pid] = total;
    });
  } catch (e) { /* leave empty — recap just won't call out a top performer */ }
  return map;
}

async function bestPerformer(starters, actualMap) {
  let best = null, bestPts = -Infinity;
  for (const pid of starters || []) {
    const pts = actualMap[pid];
    if (pts == null) continue;
    if (pts > bestPts) {
      bestPts = pts;
      const p = await players.getPlayer(pid);
      best = p ? { name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), position: p.position, points: pts } : null;
    }
  }
  return best;
}

async function callClaude(apiKey, ctxA, ctxB, week, year) {
  const system = `You are a witty, knowledgeable fantasy football analyst writing a short POST-GAME recap of a completed matchup in a private home league — the games are over, you're reporting what actually happened, not previewing what might. Keep it fun and a little irreverent, like a good league group chat, not a corporate sports column. Ground everything in the specific data given — do not invent stats, players, or details not present in the data. This is one of several recaps you're writing for different matchups this week — vary your opening line, structure, and angle so they don't all read the same way. Write 3-4 short paragraphs, plain text, no headers or markdown.`;

  const user = `Week ${week}, ${year} season — FINAL RESULT.

${ctxA.teamName} ${ctxA.finalScore.toFixed(2)} — ${ctxB.teamName} ${ctxB.finalScore.toFixed(2)}
Winner: ${ctxA.finalScore > ctxB.finalScore ? ctxA.teamName : ctxB.teamName} by ${Math.abs(ctxA.finalScore - ctxB.finalScore).toFixed(2)} points.

${ctxA.teamName}'s top performer: ${ctxA.topPerformer ? `${ctxA.topPerformer.name} (${ctxA.topPerformer.position}) with ${ctxA.topPerformer.points.toFixed(1)} points` : 'no standout performance on record'}
${ctxB.teamName}'s top performer: ${ctxB.topPerformer ? `${ctxB.topPerformer.name} (${ctxB.topPerformer.position}) with ${ctxB.topPerformer.points.toFixed(1)} points` : 'no standout performance on record'}

Season records entering this week: ${ctxA.teamName} ${ctxA.wins}-${ctxA.losses}, ${ctxB.teamName} ${ctxB.wins}-${ctxB.losses}
Head-to-head: ${ctxA.h2h}

Write the post-game recap now.`;

  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (process.env.ANTHROPIC_WORKSPACE_ID) headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find(b => b.type === 'text');
  return block ? block.text.trim() : '';
}

async function generateMatchupRecaps(leagueId, week) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ready: false, reason: 'No Anthropic API key configured on the server.' };

  const complete = await isWeekComplete(week);
  if (!complete) return { ready: false, reason: `Week ${week} isn't over yet — recaps unlock once the following week begins.` };

  const [league, rosters, users] = await Promise.all([
    fetchJSON(`${API}/league/${leagueId}`),
    fetchJSON(`${API}/league/${leagueId}/rosters`),
    fetchJSON(`${API}/league/${leagueId}/users`)
  ]);
  const year = parseInt(league.season, 10);

  const matchups = await fetchJSON(`${API}/league/${leagueId}/matchups/${week}`);
  if (!matchups || !matchups.length) return { ready: false, reason: 'No matchups found for this week.' };

  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });
  const rosterById = {};
  rosters.forEach(r => { rosterById[r.roster_id] = r; });

  const actualMap = await getActualPointsMap(year, week, league.scoring_settings || {});

  const byMatchup = {};
  matchups.forEach(m => {
    if (m.matchup_id == null) return;
    (byMatchup[m.matchup_id] = byMatchup[m.matchup_id] || []).push(m);
  });

  const results = [];
  for (const pair of Object.values(byMatchup)) {
    if (pair.length < 2) continue;
    const [ma, mb] = pair;
    if (!((ma.points || 0) > 0 && (mb.points || 0) > 0)) continue; // this specific matchup has no score yet — skip
    const rosterA = rosterById[ma.roster_id], rosterB = rosterById[mb.roster_id];
    if (!rosterA || !rosterB) continue;
    const userA = userById[rosterA.owner_id], userB = userById[rosterB.owner_id];
    if (!userA || !userB) continue;

    const ownerA = await getOrCreateOwner(userA.user_id, userA.display_name);
    const ownerB = await getOrCreateOwner(userB.user_id, userB.display_name);

    const cached = await db.query(
      `SELECT * FROM matchup_recaps WHERE sleeper_league_id=$1 AND year=$2 AND week=$3
       AND ((owner_a_id=$4 AND owner_b_id=$5) OR (owner_a_id=$5 AND owner_b_id=$4))`,
      [leagueId, year, week, ownerA.id, ownerB.id]
    );
    const teamNameA = (userA.metadata && userA.metadata.team_name) || userA.display_name || 'Team A';
    const teamNameB = (userB.metadata && userB.metadata.team_name) || userB.display_name || 'Team B';
    if (cached.rows.length) {
      results.push({ teamA: teamNameA, teamB: teamNameB, scoreA: ma.points, scoreB: mb.points, content: cached.rows[0].content });
      continue;
    }

    const [topA, topB, h2hResult] = await Promise.all([
      bestPerformer(ma.starters, actualMap),
      bestPerformer(mb.starters, actualMap),
      db.query(`SELECT COUNT(*) FILTER (WHERE result='W') AS w, COUNT(*) FILTER (WHERE result='L') AS l, COUNT(*) FILTER (WHERE result='T') AS t
                FROM matchup_results WHERE owner_id=$1 AND opponent_owner_id=$2`, [ownerA.id, ownerB.id])
    ]);
    const h2hRow = h2hResult.rows[0];
    const h2h = (Number(h2hRow.w) + Number(h2hRow.l) + Number(h2hRow.t)) > 0
      ? `${teamNameA} leads ${h2hRow.w}-${h2hRow.l}${h2hRow.t > 0 ? '-' + h2hRow.t : ''} all-time`
      : 'first meeting on record';

    const ctxA = { teamName: teamNameA, finalScore: ma.points, wins: rosterA.settings?.wins || 0, losses: rosterA.settings?.losses || 0, topPerformer: topA, h2h };
    const ctxB = { teamName: teamNameB, finalScore: mb.points, wins: rosterB.settings?.wins || 0, losses: rosterB.settings?.losses || 0, topPerformer: topB, h2h };

    const content = await callClaude(apiKey, ctxA, ctxB, week, year);

    const saved = await db.query(
      `INSERT INTO matchup_recaps (sleeper_league_id, year, week, owner_a_id, owner_b_id, content, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (sleeper_league_id, year, week, owner_a_id, owner_b_id) DO UPDATE SET
         content = EXCLUDED.content, model = EXCLUDED.model, generated_at = now()
       RETURNING *`,
      [leagueId, year, week, ownerA.id, ownerB.id, content, ANTHROPIC_MODEL]
    );
    results.push({ teamA: teamNameA, teamB: teamNameB, scoreA: ma.points, scoreB: mb.points, content: saved.rows[0].content });
  }

  if (!results.length) return { ready: false, reason: 'No completed matchups found for this week yet.' };
  return { ready: true, week, year, results };
}

async function clearRecaps(leagueId, year, week) {
  await db.query('DELETE FROM matchup_recaps WHERE sleeper_league_id=$1 AND year=$2 AND week=$3', [leagueId, year, week]);
}

module.exports = { generateMatchupRecaps, clearRecaps };
