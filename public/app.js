// Mick's Picks front end: a tiny hash-routed app with no build step.

const app = document.getElementById('app');
const PRIOR_GAMES = 48; // adjusted win % = (wins + 24) / (games + 48)

const state = {
  token: load('mp_token'),
  me: null,
  week: null,
  draft: {},
  adminKey: loadSession('mp_admin'),
  refreshTimer: null,
};

// ---------- small helpers ----------

function load(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function save(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
}
function loadSession(k) {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function saveSession(k, v) {
  try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {}
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (admin && state.adminKey) headers['X-Admin-Key'] = state.adminKey;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const shortFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const pct = (w, l) => (w + l ? (w / (w + l)) : 0);
const fmtPct = (x) => x.toFixed(3).replace(/^0/, '');
const adjusted = (w, l) => (w + PRIOR_GAMES / 2) / (w + l + PRIOR_GAMES);

function setHeader(week) {
  if (!week) return;
  document.getElementById('week-title').textContent = week.label;
  document.getElementById('season-label').textContent = `${week.season} NFL Season`;
  document.title = `Mick's Picks · ${week.label}`;
}

function setTab(route) {
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
}

// ---------- account ----------

function accountCard() {
  if (state.me) {
    const pending = state.me.status === 'pending';
    return `
      <section class="card account signed-in">
        <div>
          <p class="muted small">Picking as</p>
          <p class="who">${esc(state.me.name)} ${state.me.isFamily ? '<span class="chip family">Family</span>' : ''}</p>
          ${pending ? `<p class="chip pending">Waiting for Mick's approval</p>
            <p class="muted small">You can still make picks. They'll show up on the leaderboard once Mick approves you.</p>` : ''}
        </div>
        <button class="btn ghost" data-action="logout">Sign out</button>
      </section>`;
  }
  return `
    <section class="card account">
      <h2>Who's picking?</h2>
      <p class="muted">Sign in with your first and last name and your 4-number PIN. New? Sign up once and use the same name every week.</p>
      <div class="seg" role="tablist">
        <button class="seg-btn active" data-mode="login" role="tab">Sign in</button>
        <button class="seg-btn" data-mode="signup" role="tab">Sign up</button>
      </div>
      <form class="auth-form" data-mode="login">
        <label>First and last name
          <input name="name" autocomplete="name" placeholder="e.g. Mick Labrum" required maxlength="40">
        </label>
        <label>4-number PIN
          <input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="current-password" placeholder="••••" required>
        </label>
        <p class="hint signup-only" hidden>Pick a PIN you'll remember. Mick will approve you before you show up on the leaderboard.</p>
        <button class="btn primary" type="submit">Sign in</button>
        <p class="form-error" hidden></p>
      </form>
    </section>`;
}

function bindAccount(root) {
  root.querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const mode = b.dataset.mode;
      root.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      const form = root.querySelector('.auth-form');
      form.dataset.mode = mode;
      form.querySelector('button[type=submit]').textContent = mode === 'login' ? 'Sign in' : 'Sign up';
      form.querySelector('.signup-only').hidden = mode !== 'signup';
      form.querySelector('[name=pin]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    })
  );
  const form = root.querySelector('.auth-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      err.hidden = true;
      const fd = new FormData(form);
      try {
        const res = await api(`/${form.dataset.mode}`, { method: 'POST', body: { name: fd.get('name'), pin: fd.get('pin') } });
        state.token = res.token;
        save('mp_token', res.token);
        state.me = res.me;
        toast(form.dataset.mode === 'signup' ? `Welcome, ${res.me.name}!` : `Welcome back, ${res.me.name}!`);
        renderPicks();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  }
  root.querySelector('[data-action=logout]')?.addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.token = null;
    state.me = null;
    save('mp_token', null);
    renderPicks();
  });
}

// ---------- picks page ----------

function teamButton(g, side, chosen, mine) {
  const t = g[side];
  const selected = chosen === t.abbr;
  let result = '';
  if (selected && mine?.result === 'W') result = 'win';
  if (selected && mine?.result === 'L') result = 'loss';
  const isWinner = g.winner === t.abbr;
  const score = t.score != null ? `<span class="score">${t.score}</span>` : '';
  return `
    <button type="button" class="team ${selected ? 'selected' : ''} ${result} ${isWinner ? 'winner' : ''}"
      data-game="${esc(g.id)}" data-team="${esc(t.abbr)}" ${g.locked ? 'disabled' : ''}
      aria-pressed="${selected}" aria-label="${esc(t.name)} (${side === 'home' ? 'home' : 'away'}), record ${esc(t.record)}">
      <span class="side-tag">${side === 'home' ? (g.neutral ? 'Home*' : 'Home') : 'Away'}</span>
      <img src="${esc(t.logo)}" alt="" class="logo" loading="lazy">
      <span class="team-name">${esc(t.name)}</span>
      <span class="record">${esc(t.record || '0-0')}</span>
      ${score}
      ${selected ? `<span class="check" aria-hidden="true">${result === 'loss' ? '✕' : '✓'}</span>` : ''}
    </button>`;
}

function gameStatus(g, mine) {
  if (g.state === 'pre' && !g.locked) return `<span class="kick">${timeFmt.format(new Date(g.start))}</span>`;
  const label = g.state === 'post' ? (g.winner === 'TIE' ? 'Final · Tie' : 'Final') : g.detail || 'Started';
  let note = '';
  if (mine?.late) note = '<span class="chip loss">Auto loss: picked after kickoff</span>';
  else if (mine?.result === 'W') note = '<span class="chip win">Win</span>';
  else if (mine?.result === 'L') note = '<span class="chip loss">Loss</span>';
  return `<span class="kick live ${g.state === 'in' ? 'is-live' : ''}">${esc(label)}</span>${note}`;
}

function gamesList(week) {
  const mine = week.mine?.picks || {};
  let lastDay = '';
  const rows = week.games.map((g) => {
    const day = dayFmt.format(new Date(g.start));
    const header = day !== lastDay ? `<h3 class="day">${esc(day)}</h3>` : '';
    lastDay = day;
    const chosen = g.locked ? mine[g.id]?.pick : state.draft[g.id];
    return `${header}
      <article class="game ${g.locked ? 'locked' : ''}" id="g-${esc(g.id)}">
        <div class="game-top">${gameStatus(g, week.mine?.submitted ? mine[g.id] : null)}</div>
        <div class="matchup">
          ${teamButton(g, 'away', chosen, mine[g.id])}
          <span class="at">${g.neutral ? 'vs' : '@'}</span>
          ${teamButton(g, 'home', chosen, mine[g.id])}
        </div>
      </article>`;
  });
  return rows.join('');
}

function picksBanner(week) {
  const open = week.games.filter((g) => !g.locked);
  const started = week.games.length - open.length;
  if (!week.isCurrent) return `<div class="banner info">You're looking at ${esc(week.week.label)}. <a href="#/">Go to this week</a></div>`;
  if (!open.length) return `<div class="banner info">Every ${esc(week.week.label)} game has kicked off. Picks for next week open once ESPN posts the new slate.</div>`;
  const parts = [];
  if (week.mine?.submitted) parts.push(`<strong>Your picks are in.</strong> You can change any game that hasn't kicked off yet.`);
  else parts.push(`<strong>Picks are open.</strong> Tap the team you think wins each game, then submit.`);
  if (started && !week.mine?.submitted) parts.push(`${started} game${started > 1 ? 's have' : ' has'} already started, so ${started > 1 ? 'those count' : 'it counts'} as a loss if you submit now.`);
  return `<div class="banner ${started && !week.mine?.submitted ? 'warn' : 'ok'}">${parts.join(' ')}</div>`;
}

function othersTable(week) {
  const started = week.games.filter((g) => g.locked);
  if (!week.others.length && !started.length) {
    return `<p class="muted">Everyone's picks show up here as each game kicks off.</p>`;
  }
  if (!started.length) {
    return `<p class="muted">${week.others.length} ${week.others.length === 1 ? 'person has' : 'people have'} picked so far. Picks are hidden until each game kicks off.</p>`;
  }
  if (!week.others.length) return `<p class="muted">Nobody's on the board for this week yet.</p>`;
  const sorted = [...week.others].sort((a, b) => b.w - a.w || a.l - b.l || a.name.localeCompare(b.name));
  return `
    <div class="table-scroll">
      <table class="picks-grid">
        <thead><tr><th class="sticky">Name</th><th>W-L</th>
          ${started.map((g) => `<th title="${esc(g.away.name)} at ${esc(g.home.name)}"><span class="mini">${esc(g.away.abbr)}<br>@${esc(g.home.abbr)}</span></th>`).join('')}
        </tr></thead>
        <tbody>
          ${sorted.map((o) => `<tr>
            <th class="sticky">${esc(o.name)}</th><td class="num">${o.w}-${o.l}</td>
            ${started.map((g) => {
              const p = o.picks[g.id];
              if (!p?.pick) return `<td class="cell late" title="Picked after kickoff">—</td>`;
              const team = p.pick === g.home.abbr ? g.home : g.away;
              return `<td class="cell ${p.result === 'W' ? 'win' : p.result === 'L' ? 'loss' : ''}" title="${esc(team.name)}"><img src="${esc(team.logo)}" alt="${esc(team.abbr)}"></td>`;
            }).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function submitBar(week) {
  const open = week.games.filter((g) => !g.locked);
  if (!week.isCurrent || !open.length || !state.me) return '';
  const done = open.filter((g) => state.draft[g.id]).length;
  const ready = done === open.length;
  const label = week.mine?.submitted ? 'Update picks' : 'Submit picks';
  return `
    <div class="submit-bar">
      <div class="progress">
        <span><strong>${done}</strong> of ${open.length} picked</span>
        <span class="bar"><span style="width:${(done / open.length) * 100}%"></span></span>
      </div>
      <button class="btn primary" data-action="submit" ${ready ? '' : 'disabled'}>${label}</button>
    </div>`;
}

async function renderPicks(key) {
  setTab('picks');
  try {
    const week = await api(`/week${key ? `?key=${encodeURIComponent(key)}` : ''}`);
    state.week = week;
    state.me = week.me;
    if (!week.me && state.token) {
      state.token = null;
      save('mp_token', null);
    }
    // Start the draft from saved picks for games that haven't started.
    state.draft = {};
    for (const g of week.games) {
      const p = week.mine?.picks[g.id]?.pick;
      if (!g.locked && p) state.draft[g.id] = p;
    }
    setHeader(week.current);
    drawPicks();
    scheduleRefresh(week);
  } catch (e) {
    app.innerHTML = `<div class="banner warn">Couldn't load the games: ${esc(e.message)}</div>`;
  }
}

function drawPicks() {
  const week = state.week;
  app.innerHTML = `
    ${week.isCurrent ? accountCard() : ''}
    ${picksBanner(week)}
    <section class="games ${state.me || !week.isCurrent ? '' : 'preview'}">
      ${!state.me && week.isCurrent ? '<p class="muted center">Sign in above to make your picks.</p>' : ''}
      ${gamesList(week)}
    </section>
    ${submitBar(week)}
    <section class="card">
      <h2>Everyone's picks · ${esc(week.week.label)}</h2>
      ${othersTable(week)}
    </section>`;
  bindAccount(app);

  app.querySelectorAll('.team:not([disabled])').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (!state.me) {
        toast('Sign in first so we know whose picks these are.', 'warn');
        app.querySelector('.account input')?.focus();
        return;
      }
      state.draft[btn.dataset.game] = btn.dataset.team;
      const game = btn.closest('.game');
      game.querySelectorAll('.team').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-pressed', on);
        b.querySelector('.check')?.remove();
        if (on) b.insertAdjacentHTML('beforeend', '<span class="check" aria-hidden="true">✓</span>');
      });
      updateSubmitBar();
    })
  );
  bindSubmit();
}

function updateSubmitBar() {
  const bar = app.querySelector('.submit-bar');
  if (!bar) return;
  bar.outerHTML = submitBar(state.week);
  bindSubmit();
}

function bindSubmit() {
  app.querySelector('[data-action=submit]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await api('/picks', { method: 'POST', body: { weekKey: state.week.week.key, picks: state.draft } });
      toast(res.late ? `Picks saved! ${res.late} game${res.late > 1 ? 's' : ''} had already started and count as losses.` : 'Picks saved! Good luck this week.');
      await renderPicks();
    } catch (ex) {
      toast(ex.message, 'warn');
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  });
}

