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
      longestLossStreak
    }
  };
}

module.exports = { computeRecordBook };
