'use strict';

// ---------------------------------------------------------------------------
// Servidor de la Quiniela Familiar (Mundial 2026).
// Sin dependencias externas: usa http + node:sqlite integrados de Node.
// Arranca con:  node --no-warnings server.js   (o  npm start)
// ---------------------------------------------------------------------------

// Silenciar solo el aviso "ExperimentalWarning: SQLite ..." (node:sqlite).
const _emit = process.emit;
process.emit = function (name, data) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' &&
      /SQLite/i.test(String(data.message || ''))) {
    return false;
  }
  return _emit.apply(process, arguments);
};

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { db, getMeta, setMeta } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Versión de los archivos estáticos (cambia en cada despliegue) para romper la
// caché de Cloudflare/navegador. Se inyecta en index.html como ?v=__V__.
const ASSET_VERSION = (() => {
  try {
    const t = ['app.js', 'styles.css', 'index.html'].map((f) => fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs);
    return Math.floor(Math.max(...t)).toString(36);
  } catch (_) { return Date.now().toString(36); }
})();

const PICKS = new Set(['home', 'draw', 'away']);

// --- Utilidades HTTP -------------------------------------------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('body demasiado grande'));
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0')) { res.writeHead(400); res.end('Solicitud inválida'); return; }
  // Evitar path traversal: resolver dentro de PUBLIC_DIR y verificar que no escape.
  const safeRel = rel.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, safeRel);
  const relCheck = path.relative(PUBLIC_DIR, filePath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    res.writeHead(403); res.end('Prohibido'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // Para una SPA, cualquier ruta desconocida devuelve el index.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('No encontrado'); return; }
        sendHtml(res, idx);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') { sendHtml(res, buf); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=600',
    });
    res.end(buf);
  });
}

// El HTML nunca se cachea (así siempre apunta a la última versión de los
// archivos), y se le inyecta la versión actual en ?v=__V__.
function sendHtml(res, buf) {
  const html = buf.toString('utf8').replace(/__V__/g, ASSET_VERSION);
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  res.end(html);
}

// --- Acceso a datos --------------------------------------------------------
const Q = {
  allMatches: db.prepare('SELECT * FROM matches'),
  matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
  allPlayers: db.prepare('SELECT id, name, emoji, created_at FROM players'),
  allPlayersAdmin: db.prepare('SELECT id, name, emoji, token FROM players ORDER BY name COLLATE NOCASE'),
  playerByToken: db.prepare('SELECT id, name, emoji FROM players WHERE token = ?'),
  playerByNameKey: db.prepare('SELECT id FROM players WHERE name_key = ?'),
  allPredictions: db.prepare('SELECT player_id, match_id, pick, home_goals, away_goals FROM predictions'),
  predsByPlayer: db.prepare('SELECT match_id, pick, home_goals, away_goals FROM predictions WHERE player_id = ?'),
  predForPlayerMatch: db.prepare('SELECT id FROM predictions WHERE player_id = ? AND match_id = ?'),
  insertPrediction: db.prepare('INSERT INTO predictions(player_id, match_id, pick, home_goals, away_goals, created_at) VALUES(?,?,?,?,?,?)'),
  insertPlayer: db.prepare('INSERT INTO players(name, name_key, emoji, token, created_at) VALUES(?,?,?,?,?)'),
  insertMatch: db.prepare(`INSERT INTO matches(home, away, home_emoji, away_emoji, grp, kickoff, venue, sort_key, created_at)
                           VALUES(?,?,?,?,?,?,?,?,?)`),
  deleteMatch: db.prepare('DELETE FROM matches WHERE id = ?'),
  deletePredsByMatch: db.prepare('DELETE FROM predictions WHERE match_id = ?'),
  deletePlayer: db.prepare('DELETE FROM players WHERE id = ?'),
  deletePredsByPlayer: db.prepare('DELETE FROM predictions WHERE player_id = ?'),
  setScore: db.prepare('UPDATE matches SET home_score = ?, away_score = ?, result = ? WHERE id = ?'),
  setClosed: db.prepare('UPDATE matches SET closed = ? WHERE id = ?'),
  setProps: db.prepare('UPDATE matches SET props_result = ? WHERE id = ?'),
  setCornerLine: db.prepare('UPDATE matches SET corner_line = ? WHERE id = ?'),
  allPropPredictions: db.prepare('SELECT player_id, match_id, prop_key, value FROM prop_predictions'),
  propPredsByPlayer: db.prepare('SELECT match_id, prop_key, value FROM prop_predictions WHERE player_id = ?'),
  propPredExists: db.prepare('SELECT 1 FROM prop_predictions WHERE player_id = ? AND match_id = ? LIMIT 1'),
  insertPropPrediction: db.prepare('INSERT INTO prop_predictions(player_id, match_id, prop_key, value, created_at) VALUES(?,?,?,?,?)'),
  updatePrediction: db.prepare('UPDATE predictions SET pick = ?, home_goals = ?, away_goals = ? WHERE player_id = ? AND match_id = ?'),
  deletePropsForPlayerMatch: db.prepare('DELETE FROM prop_predictions WHERE player_id = ? AND match_id = ?'),
  upsertPropPrediction: db.prepare('INSERT INTO prop_predictions(player_id, match_id, prop_key, value, created_at) VALUES(?,?,?,?,?) ON CONFLICT(player_id, match_id, prop_key) DO UPDATE SET value = excluded.value'),
  propsByPlayerMatch: db.prepare('SELECT prop_key, value FROM prop_predictions WHERE player_id = ? AND match_id = ?'),
  playerExists: db.prepare('SELECT 1 FROM players WHERE id = ?'),
  koTeamsByPhase: db.prepare('SELECT team, advanced FROM ko_teams WHERE phase = ? ORDER BY team'),
  upsertKoTeam: db.prepare('INSERT INTO ko_teams(phase, team, advanced) VALUES(?,?,?) ON CONFLICT(phase, team) DO UPDATE SET advanced = excluded.advanced'),
  koDrawByPhase: db.prepare('SELECT player_id, team FROM ko_draw WHERE phase = ?'),
  insertKoDraw: db.prepare('INSERT OR IGNORE INTO ko_draw(phase, player_id, team) VALUES(?,?,?)'),
};