function scheduleRefresh(week) {
  clearInterval(state.refreshTimer);
  const live = week.games.some((g) => g.state === 'in') || week.games.some((g) => !g.locked && g.start - Date.now() < 3600000);
  if (!live) return;
  state.refreshTimer = setInterval(async () => {
    if (document.hidden || currentRoute().name !== 'picks') return;
    try {
      const fresh = await api(`/week?key=${encodeURIComponent(week.week.key)}`);
      const draft = state.draft;
      state.week = fresh;
      state.draft = draft;
      for (const g of fresh.games) if (g.locked) delete state.draft[g.id];
      if (!document.activeElement || !app.contains(document.activeElement) || document.activeElement.tagName !== 'INPUT') drawPicks();
    } catch {}
  }, 60000);
}

// ---------- standings: leaderboard + history ----------

function summarize(data) {
  const players = data.users.map((u) => {
    const recs = data.records[u.id] || {};
    let w = 0;
    let l = 0;
    let weeks = 0;
    for (const r of Object.values(recs)) {
      w += r.w;
      l += r.l;
      weeks++;
    }
    return { ...u, w, l, weeks, recs, adj: adjusted(w, l), raw: pct(w, l) };
  });
  return players.filter((p) => p.weeks > 0);
}

function rankRows(rows, cmp, cells) {
  let rank = 0;
  let prev = null;
  return rows
    .map((r, i) => {
      if (!prev || cmp(prev, r) !== 0) rank = i + 1;
      prev = r;
      const medal = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
      return `<tr class="${r.id === state.me?.id ? 'me' : ''}"><td class="rank"><span class="pos ${medal}">${rank}</span></td>${cells(r)}</tr>`;
    })
    .join('');
}

