# League Hub — History Backend

A small API that stores your fantasy league's permanent record book: every owner's
season-by-season results, playoff appearances, championships, and "dead last" finishes —
across any platform, going back as far as you want to enter data.

It pairs with the main `index.html` league site (the live Sleeper dashboard). That site
handles anything true *right now* — standings, matchups, rosters, this year's draft.
This backend handles anything that needs to be *remembered* — career totals and past seasons.

## What's in here

- `server.js` — the Express app
- `schema.sql` — the three database tables (owners, seasons, season_results)
- `sleeperSync.js` — pulls a season from Sleeper and saves it; can walk back through
  every past season your league has run on Sleeper automatically
- `routes/public.js` — read-only endpoints your website calls
- `routes/admin.js` — password-protected endpoints for entering data and running syncs
- `public/index.html` — a simple password-gated page for the commissioner to use, served at `/admin`

## 1. Get a Postgres database

Any of these have a free tier that's plenty for a league site:

- **[Neon](https://neon.tech)** — fastest to set up, generous free tier
- **[Supabase](https://supabase.com)** — free tier, includes a nice table viewer
- **[Railway](https://railway.app)** — can host your database *and* this server together

Whichever you pick, grab the connection string — it looks like
`postgres://user:password@host:5432/dbname`.

## 2. Set up the database tables

Locally (or from the hosting platform's console), with `DATABASE_URL` set:

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL and pick an ADMIN_PASSWORD
npm run migrate
```

This runs `schema.sql` once and creates the three tables.

## 3. Deploy the server

**Railway (recommended — simplest path):**
1. Push this `backend` folder to a GitHub repo (or a repo containing it)
2. In Railway: New Project → Deploy from GitHub → select the repo
3. Add a Postgres plugin (or reuse the one from step 1) and copy its connection string into
   the service's `DATABASE_URL` variable
4. Add the other variables from `.env.example`: `ADMIN_PASSWORD`, `ALLOWED_ORIGIN` (set this
   to your site's URL once it's deployed, e.g. `https://myleague.netlify.app`)
5. Railway gives you a public URL like `https://your-service.up.railway.app` — that's your API base

**Render** and **Fly.io** work the same way: connect the repo, set the same env vars, deploy.

## 4. Enter your league's history

Visit `https://your-api-url/admin`, enter your `ADMIN_PASSWORD`, and:

1. **Sync from Sleeper** — paste your current Sleeper league ID and hit
   "Sync full Sleeper history." This automatically finds and saves every season your
   league has played on Sleeper, including playoff results and who finished last.
2. **Add owners** — for anyone who played in pre-Sleeper years, add them by name here
   (if they're still in the league on Sleeper, their auto-synced owner record will
   already exist — check the name matches before adding a duplicate).
3. **Add pre-Sleeper seasons** — one entry per year (e.g. 2019, ESPN, 10 teams).
4. **Add each team's result** for those years — one entry per owner per season:
   record, regular season rank, playoff results, and whether they won it all or
   finished dead last.

Re-running the Sleeper sync any time (e.g. weekly during the season) keeps the
current year's standings and eventual playoff results up to date automatically.

## 5. Point your site at it

In `index.html` (the main site), the History tab will ask for your API's base URL
the first time you open it — paste in your deployed URL from step 3. It's saved in
the browser after that.

## Draft grades

Each team's completed draft gets a letter grade (A+ through F) and a score out of 100,
with a short written breakdown of their best value pick, biggest reach, and whether they
addressed every starting position. It's driven by comparing when a player was actually
picked against a pre-draft rankings list you provide — no paid API required.

**Once a year, before or any time after your draft:**
1. Get a rankings list from anywhere free — FantasyPros' rankings page, ESPN's
   pre-draft rankings, a podcast's cheat sheet, whatever you like. You just need it as
   plain text, one player per line.
2. Go to `/admin`, scroll to **Draft grades**, and paste it in as `rank,name,position,team`
   (position and team are optional) — e.g.:
   ```
   1,Ja'Marr Chase,WR,CIN
   2,Bijan Robinson,RB,ATL
   3,CeeDee Lamb,WR,DAL
   ```
3. That's it. The first time anyone opens the **Draft Grades** tab on the site after your
   draft finishes, grades compute automatically and are cached — no extra click needed on
   draft day itself. If you re-paste a corrected list later, hit "Force recompute grades."

Grading blends two things: **value** (how far below/above their ranked spot each player
was drafted, weighted more heavily in early rounds) and **roster construction** (whether
each team addressed every starting position their league requires). It's a heuristic, not
a certified football scout — treat it as a fun team-vs-team bragging-rights number, not gospel.



**Public (read-only):**
- `GET /api/owners` — all owners
- `GET /api/records` — all-time leaderboard (wins, championships, playoff appearances, etc.)
- `GET /api/seasons` — every season with each owner's result that year
- `GET /api/owners/:id/career` — one owner's full history
- `GET /api/draft-grades/:year` — grades + analysis for every team's draft that year
  (auto-computes and caches on first request once a completed draft and rankings both exist)

**Admin (require header `x-admin-password: <ADMIN_PASSWORD>`):**
- `POST /api/admin/owners` — add an owner
- `PUT /api/admin/owners/:id` — edit an owner
- `POST /api/admin/seasons` — add/update a season
- `POST /api/admin/season-results` — add/update one owner's result for a season
- `DELETE /api/admin/season-results/:id` — remove a result
- `POST /api/admin/sync/season` — sync one Sleeper season by `leagueId`
- `POST /api/admin/sync/history` — discover and sync every Sleeper season for a league
- `POST /api/admin/draft-rankings/import` — paste a rankings list (`{ year, csv, sourceLabel }`)
- `POST /api/admin/draft-grades/recompute` — force-recompute a season's grades (`{ year }`)

## A note on security

The admin panel uses a single shared password, not real user accounts — fine for a
private league tool, but don't reuse a password you care about, and don't share the
admin URL outside your league.
