const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateMatchupWriteups, getHeadToHead, getCareerProfile } = require('../writeupGenerator');
const { computeRecordBook } = require('../recordBook');
const { getRankings, computeAndStore } = require('../draftGrading');
const { listDues } = require('../dues');
const { listKeepers } = require('../keepers');
const { getSetting } = require('../settings');

// All owners, with counts so it's obvious which ones actually have data attached
router.get('/owners', async (req, res) => {
  const result = await db.query(`
    SELECT o.*,
      (SELECT COUNT(*) FROM season_results sr WHERE sr.owner_id = o.id) AS season_count,
      (SELECT COUNT(*) FROM keepers k WHERE k.owner_id = o.id) AS keeper_count
    FROM owners o ORDER BY o.name ASC
  `);
  res.json(result.rows);
});

// All-time leaderboard: one row per owner, aggregated across every season on record
router.get('/records', async (req, res) => {
  const result = await db.query(`
    SELECT
      o.id AS owner_id,
      o.name,
      o.sleeper_user_id,
      COUNT(sr.id) AS seasons_played,
      COALESCE(SUM(sr.wins),0) AS total_wins,
      COALESCE(SUM(sr.losses),0) AS total_losses,
      COALESCE(SUM(sr.ties),0) AS total_ties,
      COALESCE(SUM(sr.points_for),0) AS total_points_for,
      COALESCE(SUM(sr.points_against),0) AS total_points_against,
      COUNT(*) FILTER (WHERE sr.made_playoffs) AS playoff_appearances,
      COALESCE(SUM(sr.playoff_wins),0) AS playoff_wins,
      COALESCE(SUM(sr.playoff_losses),0) AS playoff_losses,
      COUNT(*) FILTER (WHERE sr.made_championship) AS championship_appearances,
      COUNT(*) FILTER (WHERE sr.won_championship) AS championships,
      COUNT(*) FILTER (WHERE sr.last_place) AS times_last_place
    FROM owners o
    LEFT JOIN season_results sr ON sr.owner_id = o.id
    GROUP BY o.id, o.name, o.sleeper_user_id
    ORDER BY championships DESC, total_wins DESC
  `);
  res.json(result.rows);
});

// Season-by-season history, most recent first
router.get('/seasons', async (req, res) => {
  const seasons = await db.query('SELECT * FROM seasons ORDER BY year DESC');
  const results = await db.query(`
    SELECT sr.*, o.name AS owner_name, s.year, s.platform
    FROM season_results sr
    JOIN owners o ON o.id = sr.owner_id
    JOIN seasons s ON s.id = sr.season_id
    ORDER BY s.year DESC, sr.regular_season_rank ASC NULLS LAST
  `);
  const bySeasonId = {};
  results.rows.forEach(r => {
    (bySeasonId[r.season_id] = bySeasonId[r.season_id] || []).push(r);
  });
  const payload = seasons.rows.map(s => ({
    ...s,
    teams: bySeasonId[s.id] || []
  }));
  res.json(payload);
});

// One owner's full career: aggregate totals plus every season they played
router.get('/owners/:id/career', async (req, res) => {
  const ownerId = req.params.id;
  const owner = await db.query('SELECT * FROM owners WHERE id = $1', [ownerId]);
  if (!owner.rows.length) return res.status(404).json({ error: 'Owner not found' });
  const seasons = await db.query(`
    SELECT sr.*, s.year, s.platform
    FROM season_results sr JOIN seasons s ON s.id = sr.season_id
    WHERE sr.owner_id = $1
    ORDER BY s.year DESC
  `, [ownerId]);
  res.json({ owner: owner.rows[0], seasons: seasons.rows });
});

// Draft grades for a season. If a completed draft + rankings exist but grades
// haven't been computed yet, computes them now and caches the result.
router.get('/draft-grades/:year', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  try {
    const existing = await db.query(`
      SELECT dg.*, o.name AS owner_name FROM draft_grades dg
      JOIN owners o ON o.id = dg.owner_id
      JOIN seasons s ON s.id = dg.season_id
      WHERE s.year = $1
      ORDER BY dg.score DESC
    `, [year]);
    if (existing.rows.length) {
      return res.json({ ready: true, cached: true, results: existing.rows });
    }
    const graded = await computeAndStore(year);
    if (!graded.ready) return res.json(graded);
    const fresh = await db.query(`
      SELECT dg.*, o.name AS owner_name FROM draft_grades dg
      JOIN owners o ON o.id = dg.owner_id
      JOIN seasons s ON s.id = dg.season_id
      WHERE s.year = $1
      ORDER BY dg.score DESC
    `, [year]);
    res.json({ ready: true, cached: false, results: fresh.rows });
  } catch (e) {
    res.json({ ready: false, reason: e.message });
  }
});

