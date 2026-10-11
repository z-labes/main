// Tables are created on first request, so a fresh D1 database needs no manual setup.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    pin_hash TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    is_family INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS weeks (
    key TEXT PRIMARY KEY,
    season INTEGER NOT NULL,
    season_type INTEGER NOT NULL,
    week INTEGER NOT NULL,
    label TEXT NOT NULL,
    fetched_at INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    week_key TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    state TEXT NOT NULL,
    detail TEXT,
    away_abbr TEXT, away_name TEXT, away_logo TEXT, away_record TEXT, away_score INTEGER,
    home_abbr TEXT, home_name TEXT, home_logo TEXT, home_record TEXT, home_score INTEGER,
    neutral INTEGER NOT NULL DEFAULT 0,
    winner TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS games_week ON games(week_key)`,
  `CREATE TABLE IF NOT EXISTS submissions (
    user_id INTEGER NOT NULL,
    week_key TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, week_key)
  )`,
  `CREATE TABLE IF NOT EXISTS picks (
    user_id INTEGER NOT NULL,
    game_id TEXT NOT NULL,
    week_key TEXT NOT NULL,
    pick TEXT NOT NULL,
    picked_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, game_id)
  )`,
  `CREATE INDEX IF NOT EXISTS picks_week ON picks(week_key)`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

let ready = null;
export function ensureSchema(db) {
  if (!ready) {
    ready = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
