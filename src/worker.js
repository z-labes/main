import { ensureSchema } from './schema.js';
import { currentWeek, loadWeek, isLocked, parseWeekKey } from './espn.js';

const SESSION_DAYS = 365;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// ---------- names, PINs and sessions ----------

function cleanName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (name.length > 40 || !/^[\p{L}][\p{L}'’.-]*( [\p{L}][\p{L}'’.-]*)+$/u.test(name)) {
    throw new HttpError(400, 'Please use your first and last name (letters only).');
  }
  return name;
}

const nameKey = (name) => name.toLowerCase().replace(/’/g, "'");

function checkPin(pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) throw new HttpError(400, 'Your PIN must be exactly 4 numbers.');
  return String(pin);
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 },
    key,
    256
  );
  return toHex(bits);
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function createSession(db, userId) {
  const token = randomHex(32);
  await db
    .prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, Date.now() + SESSION_DAYS * 86400000)
    .run();
  return token;
}

const publicUser = (u) => ({ id: u.id, name: u.name, status: u.status, isFamily: !!u.is_family });

async function currentUser(req, db) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  return db
    .prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`)
    .bind(m[1], Date.now())
    .first();
}

async function requireUser(req, db) {
  const u = await currentUser(req, db);
  if (!u) throw new HttpError(401, 'Please sign in first.');
  return u;
}

function requireAdmin(req, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin is not set up yet. Add an ADMIN_PASSWORD secret in Cloudflare.');
  if (!safeEqual(req.headers.get('X-Admin-Key') || '', env.ADMIN_PASSWORD)) throw new HttpError(401, 'Wrong admin password.');
}

async function body(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Bad request');
  }
}

// ---------- grading ----------

// A pick wins only if it was made before kickoff and matches the winner. Ties are losses,
// and a game the person never picked (because it had started) is a loss.
function grade(game, pick) {
  if (!game.winner) return null;
  if (!pick || pick.picked_at >= game.start_ts) return 'L';
  return pick.pick === game.winner ? 'W' : 'L';
}

// ---------- handlers ----------

async function signup(req, db) {
  const b = await body(req);
  const name = cleanName(b.name);
  const pin = checkPin(b.pin);
  const existing = await db.prepare(`SELECT id FROM users WHERE name_key = ?`).bind(nameKey(name)).first();
  if (existing) throw new HttpError(409, 'That name is already signed up. Try signing in instead.');
  const salt = randomHex(16);
  const row = await db
    .prepare(`INSERT INTO users (name, name_key, pin_hash, pin_salt, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING *`)
    .bind(name, nameKey(name), await hashPin(pin, salt), salt, Date.now())
    .first();
  return json({ token: await createSession(db, row.id), me: publicUser(row) });
}

async function login(req, db) {
  const b = await body(req);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const pin = String(b.pin || '');
  const u = await db.prepare(`SELECT * FROM users WHERE name_key = ?`).bind(nameKey(name)).first();
  if (!u) throw new HttpError(401, "We couldn't find that name. Check the spelling or sign up.");
  if (u.status === 'rejected') throw new HttpError(403, 'This account was not approved.');
  if (u.locked_until > Date.now()) throw new HttpError(429, 'Too many wrong PINs. Try again in 15 minutes.');
  if ((await hashPin(pin, u.pin_salt)) !== u.pin_hash) {
    const fails = u.failed_attempts + 1;
    const lock = fails >= MAX_FAILED_LOGINS ? Date.now() + LOCKOUT_MS : 0;
    await db
      .prepare(`UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?`)
      .bind(lock ? 0 : fails, lock, u.id)
      .run();
    throw new HttpError(401, lock ? 'Too many wrong PINs. Try again in 15 minutes.' : 'Wrong PIN.');
  }
  await db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?`).bind(u.id).run();
  return json({ token: await createSession(db, u.id), me: publicUser(u) });
}

async function logout(req, db) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('Authorization') || '');
  if (m) await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(m[1]).run();
  return json({ ok: true });
}

