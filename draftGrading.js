const db = require('./db');
const players = require('./playersCache');

const API = 'https://api.sleeper.app/v1';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper request failed: ${url} (${res.status})`);
  return res.json();
}

// ---------- Parse a pasted rankings list ----------
// Accepts lines like: "1,Ja'Marr Chase,WR,CIN" or "1\tJa'Marr Chase\tWR" or just "1,Ja'Marr Chase"
function parseRankingsCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const parts = line.split(/\t|,/).map(p => p.trim()).filter(p => p !== '');
    if (parts.length < 2) continue;
    const rank = parseFloat(parts[0]);
    if (Number.isNaN(rank)) continue; // skip header rows etc.
    rows.push({
      rank,
      name: parts[1],
      position: parts[2] || null,
      team: parts[3] || null
    });
  }
  return rows;
}

async function getOrCreateSeasonByYear(year) {
  const existing = await db.query('SELECT * FROM seasons WHERE year = $1', [year]);
  if (existing.rows.length) return existing.rows[0];
  const created = await db.query(
    `INSERT INTO seasons (year, platform) VALUES ($1,'sleeper') RETURNING *`,
    [year]
  );
  return created.rows[0];
}

async function importRankings(year, rows, sourceLabel) {
  const season = await getOrCreateSeasonByYear(year);
  let matched = 0, unmatched = [];
  for (const row of rows) {
    const playerId = await players.findPlayerId(row.name, row.position);
    if (!playerId) { unmatched.push(row.name); continue; }
    matched++;
    await db.query(
      `INSERT INTO draft_rankings (season_id, sleeper_player_id, player_name, position, team, overall_rank, source_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (season_id, sleeper_player_id) DO UPDATE SET
         overall_rank = EXCLUDED.overall_rank, player_name = EXCLUDED.player_name,
         position = EXCLUDED.position, team = EXCLUDED.team, source_label = EXCLUDED.source_label`,
      [season.id, playerId, row.name, row.position, row.team, row.rank, sourceLabel || 'Imported list']
    );
  }
  return { seasonId: season.id, total: rows.length, matched, unmatched };
}

function scoreToLetter(score) {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 67) return 'D+';
  if (score >= 63) return 'D';
  if (score >= 60) return 'D-';
  return 'F';
}

// Generic position bucket so DEF/K don't skew roster-need checks the same as skill positions,
// and FLEX-eligible positions can satisfy FLEX requirements.
function posBucket(pos) {
  if (['RB', 'WR', 'TE'].includes(pos)) return pos;
  if (pos === 'QB') return 'QB';
  return 'OTHER';
}

const ANTHROPIC_MODEL = 'claude-sonnet-5';

// Writes a genuinely unique 2-4 sentence draft grade breakdown per team via Claude, instead of
// filling in fixed sentence templates — the old approach read identically for every manager.
async function generateDraftAnalysis(ctx) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const system = `You are a sharp, slightly irreverent fantasy football analyst writing a short draft grade breakdown for one team in a home league. This is one of several you're writing in a row for different teams in the same draft — make sure each one reads distinctly from the others: vary your opening line, sentence structure, and tone. Do not default to a generic "Team X had a [good/bad] draft" opener every time. Ground everything in the specific data given — never invent stats, players, or details not present in the data. Write 2-4 sentences, plain text, no headers or markdown.`;

  const user = `Team: ${ctx.teamName}
Draft grade: ${ctx.letter} (${ctx.score}/100)
${ctx.bestValue ? `Best value pick: ${ctx.bestValue.name} (${ctx.bestValue.position || ''}), round ${ctx.bestValue.round}, drafted about ${Math.round(ctx.bestValue.value)} picks later than their expected rank (a steal).` : 'No standout value pick this draft.'}
${ctx.biggestReach && ctx.biggestReach.value < -5 ? `Biggest reach: ${ctx.biggestReach.name} (${ctx.biggestReach.position || ''}), round ${ctx.biggestReach.round}, taken about ${Math.abs(Math.round(ctx.biggestReach.value))} picks earlier than expected.` : 'No major reaches this draft.'}
Roster construction: ${ctx.thinPositions.length ? `left ${ctx.thinPositions.join(' and ')} thin — didn't fully address ${ctx.thinPositions.length > 1 ? 'those positions' : 'that position'}.` : 'every starting position was addressed.'}

Write the draft grade breakdown now.`;

  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    if (process.env.ANTHROPIC_WORKSPACE_ID) headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return textBlock ? textBlock.text.trim() : null;
  } catch (e) {
    return null;
  }
}

async function computeDraftGrades(year) {
  const seasonRes = await db.query('SELECT * FROM seasons WHERE year = $1', [year]);
  if (!seasonRes.rows.length) throw new Error(`No season saved for ${year}.`);
  const season = seasonRes.rows[0];
  if (!season.sleeper_league_id) throw new Error(`Season ${year} has no linked Sleeper league — sync it first.`);

  const rankingsRes = await db.query('SELECT * FROM draft_rankings WHERE season_id = $1', [season.id]);
  if (!rankingsRes.rows.length) {
    return { ready: false, reason: 'No rankings have been imported for this season yet.' };
  }
  const rankByPlayerId = {};
  rankingsRes.rows.forEach(r => { rankByPlayerId[r.sleeper_player_id] = r.overall_rank; });

  const [league, rosters, users, drafts] = await Promise.all([
    fetchJSON(`${API}/league/${season.sleeper_league_id}`),
    fetchJSON(`${API}/league/${season.sleeper_league_id}/rosters`),
    fetchJSON(`${API}/league/${season.sleeper_league_id}/users`),
    fetchJSON(`${API}/league/${season.sleeper_league_id}/drafts`)
  ]);
  if (!drafts || !drafts.length) return { ready: false, reason: 'No draft found for this league yet.' };
  const draft = drafts[0];
  if (draft.status !== 'complete') {
    return { ready: false, reason: 'The draft has not finished yet.' };
  }
  const picks = await fetchJSON(`${API}/draft/${draft.draft_id}/picks`);
  if (!picks || !picks.length) return { ready: false, reason: 'The draft has no picks recorded.' };

  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });
  const rosterByOwnerUserId = {};
  rosters.forEach(r => { rosterByOwnerUserId[r.owner_id] = r; });

  // Roster requirements from league settings, bucketed
  const required = { QB: 0, RB: 0, WR: 0, TE: 0 };
  (league.roster_positions || []).forEach(p => {
    if (p === 'QB') required.QB++;
    else if (p === 'RB') required.RB++;
    else if (p === 'WR') required.WR++;
    else if (p === 'TE') required.TE++;
    else if (p === 'FLEX') { required.RB += 0.34; required.WR += 0.33; required.TE += 0.33; }
  });

  const byOwner = {}; // owner_id (sleeper user id) -> { picks: [...] }
  picks.forEach(pick => {
    if (!pick.picked_by) return;
    const ownerUserId = pick.picked_by;
    const expectedRank = rankByPlayerId[pick.player_id];
    // Positive = steal (picked later than their ADP), negative = reach (picked earlier than their ADP)
    const value = expectedRank != null ? pick.pick_no - expectedRank : 0;
    (byOwner[ownerUserId] = byOwner[ownerUserId] || []).push({
      round: pick.round,
      pick_no: pick.pick_no,
      player_id: pick.player_id,
      name: pick.metadata ? `${pick.metadata.first_name || ''} ${pick.metadata.last_name || ''}`.trim() : pick.player_id,
      position: pick.metadata?.position || null,
      expectedRank,
      value,
      ranked: expectedRank != null
    });
  });

  // First pass: compute raw value scores so we can normalize across the league
  const teamStats = [];
  for (const [ownerUserId, teamPicks] of Object.entries(byOwner)) {
    const user = userById[ownerUserId];
    if (!user) continue;

    let weightedValueSum = 0, weightTotal = 0;
    teamPicks.forEach(p => {
      const weight = 1 / p.round;
      weightedValueSum += p.value * weight;
      weightTotal += weight;
    });
    const avgWeightedValue = weightTotal ? weightedValueSum / weightTotal : 0;

    const posCounts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    teamPicks.forEach(p => {
      const bucket = posBucket(p.position);
      if (posCounts[bucket] != null) posCounts[bucket]++;
    });
    const thinPositions = Object.keys(required).filter(pos => posCounts[pos] < Math.max(1, Math.floor(required[pos])));
    const rosterScore = Math.max(0, 100 - thinPositions.length * 20);

    const sortedByValue = [...teamPicks].filter(p => p.ranked).sort((a, b) => b.value - a.value);
    const bestValue = sortedByValue[0] || null;
    const biggestReach = sortedByValue[sortedByValue.length - 1] || null;

    teamStats.push({
      ownerUserId,
      teamName: (user.metadata && user.metadata.team_name) || user.display_name || 'Team',
      avgWeightedValue,
      rosterScore,
      thinPositions,
      bestValue,
      biggestReach,
      picks: teamPicks
    });
  }

  if (!teamStats.length) return { ready: false, reason: 'Could not match any picks to league rosters.' };

  const values = teamStats.map(t => t.avgWeightedValue);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const spread = maxV - minV || 1;

  const results = [];
  for (const t of teamStats) {
    const normalizedValueScore = ((t.avgWeightedValue - minV) / spread) * 100;
    const finalScore = Math.round(normalizedValueScore * 0.7 + t.rosterScore * 0.3);
    const letter = scoreToLetter(finalScore);

    const aiAnalysis = await generateDraftAnalysis({
      teamName: t.teamName, score: finalScore, letter,
      bestValue: t.bestValue, biggestReach: t.biggestReach, thinPositions: t.thinPositions
    });
    const fallback = `${t.teamName} drafted to a ${letter} grade (${finalScore}/100).` +
      (t.bestValue ? ` Best value: ${t.bestValue.name} in round ${t.bestValue.round}.` : '') +
      (t.thinPositions.length ? ` Left ${t.thinPositions.join(' and ')} thin.` : ' Addressed every starting position.');
    const analysis = aiAnalysis || fallback;
    const summary = analysis.split(/(?<=[.!?])\s+/)[0];

    results.push({
      ownerUserId: t.ownerUserId,
      teamName: t.teamName,
      score: finalScore,
      letter,
      summary,
      analysis,
      bestValue: t.bestValue,
      biggestReach: t.biggestReach,
      picks: t.picks
    });
  }
  results.sort((a, b) => b.score - a.score);
  return { ready: true, seasonId: season.id, year, results };
}

async function computeAndStore(year) {
  const graded = await computeDraftGrades(year);
  if (!graded.ready) return graded;

  for (const r of graded.results) {
    const ownerRow = await db.query('SELECT id FROM owners WHERE sleeper_user_id = $1', [r.ownerUserId]);
    if (!ownerRow.rows.length) continue;
    const ownerId = ownerRow.rows[0].id;
    await db.query(
      `INSERT INTO draft_grades (season_id, owner_id, team_name, score, letter, summary, analysis, picks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (season_id, owner_id) DO UPDATE SET
         team_name = EXCLUDED.team_name, score = EXCLUDED.score, letter = EXCLUDED.letter,
         summary = EXCLUDED.summary, analysis = EXCLUDED.analysis, picks = EXCLUDED.picks,
         computed_at = now()`,
      [graded.seasonId, ownerId, r.teamName, r.score, r.letter, r.summary, r.analysis, JSON.stringify(r.picks)]
    );
  }
  return graded;
}

async function getRankings(year) {
  const result = await db.query(`
    SELECT dr.* FROM draft_rankings dr
    JOIN seasons s ON s.id = dr.season_id
    WHERE s.year = $1
    ORDER BY dr.overall_rank ASC
  `, [year]);
  return result.rows;
}

async function updateRankingById(id, { rank, playerName, position, team }) {
  let sleeperPlayerId = null;
  try { sleeperPlayerId = await players.findPlayerId(playerName, position); } catch (e) { /* non-fatal */ }
  const result = await db.query(
    `UPDATE draft_rankings SET
       overall_rank = $1, player_name = $2, position = $3, team = $4, sleeper_player_id = $5
     WHERE id = $6 RETURNING *`,
    [rank, playerName, position || null, team || null, sleeperPlayerId, id]
  );
  return result.rows[0] || null;
}

async function deleteRankingById(id) {
  await db.query('DELETE FROM draft_rankings WHERE id = $1', [id]);
}

async function deleteAllRankingsForYear(year) {
  const result = await db.query(
    `DELETE FROM draft_rankings WHERE season_id = (SELECT id FROM seasons WHERE year = $1) RETURNING id`,
    [year]
  );
  return result.rows.length;
}

module.exports = { parseRankingsCSV, importRankings, computeDraftGrades, computeAndStore, getRankings, updateRankingById, deleteRankingById, deleteAllRankingsForYear };
