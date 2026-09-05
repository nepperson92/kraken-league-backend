const db = require('./db');

async function computeRecordBook() {
  const result = await db.query(`
    SELECT mr.*, s.year, o.name AS owner_name, oo.name AS opponent_name
    FROM matchup_results mr
    JOIN seasons s ON s.id = mr.season_id
    JOIN owners o ON o.id = mr.owner_id
    LEFT JOIN owners oo ON oo.id = mr.opponent_owner_id
    ORDER BY s.year ASC, mr.week ASC
  `);
  const rows = result.rows.map(r => ({
    ...r,
    points: Number(r.points),
    opponent_points: Number(r.opponent_points)
  }));

  if (!rows.length) return { ready: false, reason: 'No matchup history on file yet — sync your Sleeper history first.' };

  const highestWeek = [...rows].sort((a, b) => b.points - a.points)[0];
  const lowestWeek = [...rows].sort((a, b) => a.points - b.points)[0];

  const wins = rows.filter(r => r.result === 'W');
  const losses = rows.filter(r => r.result === 'L');

  const biggestBlowout = [...wins].sort((a, b) => (b.points - b.opponent_points) - (a.points - a.opponent_points))[0];
  const closestGame = [...wins].sort((a, b) => (a.points - a.opponent_points) - (b.points - b.opponent_points))[0];
  const unluckiestLoss = [...losses].sort((a, b) => b.points - a.points)[0]; // most points scored while still losing
  const luckiestWin = [...wins].sort((a, b) => a.points - b.points)[0]; // fewest points scored while still winning

  // Streaks: walk each owner's games in chronological order
  const byOwner = {};
  rows.forEach(r => { (byOwner[r.owner_id] = byOwner[r.owner_id] || []).push(r); });

  let longestWinStreak = null, longestLossStreak = null;
  Object.values(byOwner).forEach(games => {
    let curW = 0, curL = 0, bestW = 0, bestL = 0, bestWEnd = null, bestLEnd = null, bestWStart = null, bestLStart = null, wStart = null, lStart = null;
    games.forEach(g => {
      if (g.result === 'W') {
        if (curW === 0) wStart = g;
        curW++; curL = 0;
        if (curW > bestW) { bestW = curW; bestWEnd = g; bestWStart = wStart; }
      } else if (g.result === 'L') {
        if (curL === 0) lStart = g;
        curL++; curW = 0;
        if (curL > bestL) { bestL = curL; bestLEnd = g; bestLStart = lStart; }
      } else {
        curW = 0; curL = 0;
      }
    });
    if (bestW > 0 && (!longestWinStreak || bestW > longestWinStreak.length)) {
      longestWinStreak = { length: bestW, owner_name: games[0].owner_name, endYear: bestWEnd.year, endWeek: bestWEnd.week, startYear: bestWStart.year, startWeek: bestWStart.week };
    }
    if (bestL > 0 && (!longestLossStreak || bestL > longestLossStreak.length)) {
      longestLossStreak = { length: bestL, owner_name: games[0].owner_name, endYear: bestLEnd.year, endWeek: bestLEnd.week, startYear: bestLStart.year, startWeek: bestLStart.week };
    }
  });

  // ---- Season-level records (from season_results) ----
  const srResult = await db.query(`
    SELECT sr.*, s.year, o.name AS owner_name, o.id AS owner_id
    FROM season_results sr
    JOIN seasons s ON s.id = sr.season_id
    JOIN owners o ON o.id = sr.owner_id
    ORDER BY o.id ASC, s.year ASC
  `);
  const srRows = srResult.rows.map(r => ({
    ...r,
    points_for: Number(r.points_for || 0),
    points_against: Number(r.points_against || 0),
    regular_season_rank: r.regular_season_rank != null ? Number(r.regular_season_rank) : null
  }));

  // The Ironman — longest streak of consecutive-year playoff appearances
  let ironman = null;
  const srByOwner = {};
  srRows.forEach(r => { (srByOwner[r.owner_id] = srByOwner[r.owner_id] || []).push(r); });
  Object.values(srByOwner).forEach(seasons => {
    let cur = 0, best = 0, curStart = null, bestStart = null, bestEnd = null, prevYear = null;
    seasons.forEach(s => {
      const consecutive = prevYear != null && s.year === prevYear + 1;
      if (s.made_playoffs) {
        if (cur === 0 || !consecutive) curStart = s.year;
        cur = consecutive && cur > 0 ? cur + 1 : 1;
        if (cur > best) { best = cur; bestStart = curStart; bestEnd = s.year; }
      } else {
        cur = 0;
      }
      prevYear = s.year;
    });
    if (best > 0 && (!ironman || best > ironman.length)) {
      ironman = { length: best, owner_name: seasons[0].owner_name, startYear: bestStart, endYear: bestEnd };
    }
  });

  // The Bridesmaid — most championship-game appearances without ever winning one
  const bridesmaidCounts = {};
  srRows.forEach(r => {
    if (!r.made_championship) return;
    bridesmaidCounts[r.owner_id] = bridesmaidCounts[r.owner_id] || { owner_name: r.owner_name, appearances: 0, wins: 0 };
    bridesmaidCounts[r.owner_id].appearances++;
    if (r.won_championship) bridesmaidCounts[r.owner_id].wins++;
  });
  const bridesmaid = Object.values(bridesmaidCounts)
    .filter(b => b.wins === 0)
    .sort((a, b) => b.appearances - a.appearances)[0] || null;

  // Best Team to Miss the Playoffs — highest points_for in a season that still missed
  const missedPlayoffs = srRows.filter(r => !r.made_playoffs && r.points_for > 0);
  const bestMissed = [...missedPlayoffs].sort((a, b) => b.points_for - a.points_for)[0] || null;

  // Biggest Single-Season Collapse — largest year-over-year jump in regular season rank (higher number = worse)
  let biggestCollapse = null;
  Object.values(srByOwner).forEach(seasons => {
    for (let i = 1; i < seasons.length; i++) {
      const prev = seasons[i - 1], cur = seasons[i];
      if (prev.regular_season_rank == null || cur.regular_season_rank == null) continue;
      const drop = cur.regular_season_rank - prev.regular_season_rank;
      if (drop > 0 && (!biggestCollapse || drop > biggestCollapse.drop)) {
        biggestCollapse = { owner_name: cur.owner_name, drop, fromRank: prev.regular_season_rank, toRank: cur.regular_season_rank, fromYear: prev.year, toYear: cur.year };
      }
    }
  });

  // Most Dominant Season — largest point differential (PF - PA) in a single season
  const mostDominant = [...srRows]
    .filter(r => r.points_for > 0 || r.points_against > 0)
    .sort((a, b) => (b.points_for - b.points_against) - (a.points_for - a.points_against))[0] || null;

  // Best Rivalry — the pair of managers with the most all-time meetings
  const rivalryResult = await db.query(`
    SELECT
      LEAST(mr.owner_id, mr.opponent_owner_id) AS owner_a,
      GREATEST(mr.owner_id, mr.opponent_owner_id) AS owner_b,
      COUNT(*) / 2 AS meetings
    FROM matchup_results mr
    WHERE mr.opponent_owner_id IS NOT NULL
    GROUP BY owner_a, owner_b
    ORDER BY meetings DESC
    LIMIT 1
  `);
  let bestRivalry = null;
  if (rivalryResult.rows.length && rivalryResult.rows[0].meetings > 0) {
    const { owner_a, owner_b, meetings } = rivalryResult.rows[0];
    const [nameA, nameB] = await Promise.all([
      db.query('SELECT name FROM owners WHERE id=$1', [owner_a]),
      db.query('SELECT name FROM owners WHERE id=$1', [owner_b])
    ]);
    bestRivalry = { ownerAName: nameA.rows[0]?.name, ownerBName: nameB.rows[0]?.name, meetings: Number(meetings) };
  }

  // Most Mistake-Prone Season — one manager, one season, most flagged lineup mistakes
  const mistakeSeasonResult = await db.query(`
    SELECT lm.owner_id, lm.season_id, o.name AS owner_name, s.year, COUNT(*) AS mistake_count
    FROM lineup_mistakes lm
    JOIN owners o ON o.id = lm.owner_id
    JOIN seasons s ON s.id = lm.season_id
    GROUP BY lm.owner_id, lm.season_id, o.name, s.year
    ORDER BY mistake_count DESC
    LIMIT 1
  `);
  const mostMistakeProne = mistakeSeasonResult.rows.length
    ? { owner_name: mistakeSeasonResult.rows[0].owner_name, year: mistakeSeasonResult.rows[0].year, count: Number(mistakeSeasonResult.rows[0].mistake_count) }
    : null;

  return {
    ready: true,
    records: {
      highestWeek: highestWeek ? { owner_name: highestWeek.owner_name, opponent_name: highestWeek.opponent_name, points: highestWeek.points, year: highestWeek.year, week: highestWeek.week } : null,
      lowestWeek: lowestWeek ? { owner_name: lowestWeek.owner_name, opponent_name: lowestWeek.opponent_name, points: lowestWeek.points, year: lowestWeek.year, week: lowestWeek.week } : null,
      biggestBlowout: biggestBlowout ? { owner_name: biggestBlowout.owner_name, opponent_name: biggestBlowout.opponent_name, points: biggestBlowout.points, opponent_points: biggestBlowout.opponent_points, margin: biggestBlowout.points - biggestBlowout.opponent_points, year: biggestBlowout.year, week: biggestBlowout.week } : null,
      closestGame: closestGame ? { owner_name: closestGame.owner_name, opponent_name: closestGame.opponent_name, points: closestGame.points, opponent_points: closestGame.opponent_points, margin: closestGame.points - closestGame.opponent_points, year: closestGame.year, week: closestGame.week } : null,
      unluckiestLoss: unluckiestLoss ? { owner_name: unluckiestLoss.owner_name, opponent_name: unluckiestLoss.opponent_name, points: unluckiestLoss.points, opponent_points: unluckiestLoss.opponent_points, year: unluckiestLoss.year, week: unluckiestLoss.week } : null,
      luckiestWin: luckiestWin ? { owner_name: luckiestWin.owner_name, opponent_name: luckiestWin.opponent_name, points: luckiestWin.points, opponent_points: luckiestWin.opponent_points, year: luckiestWin.year, week: luckiestWin.week } : null,
      longestWinStreak,
      longestLossStreak,
      ironman,
      bridesmaid,
      bestMissed: bestMissed ? { owner_name: bestMissed.owner_name, points_for: bestMissed.points_for, year: bestMissed.year, rank: bestMissed.regular_season_rank } : null,
      biggestCollapse,
      mostDominant: mostDominant ? { owner_name: mostDominant.owner_name, points_for: mostDominant.points_for, points_against: mostDominant.points_against, margin: mostDominant.points_for - mostDominant.points_against, year: mostDominant.year } : null,
      bestRivalry,
      mostMistakeProne
    }
  };
}

module.exports = { computeRecordBook };