function gameOut(g, now) {
  return {
    id: g.id,
    start: g.start_ts,
    state: g.state,
    detail: g.detail,
    locked: isLocked(g, now),
    neutral: !!g.neutral,
    winner: g.winner,
    away: { abbr: g.away_abbr, name: g.away_name, logo: g.away_logo, record: g.away_record, score: g.away_score },
    home: { abbr: g.home_abbr, name: g.home_name, logo: g.home_logo, record: g.home_record, score: g.home_score },
  };
}

async function getWeek(req, db, url) {
  const cur = await currentWeek(db);
  const key = url.searchParams.get('key') || cur.key;
  if (!parseWeekKey(key)) throw new HttpError(400, 'Bad week');
  const wk = await loadWeek(db, key);
  const now = Date.now();
  const me = await currentUser(req, db);

  const { results: picks } = await db
    .prepare(
      `SELECT p.user_id, p.game_id, p.pick, p.picked_at FROM picks p JOIN users u ON u.id = p.user_id
       WHERE p.week_key = ? AND (u.status = 'approved' OR u.id = ?)`
    )
    .bind(key, me?.id ?? -1)
    .all();
  const { results: subs } = await db
    .prepare(
      `SELECT s.user_id, s.submitted_at, u.name, u.status FROM submissions s JOIN users u ON u.id = s.user_id
       WHERE s.week_key = ? AND (u.status = 'approved' OR u.id = ?) ORDER BY u.name`
    )
    .bind(key, me?.id ?? -1)
    .all();

  const byUser = new Map();
  for (const p of picks) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, new Map());
    byUser.get(p.user_id).set(p.game_id, p);
  }
  const games = wk.games.map((g) => gameOut(g, now));

  // Everyone's picks, but only for games that have kicked off.
  const others = subs
    .filter((s) => s.status === 'approved')
    .map((s) => {
      const mine = byUser.get(s.user_id) || new Map();
      const out = {};
      let w = 0;
      let l = 0;
      for (const g of wk.games) {
        if (!isLocked(g, now)) continue;
        const p = mine.get(g.id);
        const result = grade(g, p);
        if (result === 'W') w++;
        if (result === 'L') l++;
        out[g.id] = { pick: p && p.picked_at < g.start_ts ? p.pick : null, result };
      }
      return { userId: s.user_id, name: s.name, picks: out, w, l };
    });

  let mine = null;
  if (me) {
    const sub = subs.find((s) => s.user_id === me.id);
    const myPicks = byUser.get(me.id) || new Map();
    const out = {};
    for (const g of wk.games) {
      const p = myPicks.get(g.id);
      out[g.id] = { pick: p ? p.pick : null, result: sub ? grade(g, p) : null, late: !!sub && !p && isLocked(g, now) };
    }
    mine = { submitted: !!sub, submittedAt: sub?.submitted_at ?? null, picks: out };
  }

  return json({
    week: { key: wk.key, label: wk.label, season: wk.season, type: wk.type, number: wk.week, complete: wk.complete },
    current: cur,
    isCurrent: key === cur.key,
    now,
    games,
    me: me ? publicUser(me) : null,
    mine,
    others,
  });
}