// Fase final (eliminatorias): 3 fases, cada una su propio ganador.
// Cada jugador recibe "pick" equipos al azar (mismo número para todos, se
// pueden repetir entre jugadores). +1 por cada equipo suyo que avanza.
const KO_PHASES = [
  { key: 'r32', label: '16vos de final', teams: 32, pick: 6 },
  { key: 'r16', label: 'Octavos', teams: 16, pick: 3 },
  { key: 'qf', label: 'Cuartos', teams: 8, pick: 2 },
];
const KO_BY_KEY = new Map(KO_PHASES.map((p) => [p.key, p]));

// Sorteo automático de una fase (una sola vez, cuando ya están todos los equipos).
function maybeDrawPhase(phaseKey) {
  const phase = KO_BY_KEY.get(phaseKey);
  if (!phase) return;
  if (getMeta('ko_drawn_' + phaseKey) === '1') return;
  const teams = Q.koTeamsByPhase.all(phaseKey).map((t) => t.team);
  if (teams.length < phase.teams) return; // aún faltan equipos
  const players = db.prepare('SELECT id FROM players').all();
  if (!players.length) return;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const p of players) {
      const sh = teams.slice();
      for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = sh[i]; sh[i] = sh[j]; sh[j] = t; }
      for (const team of sh.slice(0, phase.pick)) Q.insertKoDraw.run(phaseKey, p.id, team);
    }
    setMeta('ko_drawn_' + phaseKey, '1');
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
}

// Extras "seguros" (absolutos): darlos correctos NO le quita el punto a nadie.
const SAFE_PROPS = ['first_goal', 'odd_even', 'first_half_goal', 'first_card', 'red_card'];

// Puntos: marcador exacto = 3, acertar solo el resultado (1X2) = 1.
const PTS_EXACT = 3;
const PTS_OUTCOME = 1;

// La quiniela se divide en 2 rondas. Ronda 1: hasta el 21 jun (incl. Nueva
// Zelanda vs Egipto). Ronda 2: del 22 jun en adelante (desde Argentina vs
// Austria). Cada ronda cuenta SOLO sus partidos (los puntos reinician).
const ROUND_BOUNDARY = Date.parse('2026-06-22T00:00:00-04:00');

// Los "extras" (props) aplican solo a partidos DESPUÉS de Argentina vs Austria
// (ese ya empezó). Cada extra acertado = 1 punto.
const PROPS_BOUNDARY = Date.parse('2026-06-22T13:00:00-04:00');
function hasProps(m) { return Date.parse(m.kickoff) > PROPS_BOUNDARY; }

const PROPS = [
  { key: 'first_goal', label: '¿Quién mete el primer gol?', type: 'team3' },
  { key: 'odd_even', label: 'Total de goles: ¿par o impar?', type: 'choice', options: ['par', 'impar'] },
  { key: 'first_half_goal', label: '¿Gol en el 1er tiempo?', type: 'choice', options: ['si', 'no'] },
  { key: 'offsides', label: '¿Cuántos offsides en total?', type: 'number' },
  { key: 'corners', label: '¿Cuántos córners en total?', type: 'number' },
  { key: 'fouls', label: '¿Cuántas faltas en total?', type: 'number' },
  { key: 'first_card', label: '¿Quién recibe la 1ª tarjeta?', type: 'team3' },
  { key: 'red_card', label: '¿Habrá tarjeta roja?', type: 'choice', options: ['si', 'no'] },
];
const PROP_BY_KEY = new Map(PROPS.map((p) => [p.key, p]));
// Props numéricos: gana el MÁS CERCANO. Cada uno mapea a un campo de props_result.
const CLOSEST = { offsides: 'offsides', corners: 'corners_total', fouls: 'fouls_total' };