function weeklyWinner(data, players) {
  const done = data.weeks.filter((w) => w.complete);
  for (let i = done.length - 1; i >= 0; i--) {
    const wk = done[i];
    const scores = players.map((p) => ({ p, r: p.recs[wk.key] })).filter((x) => x.r);
    if (!scores.length) continue;
    const best = Math.max(...scores.map((x) => x.r.w));
    const winners = scores.filter((x) => x.r.w === best);
    return { week: wk, winners, best, l: winners[0].r.l };
  }
  return null;
}

function winnerBanner(data, players) {
  const win = weeklyWinner(data, players);
  if (!win) return '';
  const names = win.winners.map((x) => esc(x.p.name)).join(' & ');
  return `
    <section class="trophy">
      <div class="trophy-icon" aria-hidden="true">🏆</div>
      <div>
        <p class="eyebrow">${esc(win.week.label)} ${win.winners.length > 1 ? 'co-winners' : 'winner'}</p>
        <p class="trophy-name">${names}</p>
        <p class="muted-light">${win.best}-${win.l} on the week</p>
      </div>
    </section>`;
}

const seasonCmp = (a, b) => b.adj - a.adj || b.w - a.w || a.l - b.l;

function seasonTable(rows, empty) {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  const sorted = [...rows].sort((a, b) => seasonCmp(a, b) || a.name.localeCompare(b.name));
  return `
    <div class="table-scroll"><table class="board">
      <thead><tr><th>#</th><th class="left">Name</th><th>Record</th><th>Win %</th><th>Weeks</th><th title="Adjusted win %">Score</th></tr></thead>
      <tbody>${rankRows(sorted, seasonCmp, (r) => `
        <td class="left name">${esc(r.name)}</td>
        <td class="num">${r.w}-${r.l}</td>
        <td class="num">${fmtPct(r.raw)}</td>
        <td class="num">${r.weeks}</td>
        <td class="num strong">${fmtPct(r.adj)}</td>`)}
      </tbody>
    </table></div>`;
}