async function submitPicks(req, db) {
  const me = await requireUser(req, db);
  if (me.status === 'rejected') throw new HttpError(403, 'This account was not approved.');
  const b = await body(req);
  const cur = await currentWeek(db);
  if (b.weekKey !== cur.key) throw new HttpError(400, `Picks are only open for ${cur.label}. Refresh the page.`);
  const wk = await loadWeek(db, cur.key, { force: true });
  if (wk.complete) throw new HttpError(400, `${wk.label} is over.`);

  const now = Date.now();
  const submitted = b.picks && typeof b.picks === 'object' ? b.picks : {};
  const open = wk.games.filter((g) => !isLocked(g, now));
  if (!open.length) throw new HttpError(400, `Every ${wk.label} game has already started.`);
  for (const g of open) {
    const pick = submitted[g.id];
    if (pick !== g.home_abbr && pick !== g.away_abbr) {
      throw new HttpError(400, `Pick a winner for ${g.away_name} at ${g.home_name} before submitting.`);
    }
  }

  const stmts = open.map((g) =>
    db
      .prepare(
        `INSERT INTO picks (user_id, game_id, week_key, pick, picked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, game_id) DO UPDATE SET
           pick = excluded.pick,
           picked_at = CASE WHEN picks.pick = excluded.pick THEN picks.picked_at ELSE excluded.picked_at END`
      )
      .bind(me.id, g.id, wk.key, submitted[g.id], now)
  );
  stmts.push(
    db
      .prepare(
        `INSERT INTO submissions (user_id, week_key, submitted_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, week_key) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .bind(me.id, wk.key, now, now)
  );
  await db.batch(stmts);
  const late = wk.games.length - open.length;
  return json({ ok: true, saved: open.length, late });
}

// Every approved player's record for every week of a season, used for all the leaderboards.
async function standings(db, url) {
  const cur = await currentWeek(db);
  const season = Number(url.searchParams.get('season')) || cur.season;

  const { results: weekKeys } = await db
    .prepare(`SELECT DISTINCT week_key FROM submissions WHERE week_key LIKE ?`)
    .bind(`${season}-%`)
    .all();
  const keys = new Set(weekKeys.map((r) => r.week_key));
  if (cur.season === season) keys.add(cur.key);

  const weeks = [];
  for (const key of keys) {
    const wk = await loadWeek(db, key);
    weeks.push(wk);
  }
  weeks.sort((a, b) => a.type - b.type || a.week - b.week);

  const { results: users } = await db
    .prepare(`SELECT id, name, is_family FROM users WHERE status = 'approved' ORDER BY name`)
    .all();
  const { results: subs } = await db
    .prepare(`SELECT s.user_id, s.week_key FROM submissions s JOIN users u ON u.id = s.user_id WHERE u.status = 'approved' AND s.week_key LIKE ?`)
    .bind(`${season}-%`)
    .all();
  const { results: picks } = await db
    .prepare(`SELECT p.user_id, p.game_id, p.pick, p.picked_at FROM picks p JOIN users u ON u.id = p.user_id WHERE u.status = 'approved' AND p.week_key LIKE ?`)
    .bind(`${season}-%`)
    .all();
  const pickMap = new Map(picks.map((p) => [`${p.user_id}:${p.game_id}`, p]));
  const weekMap = new Map(weeks.map((w) => [w.key, w]));

  const records = {};
  for (const s of subs) {
    const wk = weekMap.get(s.week_key);
    if (!wk) continue;
    let w = 0;
    let l = 0;
    let pending = 0;
    for (const g of wk.games) {
      const r = grade(g, pickMap.get(`${s.user_id}:${g.id}`));
      if (r === 'W') w++;
      else if (r === 'L') l++;
      else pending++;
    }
    (records[s.user_id] ||= {})[s.week_key] = { w, l, pending };
  }

  return json({
    season,
    current: cur,
    weeks: weeks.map((w) => ({ key: w.key, label: w.label, complete: w.complete, games: w.games.length })),
    users: users.map((u) => ({ id: u.id, name: u.name, isFamily: !!u.is_family })),
    records,
  });
}

// ---------- admin ----------

async function adminUsers(db) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.status, u.is_family, u.created_at,
         (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) AS weeks
       FROM users u ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, u.name`
    )
    .all();
  return json({ users: results.map((u) => ({ ...u, isFamily: !!u.is_family })) });
}

async function adminUpdateUser(req, db, id) {
  const b = await body(req);
  const u = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  if (!u) throw new HttpError(404, 'No such person');
  const stmts = [];
  if (b.status !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(b.status)) throw new HttpError(400, 'Bad status');
    stmts.push(db.prepare(`UPDATE users SET status = ? WHERE id = ?`).bind(b.status, id));
    if (b.status === 'rejected') stmts.push(db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id));
  }
  if (b.isFamily !== undefined) stmts.push(db.prepare(`UPDATE users SET is_family = ? WHERE id = ?`).bind(b.isFamily ? 1 : 0, id));
  if (b.name !== undefined) {
    const name = cleanName(b.name);
    const clash = await db.prepare(`SELECT id FROM users WHERE name_key = ? AND id != ?`).bind(nameKey(name), id).first();
    if (clash) throw new HttpError(409, 'Someone else already has that name.');
    stmts.push(db.prepare(`UPDATE users SET name = ?, name_key = ? WHERE id = ?`).bind(name, nameKey(name), id));
  }
  if (b.pin !== undefined) {
    const pin = checkPin(b.pin);
    const salt = randomHex(16);
    stmts.push(
      db
        .prepare(`UPDATE users SET pin_hash = ?, pin_salt = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?`)
        .bind(await hashPin(pin, salt), salt, id)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true });
}