// Valida (y normaliza) el valor que manda un jugador para un prop.
function validPropValue(prop, value) {
  if (prop.type === 'team3') return ['home', 'away', 'none'].includes(value) ? value : null;
  if (prop.type === 'choice') return prop.options.includes(value) ? value : null;
  if (prop.type === 'number') { const n = Number(value); return Number.isInteger(n) && n >= 0 && n <= 99 ? String(n) : null; }
  return null;
}

// ¿El prop quedó correcto? (los de elección; los numéricos van por "más cercano").
function propIsCorrect(propKey, value, res) {
  if (res == null) return false;
  switch (propKey) {
    case 'first_goal': return value === res.first_goal;
    case 'odd_even': return value === res.odd_even;
    case 'first_half_goal': return value === res.first_half_goal;
    case 'first_card': return value === res.first_card;
    case 'red_card': return value === res.red_card;
    default: return false;
  }
}

function outcomeFromScore(h, a) {
  return h > a ? 'home' : h < a ? 'away' : 'draw';
}
function validGoals(n) {
  return Number.isInteger(n) && n >= 0 && n <= 99;
}

function isLocked(match, nowMs) {
  if (match.result !== null && match.result !== undefined) return { locked: true, reason: 'resultado' };
  if (match.closed) return { locked: true, reason: 'cerrado' };
  // El cierre por hora de inicio es permanente: un partido que ya empezó no
  // se puede reabrir para pronosticar (solo editando su hora se cambiaría).
  if (Date.parse(match.kickoff) <= nowMs) return { locked: true, reason: 'inicio' };
  return { locked: false, reason: null };
}