// AI-written weekly matchup previews for a live Sleeper league + week.
// Cached in the database — generates on first request, instant after that.
router.get('/matchup-writeups', async (req, res) => {
  const { leagueId, week } = req.query;
  if (!leagueId || !week) return res.status(400).json({ error: 'leagueId and week query params are required' });
  try {
    const result = await generateMatchupWriteups(leagueId, parseInt(week, 10));
    res.json(result);
  } catch (e) {
    res.json({ ready: false, reason: e.message });
  }
});

// Keepers declared for a season, grouped by owner
router.get('/keepers/:year', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  const rows = await listKeepers(year);
  res.json(rows);
});

// Site-wide config — currently just the active Sleeper league ID
router.get('/config', async (req, res) => {
  const leagueId = await getSetting('current_league_id');
  res.json({ leagueId: leagueId || null });
});

// Pre-draft rankings on file for a season, for display or verification
router.get('/draft-rankings/:year', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  const rows = await getRankings(year);
  res.json(rows);
});

// Dues status for every owner for a season
router.get('/dues/:year', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  const rows = await listDues(year);
  res.json(rows);
});

// League-wide record book — highest/lowest scores, streaks, closest/biggest margins
router.get('/record-book', async (req, res) => {
  try {
    const result = await computeRecordBook();
    res.json(result);
  } catch (e) {
    res.json({ ready: false, reason: e.message });
  }
});

// Head-to-head record between two current league members, looked up by their Sleeper user IDs
router.get('/head-to-head', async (req, res) => {
  const { userA, userB } = req.query;
  if (!userA || !userB) return res.status(400).json({ error: 'userA and userB query params are required' });
  try {
    const ownerA = await db.query('SELECT id, name FROM owners WHERE sleeper_user_id = $1', [userA]);
    const ownerB = await db.query('SELECT id, name FROM owners WHERE sleeper_user_id = $1', [userB]);
    if (!ownerA.rows.length || !ownerB.rows.length) {
      return res.json({ ready: false, reason: 'No history on file for one or both of these teams yet.' });
    }
    const h2h = await getHeadToHead(ownerA.rows[0].id, ownerB.rows[0].id);
    res.json({ ready: true, ownerAName: ownerA.rows[0].name, ownerBName: ownerB.rows[0].name, ...h2h });
  } catch (e) {
    res.json({ ready: false, reason: e.message });
  }
});

// Full comparison report between any two managers on file (by internal owner id —
// works for past/departed managers too, not just current Sleeper league members)
router.get('/manager-comparison', async (req, res) => {
  const ownerAId = parseInt(req.query.ownerA, 10);
  const ownerBId = parseInt(req.query.ownerB, 10);
  if (!ownerAId || !ownerBId) return res.status(400).json({ error: 'ownerA and ownerB query params are required' });
  try {
    const [ownerA, ownerB] = await Promise.all([
      db.query('SELECT * FROM owners WHERE id = $1', [ownerAId]),
      db.query('SELECT * FROM owners WHERE id = $1', [ownerBId])
    ]);
    if (!ownerA.rows.length || !ownerB.rows.length) {
      return res.json({ ready: false, reason: 'One or both managers could not be found.' });
    }
    const [h2h, careerA, careerB] = await Promise.all([
      getHeadToHead(ownerAId, ownerBId),
      getCareerProfile(ownerAId),
      getCareerProfile(ownerBId)
    ]);
    res.json({
      ready: true,
      ownerA: { id: ownerAId, name: ownerA.rows[0].name, sleeper_user_id: ownerA.rows[0].sleeper_user_id, career: careerA },
      ownerB: { id: ownerBId, name: ownerB.rows[0].name, sleeper_user_id: ownerB.rows[0].sleeper_user_id, career: careerB },
      h2h
    });
  } catch (e) {
    res.json({ ready: false, reason: e.message });
  }
});

// All-time lineup mistakes for an owner, computed at sync time (not live)
router.get('/lineup-mistakes', async (req, res) => {
  const ownerId = parseInt(req.query.ownerId, 10);
  if (!ownerId) return res.status(400).json({ error: 'ownerId query param is required' });
  const result = await db.query(`
    SELECT lm.*, s.year FROM lineup_mistakes lm
    JOIN seasons s ON s.id = lm.season_id
    WHERE lm.owner_id = $1
    ORDER BY s.year DESC, lm.week DESC
  `, [ownerId]);
  res.json({ count: result.rows.length, mistakes: result.rows });
});

module.exports = router;