async function adminDeleteUser(db, id) {
  await db.batch([
    db.prepare(`DELETE FROM picks WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM submissions WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM users WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

async function adminSubmissions(db, url) {
  const cur = await currentWeek(db);
  const key = url.searchParams.get('week') || cur.key;
  const { results } = await db
    .prepare(
      `SELECT s.user_id, u.name, u.status, s.submitted_at, s.updated_at FROM submissions s
       JOIN users u ON u.id = s.user_id WHERE s.week_key = ? ORDER BY u.name`
    )
    .bind(key)
    .all();
  const { results: weeks } = await db.prepare(`SELECT key, label FROM weeks ORDER BY season DESC, season_type DESC, week DESC`).all();
  return json({ week: key, current: cur, weeks, submissions: results });
}

async function adminDeleteSubmission(req, db) {
  const b = await body(req);
  if (!parseWeekKey(b.weekKey)) throw new HttpError(400, 'Bad week');
  await db.batch([
    db.prepare(`DELETE FROM picks WHERE user_id = ? AND week_key = ?`).bind(b.userId, b.weekKey),
    db.prepare(`DELETE FROM submissions WHERE user_id = ? AND week_key = ?`).bind(b.userId, b.weekKey),
  ]);
  return json({ ok: true });
}

// ---------- router ----------

async function handleApi(req, env, url) {
  const db = env.DB;
  await ensureSchema(db);
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method;

  if (method === 'POST' && path === '/signup') return signup(req, db);
  if (method === 'POST' && path === '/login') return login(req, db);
  if (method === 'POST' && path === '/logout') return logout(req, db);
  if (method === 'GET' && path === '/me') {
    const me = await currentUser(req, db);
    return json({ me: me ? publicUser(me) : null });
  }
  if (method === 'GET' && path === '/week') return getWeek(req, db, url);
  if (method === 'POST' && path === '/picks') return submitPicks(req, db);
  if (method === 'GET' && path === '/standings') return standings(db, url);

  if (path.startsWith('/admin/')) {
    requireAdmin(req, env);
    const userMatch = /^\/admin\/users\/(\d+)$/.exec(path);
    if (method === 'GET' && path === '/admin/check') return json({ ok: true });
    if (method === 'GET' && path === '/admin/users') return adminUsers(db);
    if (method === 'POST' && userMatch) return adminUpdateUser(req, db, Number(userMatch[1]));
    if (method === 'DELETE' && userMatch) return adminDeleteUser(db, Number(userMatch[1]));
    if (method === 'GET' && path === '/admin/submissions') return adminSubmissions(db, url);
    if (method === 'POST' && path === '/admin/submissions/delete') return adminDeleteSubmission(req, db);
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error(e);
        return json({ error: 'Something went wrong. Please try again.' }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  // Keeps scores fresh during game days even when nobody has the site open.
  async scheduled(_event, env) {
    await ensureSchema(env.DB);
    const cur = await currentWeek(env.DB);
    await loadWeek(env.DB, cur.key);
  },
};