async function renderLeaderboard(weekKey) {
  setTab('leaderboard');
  app.innerHTML = '<p class="loading">Crunching the numbers…</p>';
  try {
    const data = await api('/standings');
    setHeader(data.current);
    const players = summarize(data);
    const weeks = data.weeks.filter((w) => players.some((p) => p.recs[w.key]) || w.key === data.current.key);
    const selected = weekKey && weeks.some((w) => w.key === weekKey) ? weekKey : data.current.key;
    const selWeek = weeks.find((w) => w.key === selected);
    const weekRows = players
      .filter((p) => p.recs[selected])
      .map((p) => ({ ...p, ww: p.recs[selected].w, wl: p.recs[selected].l, wp: p.recs[selected].pending }));
    const weekCmp = (a, b) => b.ww - a.ww || a.wl - b.wl;
    weekRows.sort((a, b) => weekCmp(a, b) || a.name.localeCompare(b.name));

    app.innerHTML = `
      ${winnerBanner(data, players)}
      <section class="card">
        <div class="card-head">
          <h2>Weekly leaderboard</h2>
          <select class="select" id="week-select" aria-label="Choose a week">
            ${weeks.map((w) => `<option value="${esc(w.key)}" ${w.key === selected ? 'selected' : ''}>${esc(w.label)}</option>`).join('')}
          </select>
        </div>
        ${weekRows.length ? `
          <div class="table-scroll"><table class="board">
            <thead><tr><th>#</th><th class="left">Name</th><th>Record</th><th>Still to play</th></tr></thead>
            <tbody>${rankRows(weekRows, weekCmp, (r) => `
              <td class="left name">${esc(r.name)}</td>
              <td class="num strong">${r.ww}-${r.wl}</td>
              <td class="num">${r.wp || '—'}</td>`)}
            </tbody>
          </table></div>` : `<p class="muted">Nobody has picks in for ${esc(selWeek?.label || 'this week')} yet.</p>`}
        <p class="small"><a href="#/week/${esc(selected)}">See everyone's picks for ${esc(selWeek?.label || 'this week')} →</a></p>
      </section>

      <section class="card">
        <h2>Season leaderboard</h2>
        ${seasonTable(players, 'No results yet this season.')}
        <details class="explain">
          <summary>How is the season score figured?</summary>
          <p>Everyone starts the season with 48 pretend games at 24-24 (about three weeks of picks).
          Your score is <strong>(wins + 24) ÷ (games picked + 48)</strong>. That keeps someone who joins late
          with one hot week from jumping past people who've played all year, while a strong record still
          rises to the top as you pick more games. Ties count as losses.</p>
        </details>
      </section>

      <section class="card family-card">
        <h2>Family leaderboard</h2>
        ${seasonTable(players.filter((p) => p.isFamily), 'Mick hasn’t marked anyone as family yet.')}
      </section>`;
    document.getElementById('week-select').addEventListener('change', (e) => {
      location.hash = `#/leaderboard/${e.target.value}`;
    });
  } catch (e) {
    app.innerHTML = `<div class="banner warn">Couldn't load the leaderboard: ${esc(e.message)}</div>`;
  }
}

