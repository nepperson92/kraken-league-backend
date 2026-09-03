-- League history database schema
-- Run this once against your Postgres database before starting the server.

CREATE TABLE IF NOT EXISTS owners (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sleeper_user_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  year INT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('sleeper','espn','yahoo','paper','other')),
  sleeper_league_id TEXT,
  num_teams INT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS season_results (
  id SERIAL PRIMARY KEY,
  season_id INT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  team_name TEXT,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  ties INT DEFAULT 0,
  points_for NUMERIC DEFAULT 0,
  points_against NUMERIC DEFAULT 0,
  regular_season_rank INT,
  made_playoffs BOOLEAN DEFAULT FALSE,
  playoff_wins INT DEFAULT 0,
  playoff_losses INT DEFAULT 0,
  made_championship BOOLEAN DEFAULT FALSE,
  won_championship BOOLEAN DEFAULT FALSE,
  last_place BOOLEAN DEFAULT FALSE,
  UNIQUE(season_id, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_season_results_owner ON season_results(owner_id);
CREATE INDEX IF NOT EXISTS idx_season_results_season ON season_results(season_id);

-- Pasted-in pre-draft rankings, used as the "expected value" reference for grading
CREATE TABLE IF NOT EXISTS draft_rankings (
  id SERIAL PRIMARY KEY,
  season_id INT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  sleeper_player_id TEXT NOT NULL,
  player_name TEXT,
  position TEXT,
  team TEXT,
  overall_rank INT NOT NULL,
  source_label TEXT,
  UNIQUE(season_id, sleeper_player_id)
);

-- Computed draft grades, cached per owner per season
CREATE TABLE IF NOT EXISTS draft_grades (
  id SERIAL PRIMARY KEY,
  season_id INT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  team_name TEXT,
  score INT NOT NULL,
  letter TEXT NOT NULL,
  summary TEXT,
  analysis TEXT,
  picks JSONB,
  computed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(season_id, owner_id)
);