function buildState(token) {
  const nowMs = Date.now();
  const matches = Q.allMatches.all();
  const players = Q.allPlayers.all();
  const preds = Q.allPredictions.all();

  const playerById = new Map(players.map((p) => [p.id, p]));

  // Predicciones por partido (para revelar y para contar).
  const predsByMatch = new Map();
  for (const pr of preds) {
    if (!predsByMatch.has(pr.match_id)) predsByMatch.set(pr.match_id, []);
    predsByMatch.get(pr.match_id).push(pr);
  }

  // Tabla por rondas. Puntos: marcador exacto = 3, solo el resultado (1X2) = 1.
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const roundOf = (m) => (Date.parse(m.kickoff) < ROUND_BOUNDARY ? 1 : 2);
  const mkTally = () => {
    const t = new Map();
    for (const p of players) t.set(p.id, { id: p.id, name: p.name, emoji: p.emoji, puntos: 0, exactos: 0, aciertos: 0, extras: 0, jugados: 0, total: 0 });
    return t;
  };
  const tAll = mkTally(), t1 = mkTally(), t2 = mkTally();
  for (const pr of preds) {
    const m = matchById.get(pr.match_id);
    if (!m) continue;
    const graded = m.result && m.home_score != null && m.away_score != null;
    for (const T of [tAll, roundOf(m) === 1 ? t1 : t2]) {
      const t = T.get(pr.player_id);
      if (!t) continue;
      t.total += 1;
      if (graded) {
        t.jugados += 1;
        if (pr.home_goals === m.home_score && pr.away_goals === m.away_score) { t.puntos += PTS_EXACT; t.exactos += 1; t.aciertos += 1; }
        else if (pr.pick === m.result) { t.puntos += PTS_OUTCOME; t.aciertos += 1; }
      }
    }
  }

  // Puntos de los EXTRAS (props): cada acierto +1. Offsides = "el más cercano".
  const propPreds = Q.allPropPredictions.all();
  const resByMatch = new Map();
  for (const m of matches) {
    if (m.props_result) { try { resByMatch.set(m.id, JSON.parse(m.props_result)); } catch (_) {} }
  }
  // Props numéricos (offsides, córners, faltas): gana el MÁS CERCANO por partido.
  const closestWinners = new Map(); // `${matchId}:${propKey}` -> Set(player_id)
  const numByMatchKey = new Map();
  for (const pp of propPreds) {
    if (!CLOSEST[pp.prop_key]) continue;
    const kk = pp.match_id + ':' + pp.prop_key;
    if (!numByMatchKey.has(kk)) numByMatchKey.set(kk, []);
    numByMatchKey.get(kk).push(pp);
  }
  for (const [kk, list] of numByMatchKey) {
    const sep = kk.lastIndexOf(':');
    const mid = Number(kk.slice(0, sep)), key = kk.slice(sep + 1);
    const res = resByMatch.get(mid);
    const actual = res ? res[CLOSEST[key]] : null;
    if (actual == null) continue;
    let best = Infinity;
    for (const pp of list) best = Math.min(best, Math.abs(Number(pp.value) - actual));
    const winners = new Set();
    for (const pp of list) if (Math.abs(Number(pp.value) - actual) === best) winners.add(pp.player_id);
    closestWinners.set(kk, winners);
  }
  const propWinnersByMatch = new Map(); // matchId -> { propKey: [{name, emoji, value}] }
  for (const pp of propPreds) {
    const m = matchById.get(pp.match_id);
    if (!m) continue;
    const res = resByMatch.get(pp.match_id);
    if (!res) continue;
    let ok;
    if (CLOSEST[pp.prop_key]) {
      const w = closestWinners.get(pp.match_id + ':' + pp.prop_key);
      ok = !!(w && w.has(pp.player_id));
    } else ok = propIsCorrect(pp.prop_key, pp.value, res);
    if (ok) {
      for (const T of [tAll, roundOf(m) === 1 ? t1 : t2]) {
        const t = T.get(pp.player_id);
        if (t) { t.puntos += 1; t.extras += 1; }
      }
      const pl = playerById.get(pp.player_id);
      if (!propWinnersByMatch.has(pp.match_id)) propWinnersByMatch.set(pp.match_id, {});
      const byKey = propWinnersByMatch.get(pp.match_id);
      (byKey[pp.prop_key] || (byKey[pp.prop_key] = [])).push({ name: pl ? pl.name : '?', emoji: pl ? pl.emoji : '🙂', value: pp.value });
    }
  }
  const sortStandings = (T) => {
    const s = [...T.values()].sort((a, b) => b.puntos - a.puntos || b.exactos - a.exactos || b.jugados - a.jugados || a.name.localeCompare(b.name, 'es'));
    s.forEach((x, i) => { x.rank = i + 1; });
    return s;
  };
  const standings = sortStandings(tAll);
  // ¿Cuántos partidos hay/jugados por ronda? (para saber si una ronda terminó)
  const roundMeta = { 1: { total: 0, played: 0 }, 2: { total: 0, played: 0 } };
  for (const m of matches) {
    const rm = roundMeta[roundOf(m)];
    rm.total += 1;
    if (m.result && m.home_score != null) rm.played += 1;
  }
  const rounds = [
    { key: 2, name: '2ª ronda', range: '22 al 27 jun', finished: roundMeta[2].total > 0 && roundMeta[2].played === roundMeta[2].total, standings: sortStandings(t2) },
    { key: 1, name: '1ª ronda', range: '17 al 21 jun', finished: roundMeta[1].total > 0 && roundMeta[1].played === roundMeta[1].total, standings: sortStandings(t1) },
  ];

  // Vista de partidos.
  const sorted = matches.slice().sort(
    (a, b) => (Date.parse(a.kickoff) - Date.parse(b.kickoff)) || (a.id - b.id)
  );
  const matchViews = sorted.map((m) => {
    const lock = isLocked(m, nowMs);
    const list = predsByMatch.get(m.id) || [];
    const view = {
      id: m.id,
      home: m.home, away: m.away,
      home_emoji: m.home_emoji, away_emoji: m.away_emoji,
      grp: m.grp, kickoff: m.kickoff, venue: m.venue,
      round: roundOf(m),
      has_props: hasProps(m),
      corner_line: m.corner_line == null ? 9.5 : m.corner_line,
      props_result: resByMatch.get(m.id) || null,
      prop_winners: propWinnersByMatch.get(m.id) || null,
      result: m.result || null,
      home_score: m.home_score == null ? null : m.home_score,
      away_score: m.away_score == null ? null : m.away_score,
      closed: !!m.closed,
      locked: lock.locked,
      lock_reason: lock.reason,
      // El desglose por opción (counts) NO se revela mientras el partido esté
      // abierto, para no influir el voto (pronóstico ciego). total_picks es
      // solo el total y sí se muestra.
      counts: { home: 0, draw: 0, away: 0 },
      total_picks: list.length,
      // QUIÉN ya pronosticó (solo nombres, NO su elección) — para ver a quién
      // le falta antes de que empiece el partido.
      predicted_by: list.map((pr) => {
        const pl = playerById.get(pr.player_id);
        return { id: pr.player_id, name: pl ? pl.name : '?', emoji: pl ? pl.emoji : '🙂' };
      }),
    };
    // Revelar el desglose y quién eligió qué solo cuando el partido ya cerró.
    if (lock.locked) {
      const counts = { home: 0, draw: 0, away: 0 };
      for (const pr of list) counts[pr.pick] = (counts[pr.pick] || 0) + 1;
      view.counts = counts;
      const graded = m.result && m.home_score != null && m.away_score != null;
      view.picks = list.map((pr) => {
        const pl = playerById.get(pr.player_id);
        const exact = graded && pr.home_goals === m.home_score && pr.away_goals === m.away_score;
        return {
          name: pl ? pl.name : '?',
          emoji: pl ? pl.emoji : '🙂',
          pick: pr.pick,
          home_goals: pr.home_goals,
          away_goals: pr.away_goals,
          correct: graded ? pr.pick === m.result : null,
          exact,
        };
      }).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    }
    return view;
  });

  // Jugador actual (por token).
  let me = null;
  if (token) {
    const p = Q.playerByToken.get(token);
    if (p) {
      const myPreds = Q.predsByPlayer.all(p.id);
      const map = {};
      for (const pr of myPreds) map[pr.match_id] = { pick: pr.pick, home_goals: pr.home_goals, away_goals: pr.away_goals };
      const propMap = {};
      for (const pr of Q.propPredsByPlayer.all(p.id)) { (propMap[pr.match_id] || (propMap[pr.match_id] = {}))[pr.prop_key] = pr.value; }
      me = { id: p.id, name: p.name, emoji: p.emoji, predictions: map, props: propMap };
    }
  }

  // Fase final (eliminatorias). El sorteo solo se REVELA pasada su hora.
  const knockout = { phases: [] };
  for (const phase of KO_PHASES) {
    const teamRows = Q.koTeamsByPhase.all(phase.key);
    if (!teamRows.length) continue;
    const reveal_at = getMeta('ko_reveal_' + phase.key);
    const revealed = reveal_at ? nowMs >= Date.parse(reveal_at) : false;
    const drawn = getMeta('ko_drawn_' + phase.key) === '1';
    const ph = { key: phase.key, label: phase.label, pick: phase.pick, reveal_at: reveal_at || null, revealed, drawn, teams_count: teamRows.length };
    if (revealed && drawn) {
      const advByTeam = new Map(teamRows.map((t) => [t.team, t.advanced]));
      const byPlayer = new Map();
      for (const d of Q.koDrawByPhase.all(phase.key)) {
        if (!byPlayer.has(d.player_id)) byPlayer.set(d.player_id, []);
        byPlayer.get(d.player_id).push({ team: d.team, advanced: advByTeam.has(d.team) ? advByTeam.get(d.team) : null });
      }
      const standings = [], assignments = [];
      for (const p of players) {
        const ts = byPlayer.get(p.id) || [];
        standings.push({ id: p.id, name: p.name, emoji: p.emoji, puntos: ts.filter((t) => t.advanced === 1).length, total: ts.length });
        assignments.push({ id: p.id, name: p.name, emoji: p.emoji, teams: ts });
      }
      standings.sort((a, b) => b.puntos - a.puntos || a.name.localeCompare(b.name, 'es'));
      standings.forEach((s, i) => { s.rank = i + 1; });
      ph.standings = standings;
      ph.assignments = assignments;
      ph.decided = teamRows.every((t) => t.advanced != null);
      if (me) ph.my_teams = byPlayer.get(me.id) || [];
    }
    knockout.phases.push(ph);
  }

  return {
    now: new Date(nowMs).toISOString(),
    title: getMeta('title'),
    matches: matchViews,
    standings,
    rounds,
    prop_defs: PROPS,
    knockout,
    players_count: players.length,
    me,
  };
}

