const express = require('express');
const router = express.Router();
const db = require('../db');
const { syncSeason, syncAllSleeperHistory, syncMatchupHistory } = require('../sleeperSync');
const { parseRankingsCSV, importRankings, computeAndStore } = require('../draftGrading');
const { clearWriteups, generateMatchupWriteups } = require('../writeupGenerator');
const { addOrUpdateKeeper, updateKeeperById } = require('../keepers');

function requireAdmin(req, res, next) {
  const provided = req.header('x-admin-password');
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Server has no ADMIN_PASSWORD configured.' });
  }
  if (provided !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  next();
}
router.use(requireAdmin);

// Side-effect-free password check, used by the admin panel's login screen
router.get('/ping', (req, res) => res.json({ ok: true }));

// ---- Owners ----
router.post('/owners', async (req, res) => {
  const { name, sleeper_user_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await db.query(
    'INSERT INTO owners (name, sleeper_user_id) VALUES ($1,$2) RETURNING *',
    [name, sleeper_user_id || null]
  );
  res.json(result.rows[0]);
});

router.put('/owners/:id', async (req, res) => {
  const { name, sleeper_user_id } = req.body;
  const result = await db.query(
    'UPDATE owners SET name = COALESCE($1,name), sleeper_user_id = $2 WHERE id = $3 RETURNING *',
    [name, sleeper_user_id || null, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Owner not found' });
  res.json(result.rows[0]);
});

router.delete('/owners/:id', async (req, res) => {
  const result = await db.query('DELETE FROM owners WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Owner not found' });
  res.json({ ok: true });
});

// ---- Seasons (for manually entering pre-Sleeper years) ----
router.post('/seasons', async (req, res) => {
  const { year, platform, num_teams, notes } = req.body;
  if (!year || !platform) return res.status(400).json({ error: 'year and platform are required' });
  const result = await db.query(
    `INSERT INTO seasons (year, platform, num_teams, notes) VALUES ($1,$2,$3,$4)
     ON CONFLICT (year) DO UPDATE SET platform = EXCLUDED.platform, num_teams = EXCLUDED.num_teams, notes = EXCLUDED.notes
     RETURNING *`,
    [year, platform, num_teams || null, notes || null]
  );
  res.json(result.rows[0]);
});

// ---- Season results (manual entry / correction, one row per owner per season) ----
router.post('/season-results', async (req, res) => {
  const {
    season_id, owner_id, team_name, wins, losses, ties, points_for, points_against,
    regular_season_rank, made_playoffs, playoff_wins, playoff_losses,
    made_championship, won_championship, last_place
  } = req.body;
  if (!season_id || !owner_id) return res.status(400).json({ error: 'season_id and owner_id are required' });

  const result = await db.query(
    `INSERT INTO season_results
      (season_id, owner_id, team_name, wins, losses, ties, points_for, points_against,
       regular_season_rank, made_playoffs, playoff_wins, playoff_losses,
       made_championship, won_championship, last_place)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (season_id, owner_id) DO UPDATE SET
       team_name=EXCLUDED.team_name, wins=EXCLUDED.wins, losses=EXCLUDED.losses, ties=EXCLUDED.ties,
       points_for=EXCLUDED.points_for, points_against=EXCLUDED.points_against,
       regular_season_rank=EXCLUDED.regular_season_rank, made_playoffs=EXCLUDED.made_playoffs,
       playoff_wins=EXCLUDED.playoff_wins, playoff_losses=EXCLUDED.playoff_losses,
       made_championship=EXCLUDED.made_championship, won_championship=EXCLUDED.won_championship,
       last_place=EXCLUDED.last_place
     RETURNING *`,
    [
      season_id, owner_id, team_name || null,
      wins || 0, losses || 0, ties || 0, points_for || 0, points_against || 0,
      regular_season_rank || null, !!made_playoffs, playoff_wins || 0, playoff_losses || 0,
      !!made_championship, !!won_championship, !!last_place
    ]
  );
  res.json(result.rows[0]);
});

router.delete('/season-results/:id', async (req, res) => {
  await db.query('DELETE FROM season_results WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- Sleeper sync ----
// Sync one season by its Sleeper league_id
router.post('/sync/season', async (req, res) => {
  const { leagueId } = req.body;
  if (!leagueId) return res.status(400).json({ error: 'leagueId is required' });
  try {
    const result = await syncSeason(leagueId);
    const matchupResult = await syncMatchupHistory(result.seasonId, leagueId);
    res.json({ ok: true, result: { ...result, ...matchupResult } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Discover and sync every season this league has run on Sleeper (walks previous_league_id)
router.post('/sync/history', async (req, res) => {
  const { leagueId } = req.body;
  if (!leagueId) return res.status(400).json({ error: 'leagueId is required' });
  try {
    const results = await syncAllSleeperHistory(leagueId);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Draft grading ----
// Paste in a rankings list (rank,name,position,team per line) to power grading for a season
router.post('/draft-rankings/import', async (req, res) => {
  const { year, csv, sourceLabel } = req.body;
  if (!year || !csv) return res.status(400).json({ error: 'year and csv are required' });
  try {
    const rows = parseRankingsCSV(csv);
    if (!rows.length) return res.status(400).json({ error: 'Could not parse any rows from that list.' });
    const result = await importRankings(year, rows, sourceLabel);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force a recompute of draft grades for a season (e.g. after correcting rankings)
router.post('/draft-grades/recompute', async (req, res) => {
  const { year } = req.body;
  if (!year) return res.status(400).json({ error: 'year is required' });
  try {
    await db.query(`DELETE FROM draft_grades WHERE season_id = (SELECT id FROM seasons WHERE year = $1)`, [year]);
    const graded = await computeAndStore(year);
    res.json(graded);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force-regenerate this week's matchup writeups (e.g. lineups changed, or you just want a redo)
router.post('/matchup-writeups/regenerate', async (req, res) => {
  const { leagueId, week, year } = req.body;
  if (!leagueId || !week || !year) return res.status(400).json({ error: 'leagueId, week, and year are required' });
  try {
    await clearWriteups(leagueId, year, week);
    const result = await generateMatchupWriteups(leagueId, parseInt(week, 10));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Keepers ----
router.post('/keepers', async (req, res) => {
  const { year, ownerId, playerName, position, team, cost, notes } = req.body;
  if (!year || !ownerId || !playerName) return res.status(400).json({ error: 'year, ownerId, and playerName are required' });
  try {
    const keeper = await addOrUpdateKeeper({ year, ownerId, playerName, position, team, cost, notes });
    res.json(keeper);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/keepers/:id', async (req, res) => {
  await db.query('DELETE FROM keepers WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.put('/keepers/:id', async (req, res) => {
  const { ownerId, playerName, position, team, cost, notes } = req.body;
  if (!ownerId || !playerName) return res.status(400).json({ error: 'ownerId and playerName are required' });
  try {
    const keeper = await updateKeeperById(req.params.id, { ownerId, playerName, position, team, cost, notes });
    if (!keeper) return res.status(404).json({ error: 'Keeper not found' });
    res.json(keeper);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