async function renderHistory() {
  setTab('history');
  app.innerHTML = '<p class="loading">Loading the history…</p>';
  try {
    const data = await api('/standings');
    setHeader(data.current);
    const players = summarize(data).sort((a, b) => seasonCmp(a, b) || a.name.localeCompare(b.name));
    const weeks = data.weeks.filter((w) => players.some((p) => p.recs[w.key]));
    if (!players.length || !weeks.length) {
      app.innerHTML = `<section class="card"><h2>Week-by-week history</h2><p class="muted">Once people start submitting picks, every week's record shows up here.</p></section>`;
      return;
    }
    const best = Object.fromEntries(weeks.map((w) => [w.key, Math.max(...players.map((p) => p.recs[w.key]?.w ?? -1))]));
    app.innerHTML = `
      <section class="card">
        <h2>Week-by-week history · ${data.season}</h2>
        <p class="muted small">🏆 marks the top score of each finished week. Tap a week to see everyone's picks.</p>
        <div class="table-scroll">
          <table class="history">
            <thead><tr><th class="sticky left">Name</th>
              ${weeks.map((w) => `<th><a href="#/week/${esc(w.key)}">${esc(w.label.replace('Week ', 'Wk '))}</a></th>`).join('')}
              <th>Total</th></tr></thead>
            <tbody>
              ${players.map((p) => `<tr class="${p.id === state.me?.id ? 'me' : ''}">
                <th class="sticky left">${esc(p.name)}${p.isFamily ? ' <span class="dot" title="Family"></span>' : ''}</th>
                ${weeks.map((w) => {
                  const r = p.recs[w.key];
                  if (!r) return '<td class="num muted">—</td>';
                  const top = w.complete && r.w === best[w.key];
                  return `<td class="num ${top ? 'top' : ''}">${r.w}-${r.l}${top ? ' 🏆' : ''}</td>`;
                }).join('')}
                <td class="num strong">${p.w}-${p.l}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
  } catch (e) {
    app.innerHTML = `<div class="banner warn">Couldn't load the history: ${esc(e.message)}</div>`;
  }
}