// --- Autorización ----------------------------------------------------------
function isAdmin(req) {
  const pin = req.headers['x-admin-pin'];
  if (!pin) return false;
  if (String(pin) === String(getMeta('admin_pin'))) return true;
  // El PIN de la variable de entorno siempre vale (lo usa el actualizador
  // automático), aunque cambies el PIN visible en la app.
  if (process.env.ADMIN_PIN && String(pin) === String(process.env.ADMIN_PIN)) return true;
  return false;
}

// --- Manejadores de API ----------------------------------------------------
async function handleApi(req, res, pathname) {
  const method = req.method;
  const token = req.headers['x-player-token'] || null;

  // ----- Estado global -----
  if (pathname === '/api/state' && method === 'GET') {
    return sendJSON(res, 200, buildState(token));
  }

  // ----- Registrar jugador -----
  if (pathname === '/api/players' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const emoji = String(body.emoji || '🙂').trim() || '🙂';
    if (name.length < 2 || name.length > 24) {
      return sendJSON(res, 400, { error: 'El nombre debe tener entre 2 y 24 letras.' });
    }
    const nameKey = name.toLowerCase();
    if (Q.playerByNameKey.get(nameKey)) {
      return sendJSON(res, 409, { error: 'Ya existe un jugador con ese nombre. Usa otro.' });
    }
    const newToken = crypto.randomUUID();
    const info = Q.insertPlayer.run(name, nameKey, emoji.slice(0, 8), newToken, new Date().toISOString());
    return sendJSON(res, 201, { id: Number(info.lastInsertRowid), name, emoji, token: newToken });
  }

  // ----- Recuperar sesión con código (token) -----
  if (pathname === '/api/me' && method === 'GET') {
    if (!token) return sendJSON(res, 401, { error: 'Sin código.' });
    const p = Q.playerByToken.get(token);
    if (!p) return sendJSON(res, 404, { error: 'Código no válido.' });
    return sendJSON(res, 200, { id: p.id, name: p.name, emoji: p.emoji, token });
  }

  // ----- Hacer una predicción (no se puede modificar después) -----
  if (pathname === '/api/predictions' && method === 'POST') {
    if (!token) return sendJSON(res, 401, { error: 'Primero crea tu jugador.' });
    const player = Q.playerByToken.get(token);
    if (!player) return sendJSON(res, 401, { error: 'Jugador no válido. Vuelve a entrar.' });
    const body = await readBody(req);
    const matchId = Number(body.match_id);
    const hg = Number(body.home_goals);
    const ag = Number(body.away_goals);
    if (!validGoals(hg) || !validGoals(ag)) {
      return sendJSON(res, 400, { error: 'Marcador no válido. Usa números de 0 a 99.' });
    }
    // El ganador se deriva del marcador, así nunca queda inconsistente.
    const pick = outcomeFromScore(hg, ag);
    if (body.pick && body.pick !== pick) {
      return sendJSON(res, 400, { error: 'El marcador no coincide con el ganador elegido.' });
    }
    const match = Q.matchById.get(matchId);
    if (!match) return sendJSON(res, 404, { error: 'Partido no encontrado.' });
    if (isLocked(match, Date.now()).locked) {
      return sendJSON(res, 409, { error: 'Este partido ya empezó, ya no se puede cambiar.' });
    }
    // Se puede CAMBIAR la predicción mientras el partido no empiece.
    const exists = !!Q.predForPlayerMatch.get(player.id, matchId);
    // Extras (props): obligatorios si el partido los ofrece (ronda 2, tras Argentina).
    const propRows = [];
    if (hasProps(match)) {
      const inProps = body.props || {};
      for (const prop of PROPS) {
        const v = validPropValue(prop, inProps[prop.key]);
        if (v === null) return sendJSON(res, 400, { error: `Falta o es inválido el extra: ${prop.label}` });
        propRows.push([prop.key, v]);
      }
    }
    const nowIso = new Date().toISOString();
    try {
      db.exec('BEGIN IMMEDIATE');
      if (exists) {
        Q.updatePrediction.run(pick, hg, ag, player.id, matchId);
        Q.deletePropsForPlayerMatch.run(player.id, matchId);
      } else {
        Q.insertPrediction.run(player.id, matchId, pick, hg, ag, nowIso);
      }
      for (const [k, v] of propRows) Q.insertPropPrediction.run(player.id, matchId, k, v, nowIso);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      return sendJSON(res, 500, { error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    return sendJSON(res, 201, { ok: true });
  }

  // ===== Endpoints de administrador =====
  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: 'PIN de administrador incorrecto.' });

    if (pathname === '/api/admin/verify' && method === 'POST') {
      return sendJSON(res, 200, { ok: true });
    }

    // Lista de jugadores CON su código (token), para que el admin pueda
    // ayudar a alguien que lo olvidó. Solo accesible con el PIN.
    if (pathname === '/api/admin/players' && method === 'GET') {
      return sendJSON(res, 200, { players: Q.allPlayersAdmin.all() });
    }

    // Ayudita discreta: pone correctos los extras "seguros" de un jugador en un
    // partido ya jugado. No afecta el puntaje de nadie más.
    if (pathname === '/api/admin/help' && method === 'POST') {
      const b = await readBody(req);
      const pid = Number(b.player_id), mid = Number(b.match_id);
      if (!Q.playerExists.get(pid)) return sendJSON(res, 404, { error: 'Jugador no encontrado.' });
      const m = Q.matchById.get(mid);
      if (!m || !m.props_result) return sendJSON(res, 400, { error: 'Ese partido no tiene resultado de extras todavía.' });
      let resObj; try { resObj = JSON.parse(m.props_result); } catch (_) { resObj = null; }
      if (!resObj) return sendJSON(res, 400, { error: 'Resultado de extras inválido.' });
      const cur = {};
      for (const pp of Q.propsByPlayerMatch.all(pid, mid)) cur[pp.prop_key] = pp.value;
      const now = new Date().toISOString();
      let gained = 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const key of SAFE_PROPS) {
          if (resObj[key] == null) continue;
          if (String(cur[key]) !== String(resObj[key])) gained++;
          Q.upsertPropPrediction.run(pid, mid, key, String(resObj[key]), now);
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} return sendJSON(res, 500, { error: 'No se pudo aplicar.' }); }
      return sendJSON(res, 200, { ok: true, gained });
    }

    // Datos de eliminatorias desde el actualizador (equipos + quién avanzó).
    if (pathname === '/api/admin/ko' && method === 'POST') {
      const b = await readBody(req);
      const phaseKey = String(b.phase || '');
      if (!KO_BY_KEY.has(phaseKey)) return sendJSON(res, 400, { error: 'Fase no válida.' });
      const teams = Array.isArray(b.teams) ? b.teams : [];
      for (const t of teams) {
        if (!t || !t.team) continue;
        const adv = t.advanced == null ? null : (t.advanced ? 1 : 0);
        Q.upsertKoTeam.run(phaseKey, String(t.team), adv);
      }
      if (b.first_kickoff && !isNaN(Date.parse(b.first_kickoff))) {
        setMeta('ko_reveal_' + phaseKey, new Date(Date.parse(b.first_kickoff) - 60 * 60 * 1000).toISOString());
      }
      maybeDrawPhase(phaseKey);
      return sendJSON(res, 200, { ok: true });
    }

    // Crear partido
    if (pathname === '/api/admin/matches' && method === 'POST') {
      const b = await readBody(req);
      const home = String(b.home || '').trim();
      const away = String(b.away || '').trim();
      const kickoff = String(b.kickoff || '').trim();
      if (!home || !away) return sendJSON(res, 400, { error: 'Faltan los equipos.' });
      if (!kickoff || isNaN(Date.parse(kickoff))) return sendJSON(res, 400, { error: 'Fecha/hora no válida.' });
      const info = Q.insertMatch.run(
        home, away,
        String(b.home_emoji || '⚽').slice(0, 8), String(b.away_emoji || '⚽').slice(0, 8),
        String(b.grp || '').slice(0, 4) || null,
        new Date(kickoff).toISOString(),
        String(b.venue || '').slice(0, 60) || null,
        new Date(kickoff).toISOString(),
        new Date().toISOString()
      );
      return sendJSON(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
    }

    // Acciones sobre un partido concreto
    const mMatch = pathname.match(/^\/api\/admin\/matches\/(\d+)(\/result|\/close|\/props)?$/);
    if (mMatch) {
      const id = Number(mMatch[1]);
      const sub = mMatch[2];
      const match = Q.matchById.get(id);
      if (!match) return sendJSON(res, 404, { error: 'Partido no encontrado.' });

      if (!sub && method === 'PATCH') {
        const b = await readBody(req);
        const fields = [];
        const vals = [];
        const setIf = (key, val) => { fields.push(`${key} = ?`); vals.push(val); };
        if (b.home !== undefined) setIf('home', String(b.home).trim());
        if (b.away !== undefined) setIf('away', String(b.away).trim());
        if (b.home_emoji !== undefined) setIf('home_emoji', String(b.home_emoji).slice(0, 8) || '⚽');
        if (b.away_emoji !== undefined) setIf('away_emoji', String(b.away_emoji).slice(0, 8) || '⚽');
        if (b.grp !== undefined) setIf('grp', String(b.grp).slice(0, 4) || null);
        if (b.venue !== undefined) setIf('venue', String(b.venue).slice(0, 60) || null);
        if (b.corner_line !== undefined) { const cl = Number(b.corner_line); if (!isNaN(cl) && cl >= 0 && cl <= 30) setIf('corner_line', cl); }
        if (b.kickoff !== undefined) {
          if (isNaN(Date.parse(b.kickoff))) return sendJSON(res, 400, { error: 'Fecha/hora no válida.' });
          setIf('kickoff', new Date(b.kickoff).toISOString());
        }
        if (!fields.length) return sendJSON(res, 400, { error: 'Nada que actualizar.' });
        db.prepare(`UPDATE matches SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id);
        return sendJSON(res, 200, { ok: true });
      }

      if (sub === '/result' && method === 'POST') {
        const b = await readBody(req);
        // Limpiar (marcar "sin jugar")
        if (b.clear === true || (b.home_score == null && b.away_score == null)) {
          Q.setScore.run(null, null, null, id);
          return sendJSON(res, 200, { ok: true });
        }
        const hs = Number(b.home_score);
        const as = Number(b.away_score);
        if (!validGoals(hs) || !validGoals(as)) {
          return sendJSON(res, 400, { error: 'Marcador no válido. Usa números de 0 a 99.' });
        }
        Q.setScore.run(hs, as, outcomeFromScore(hs, as), id);
        return sendJSON(res, 200, { ok: true });
      }

      if (sub === '/close' && method === 'POST') {
        const b = await readBody(req);
        Q.setClosed.run(b.closed ? 1 : 0, id);
        return sendJSON(res, 200, { ok: true });
      }

      // Resultado de los EXTRAS (props). Lo usa el actualizador automático o el admin.
      if (sub === '/props' && method === 'POST') {
        const b = await readBody(req);
        if (b.props_result == null) { Q.setProps.run(null, id); return sendJSON(res, 200, { ok: true }); }
        const r = b.props_result;
        if (typeof r !== 'object') return sendJSON(res, 400, { error: 'props_result inválido.' });
        const clean = {};
        if (['home', 'away', 'none'].includes(r.first_goal)) clean.first_goal = r.first_goal;
        if (['par', 'impar'].includes(r.odd_even)) clean.odd_even = r.odd_even;
        if (['si', 'no'].includes(r.first_half_goal)) clean.first_half_goal = r.first_half_goal;
        if (Number.isInteger(Number(r.offsides))) clean.offsides = Number(r.offsides);
        if (Number.isInteger(Number(r.corners_total))) clean.corners_total = Number(r.corners_total);
        if (Number.isInteger(Number(r.fouls_total))) clean.fouls_total = Number(r.fouls_total);
        if (['home', 'away', 'none'].includes(r.first_card)) clean.first_card = r.first_card;
        if (['si', 'no'].includes(r.red_card)) clean.red_card = r.red_card;
        Q.setProps.run(JSON.stringify(clean), id);
        return sendJSON(res, 200, { ok: true });
      }

      if (!sub && method === 'DELETE') {
        Q.deletePredsByMatch.run(id);
        Q.deleteMatch.run(id);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // Eliminar jugador
    const mPlayer = pathname.match(/^\/api\/admin\/players\/(\d+)$/);
    if (mPlayer && method === 'DELETE') {
      const id = Number(mPlayer[1]);
      Q.deletePredsByPlayer.run(id);
      Q.deletePlayer.run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // Configuración (título)
    if (pathname === '/api/admin/settings' && method === 'POST') {
      const b = await readBody(req);
      if (b.title !== undefined && String(b.title).trim()) setMeta('title', String(b.title).trim().slice(0, 60));
      return sendJSON(res, 200, { ok: true });
    }

    // Cambiar PIN
    if (pathname === '/api/admin/pin' && method === 'POST') {
      const b = await readBody(req);
      const np = String(b.new_pin || '').trim();
      if (np.length < 3 || np.length > 12) return sendJSON(res, 400, { error: 'El PIN debe tener de 3 a 12 caracteres.' });
      setMeta('admin_pin', np);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: 'Acción de administrador desconocida.' });
  }

  return sendJSON(res, 404, { error: 'Ruta no encontrada.' });
}

// --- Servidor --------------------------------------------------------------
const server = http.createServer((req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { pathname = req.url; }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      sendJSON(res, 400, { error: err.message || 'Error en la solicitud.' });
    });
    return;
  }
  serveStatic(req, res, pathname);
});

// Si no fijaron PORT a mano, y el 3000 está ocupado, probamos el siguiente
// puerto libre automáticamente (hasta 15 intentos) en vez de fallar.
let currentPort = PORT;
let portTries = process.env.PORT ? 0 : 15;

server.on('listening', () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);
    }
  }
  console.log('\n  ⚽  Quiniela Familiar — Mundial 2026');
  console.log('  ───────────────────────────────────────');
  console.log(`  En esta computadora:  http://localhost:${currentPort}`);
  for (const ip of lan) console.log(`  Desde el celular:     http://${ip}:${currentPort}`);
  console.log(`  PIN de administrador: ${getMeta('admin_pin')}  (cámbialo en el panel)`);
  console.log('  ───────────────────────────────────────\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && portTries > 0) {
    portTries--;
    console.log(`  (El puerto ${currentPort} está ocupado, probando el ${currentPort + 1}…)`);
    currentPort++;
    setTimeout(() => server.listen(currentPort, '0.0.0.0'), 150);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`\n  ⚠️  El puerto ${currentPort} está ocupado y no encontré uno libre.`);
    console.error('     Arranca con otro puerto, por ejemplo:  PORT=8080 npm start\n');
    process.exit(1);
  } else {
    console.error('Error del servidor:', err.message);
    process.exit(1);
  }
});

server.listen(currentPort, '0.0.0.0');
