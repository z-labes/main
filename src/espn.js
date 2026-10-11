// Pulls the NFL schedule, records and scores from ESPN's public scoreboard feed
// and caches them in D1 so we only hit ESPN every couple of minutes.

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const CURRENT_TTL = 10 * 60 * 1000;
const WEEK_TTL = 90 * 1000;

const POSTSEASON_LABELS = { 1: 'Wild Card', 2: 'Divisional Round', 3: 'Conference Championships', 5: 'Super Bowl' };

export function weekKey(season, type, week) {
  return `${season}-${type}-${week}`;
}

export function parseWeekKey(key) {
  const m = /^(\d{4})-(2|3)-(\d{1,2})$/.exec(key || '');
  if (!m) return null;
  return { season: +m[1], type: +m[2], week: +m[3] };
}

export function weekLabel(type, week) {
  return type === 3 ? POSTSEASON_LABELS[week] || `Playoffs Week ${week}` : `Week ${week}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'mickspicks.me' } });
  if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
  return res.json();
}

// Which week the site is currently on, according to ESPN.
export async function currentWeek(db) {
  const now = Date.now();
  const row = await db.prepare(`SELECT value, updated_at FROM meta WHERE key = 'current_week'`).first();
  if (row && now - row.updated_at < CURRENT_TTL) return JSON.parse(row.value);

  try {
    const data = await fetchJson(SCOREBOARD);
    let season = data.season?.year;
    let type = data.season?.type;
    let week = data.week?.number;
    if (type === 1) [type, week] = [2, 1]; // preseason: point at Week 1
    if (type === 4) [type, week] = [3, 5]; // offseason: stay on the Super Bowl
    if (type === 3 && week === 4) week = 5; // skip the Pro Bowl
    const cur = { key: weekKey(season, type, week), season, type, week, label: weekLabel(type, week) };
    await db
      .prepare(`INSERT INTO meta (key, value, updated_at) VALUES ('current_week', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(JSON.stringify(cur), now)
      .run();
    if (data.events) await storeWeek(db, cur, data.events);
    return cur;
  } catch (e) {
    if (row) return JSON.parse(row.value);
    throw e;
  }
}

function toGame(ev, weekKeyStr) {
  const comp = ev.competitions?.[0] || {};
  const status = ev.status?.type || comp.status?.type || {};
  const side = (homeAway) => comp.competitors?.find((c) => c.homeAway === homeAway) || {};
  const home = side('home');
  const away = side('away');
  const record = (c) => (c.records || []).find((r) => r.type === 'total')?.summary || c.records?.[0]?.summary || '';
  let winner = null;
  if (status.completed) {
    if (home.winner) winner = home.team?.abbreviation;
    else if (away.winner) winner = away.team?.abbreviation;
    else winner = 'TIE';
  }
  const score = (c) => (c.score === undefined || status.state === 'pre' ? null : Number(c.score));
  return {
    id: String(ev.id),
    week_key: weekKeyStr,
    start_ts: Date.parse(ev.date),
    state: status.completed ? 'post' : status.state || 'pre',
    detail: status.shortDetail || status.detail || '',
    away_abbr: away.team?.abbreviation,
    away_name: away.team?.displayName,
    away_logo: away.team?.logo,
    away_record: record(away),
    away_score: score(away),
    home_abbr: home.team?.abbreviation,
    home_name: home.team?.displayName,
    home_logo: home.team?.logo,
    home_record: record(home),
    home_score: score(home),
    neutral: comp.neutralSite ? 1 : 0,
    winner,
  };
}

async function storeWeek(db, wk, events) {
  const games = events.map((ev) => toGame(ev, wk.key)).filter((g) => g.home_abbr && g.away_abbr);
  const stmts = games.map((g) =>
    db
      .prepare(
        `INSERT INTO games (id, week_key, start_ts, state, detail,
           away_abbr, away_name, away_logo, away_record, away_score,
           home_abbr, home_name, home_logo, home_record, home_score, neutral, winner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           week_key = excluded.week_key, start_ts = excluded.start_ts, state = excluded.state,
           detail = excluded.detail, away_score = excluded.away_score, home_score = excluded.home_score,
           neutral = excluded.neutral, winner = excluded.winner,
           -- keep the records as they were before kickoff, like the printed sheet
           away_record = CASE WHEN games.state = 'pre' THEN excluded.away_record ELSE games.away_record END,
           home_record = CASE WHEN games.state = 'pre' THEN excluded.home_record ELSE games.home_record END`
      )
      .bind(
        g.id, g.week_key, g.start_ts, g.state, g.detail,
        g.away_abbr, g.away_name, g.away_logo, g.away_record, g.away_score,
        g.home_abbr, g.home_name, g.home_logo, g.home_record, g.home_score, g.neutral, g.winner
      )
  );
  const complete = games.length > 0 && games.every((g) => g.state === 'post') ? 1 : 0;
  stmts.push(
    db
      .prepare(
        `INSERT INTO weeks (key, season, season_type, week, label, fetched_at, complete)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, complete = excluded.complete, label = excluded.label`
      )
      .bind(wk.key, wk.season, wk.type, wk.week, wk.label, Date.now(), complete)
  );
  await db.batch(stmts);
}

// Make sure a week's games are in D1 and reasonably fresh, then return them.
export async function loadWeek(db, key, { force = false } = {}) {
  const wk = parseWeekKey(key);
  if (!wk) throw new Error('Bad week');
  const info = { key, season: wk.season, type: wk.type, week: wk.week, label: weekLabel(wk.type, wk.week) };
  const row = await db.prepare(`SELECT fetched_at, complete FROM weeks WHERE key = ?`).bind(key).first();
  const stale = !row || (!row.complete && Date.now() - row.fetched_at > WEEK_TTL);
  if (force || stale) {
    try {
      const data = await fetchJson(`${SCOREBOARD}?dates=${wk.season}&seasontype=${wk.type}&week=${wk.week}`);
      await storeWeek(db, info, data.events || []);
    } catch (e) {
      if (!row) throw e;
    }
  }
  const { results } = await db.prepare(`SELECT * FROM games WHERE week_key = ? ORDER BY start_ts, id`).bind(key).all();
  const meta = await db.prepare(`SELECT complete FROM weeks WHERE key = ?`).bind(key).first();
  return { ...info, complete: !!meta?.complete, games: results };
}

export function isLocked(game, now = Date.now()) {
  return now >= game.start_ts || game.state !== 'pre';
}