// ---------- admin ----------

async function renderAdmin() {
  setTab('admin');
  if (!state.adminKey) {
    app.innerHTML = `
      <section class="card narrow">
        <h2>Mick's admin</h2>
        <p class="muted">Approve new players, mark family, and fix mistakes.</p>
        <form id="admin-login">
          <label>Admin password <input type="password" name="key" required autocomplete="current-password"></label>
          <button class="btn primary">Open admin</button>
          <p class="form-error" hidden></p>
        </form>
      </section>`;
    document.getElementById('admin-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      state.adminKey = new FormData(e.target).get('key');
      try {
        await api('/admin/check', { admin: true });
        saveSession('mp_admin', state.adminKey);
        renderAdmin();
      } catch (ex) {
        state.adminKey = null;
        const err = e.target.querySelector('.form-error');
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
    return;
  }

  try {
    const [{ users }, subs] = await Promise.all([api('/admin/users', { admin: true }), api(`/admin/submissions${adminWeek ? `?week=${encodeURIComponent(adminWeek)}` : ''}`, { admin: true })]);
    setHeader(subs.current);
    const pending = users.filter((u) => u.status === 'pending');
    const others = users.filter((u) => u.status !== 'pending');
    app.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>Waiting for approval (${pending.length})</h2>
          <button class="btn ghost small-btn" data-admin="logout">Lock admin</button></div>
        ${pending.length ? `<ul class="admin-list">${pending.map((u) => `
          <li>
            <div><strong>${esc(u.name)}</strong><span class="muted small"> · signed up ${shortFmt.format(new Date(u.created_at))} · ${u.weeks} week${u.weeks === 1 ? '' : 's'} picked</span></div>
            <div class="row-actions">
              <label class="check-label"><input type="checkbox" data-family="${u.id}"> Family</label>
              <button class="btn primary small-btn" data-approve="${u.id}">Approve</button>
              <button class="btn ghost small-btn" data-reject="${u.id}">Reject</button>
            </div>
          </li>`).join('')}</ul>` : '<p class="muted">Nobody is waiting. 🎉</p>'}
      </section>

      <section class="card">
        <h2>Everyone</h2>
        <div class="table-scroll"><table class="board admin-table">
          <thead><tr><th class="left">Name</th><th>Status</th><th>Family</th><th>Weeks</th><th></th></tr></thead>
          <tbody>${others.map((u) => `<tr>
            <td class="left name">${esc(u.name)}</td>
            <td><span class="chip ${u.status === 'approved' ? 'win' : 'loss'}">${esc(u.status)}</span></td>
            <td><input type="checkbox" aria-label="Family" data-toggle-family="${u.id}" ${u.isFamily ? 'checked' : ''}></td>
            <td class="num">${u.weeks}</td>
            <td class="row-actions">
              <button class="btn ghost small-btn" data-rename="${u.id}" data-name="${esc(u.name)}">Rename</button>
              <button class="btn ghost small-btn" data-pin="${u.id}" data-name="${esc(u.name)}">Reset PIN</button>
              ${u.status === 'rejected' ? `<button class="btn ghost small-btn" data-approve="${u.id}">Approve</button>` : ''}
              <button class="btn danger small-btn" data-delete="${u.id}" data-name="${esc(u.name)}">Delete</button>
            </td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Submissions</h2>
          <select class="select" id="admin-week">${(subs.weeks.length ? subs.weeks : [{ key: subs.current.key, label: subs.current.label }]).map((w) => `<option value="${esc(w.key)}" ${w.key === subs.week ? 'selected' : ''}>${esc(w.label)} (${esc(w.key.slice(0, 4))})</option>`).join('')}</select>
        </div>
        ${subs.submissions.length ? `<ul class="admin-list">${subs.submissions.map((s) => `
          <li>
            <div><strong>${esc(s.name)}</strong> <span class="muted small">${s.status !== 'approved' ? `(${esc(s.status)}) · ` : ''}submitted ${shortFmt.format(new Date(s.submitted_at))}${s.updated_at !== s.submitted_at ? `, changed ${shortFmt.format(new Date(s.updated_at))}` : ''}</span></div>
            <button class="btn danger small-btn" data-remove-sub="${s.user_id}" data-name="${esc(s.name)}">Remove picks</button>
          </li>`).join('')}</ul>` : '<p class="muted">No submissions for this week.</p>'}
      </section>`;
    bindAdmin(subs.week);
  } catch (e) {
    if (e.status === 401) {
      state.adminKey = null;
      saveSession('mp_admin', null);
      return renderAdmin();
    }
    app.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
  }
}

let adminWeek = null;

function bindAdmin(weekKey) {
  const run = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      renderAdmin();
    } catch (e) {
      toast(e.message, 'warn');
    }
  };
  const on = (sel, fn) => app.querySelectorAll(sel).forEach((el) => el.addEventListener(el.type === 'checkbox' ? 'change' : 'click', () => fn(el)));
  const update = (id, body) => api(`/admin/users/${id}`, { method: 'POST', body, admin: true });

  on('[data-admin=logout]', () => {
    state.adminKey = null;
    saveSession('mp_admin', null);
    renderAdmin();
  });
  on('[data-approve]', (el) => {
    const fam = app.querySelector(`[data-family="${el.dataset.approve}"]`);
    run(() => update(el.dataset.approve, { status: 'approved', ...(fam ? { isFamily: fam.checked } : {}) }), 'Approved!');
  });
  on('[data-reject]', (el) => run(() => update(el.dataset.reject, { status: 'rejected' }), 'Rejected.'));
  on('[data-toggle-family]', (el) => run(() => update(el.dataset.toggleFamily, { isFamily: el.checked }), 'Saved.'));
  on('[data-rename]', (el) => {
    const name = prompt(`New name for ${el.dataset.name}:`, el.dataset.name);
    if (name) run(() => update(el.dataset.rename, { name }), 'Renamed.');
  });
  on('[data-pin]', (el) => {
    const pin = prompt(`New 4-number PIN for ${el.dataset.name}:`);
    if (pin) run(() => update(el.dataset.pin, { pin }), `PIN reset. Let ${el.dataset.name} know their new PIN.`);
  });
  on('[data-delete]', (el) => {
    if (confirm(`Delete ${el.dataset.name} and all of their picks? This can't be undone.`)) {
      run(() => api(`/admin/users/${el.dataset.delete}`, { method: 'DELETE', admin: true }), 'Deleted.');
    }
  });
  on('[data-remove-sub]', (el) => {
    if (confirm(`Remove ${el.dataset.name}'s picks for this week? They can submit again afterward.`)) {
      run(() => api('/admin/submissions/delete', { method: 'POST', body: { userId: Number(el.dataset.removeSub), weekKey }, admin: true }), 'Picks removed.');
    }
  });
  document.getElementById('admin-week')?.addEventListener('change', (e) => {
    adminWeek = e.target.value;
    renderAdmin();
  });
}

// ---------- router ----------

function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'leaderboard') return { name: 'leaderboard', arg: parts[1] };
  if (parts[0] === 'history') return { name: 'history' };
  if (parts[0] === 'admin') return { name: 'admin' };
  if (parts[0] === 'week') return { name: 'picks', arg: parts[1] };
  return { name: 'picks' };
}

function route() {
  clearInterval(state.refreshTimer);
  const r = currentRoute();
  window.scrollTo({ top: 0 });
  if (r.name === 'leaderboard') return renderLeaderboard(r.arg);
  if (r.name === 'history') return renderHistory();
  if (r.name === 'admin') return renderAdmin();
  return renderPicks(r.arg);
}

window.addEventListener('hashchange', route);
route();
