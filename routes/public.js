const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateMatchupWriteups } = require('../writeupGenerator');
const { listKeepers } = require('../keepers');

// All owners
router.get('/owners', async (req, res) => {
  const result = await db.query('SELECT * FROM owners ORDER BY name ASC');
  res.json(result.rows);
});

// All-time leaderboard: one row per owner, aggregated across every season on record
router.get('/records', async (req, res) => {
  const result = await db.query(`
    SELECT
      o.id AS owner_id,
      o.name,
      COUNT(sr.id) AS seasons_played,
      COALESCE(SUM(sr.wins),0) AS total_wins,
      COALESCE(SUM(sr.losses),0) AS total_losses,
      COALESCE(SUM(sr.ties),0) AS total_ties,
      COUNT(*) FILTER (WHERE sr.made_playoffs) AS playoff_appearances,
      COALESCE(SUM(sr.playoff_wins),0) AS playoff_wins,
      COALESCE(SUM(sr.playoff_losses),0) AS playoff_losses,
      COUNT(*) FILTER (WHERE sr.made_championship) AS championship_appearances,
      COUNT(*) FILTER (WHERE sr.won_championship) AS championships,
      COUNT(*) FILTER (WHERE sr.last_place) AS times_last_place
    FROM owners o
    LEFT JOIN season_results sr ON sr.owner_id = o.id
    GROUP BY o.id, o.name
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
    res.status(500).json({ ready: false, reason: e.message });
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
    res.status(500).json({ ready: false, reason: e.message });
  }
});

// Keepers declared for a season, grouped by owner
router.get('/keepers/:year', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  const rows = await listKeepers(year);
  res.json(rows);
});

module.exports = router;
