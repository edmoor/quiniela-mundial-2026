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
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
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
};

// Puntos: marcador exacto = 3, acertar solo el resultado (1X2) = 1.
const PTS_EXACT = 3;
const PTS_OUTCOME = 1;

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

  // Tabla general. Puntos: marcador exacto = 3, solo el resultado (1X2) = 1.
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const tally = new Map();
  for (const p of players) tally.set(p.id, { id: p.id, name: p.name, emoji: p.emoji, puntos: 0, exactos: 0, aciertos: 0, jugados: 0, total: 0 });
  for (const pr of preds) {
    const t = tally.get(pr.player_id);
    if (!t) continue;
    t.total += 1;
    const m = matchById.get(pr.match_id);
    if (m && m.result && m.home_score != null && m.away_score != null) {
      t.jugados += 1;
      if (pr.home_goals === m.home_score && pr.away_goals === m.away_score) {
        t.puntos += PTS_EXACT; t.exactos += 1; t.aciertos += 1;
      } else if (pr.pick === m.result) {
        t.puntos += PTS_OUTCOME; t.aciertos += 1;
      }
    }
  }
  const standings = [...tally.values()].sort(
    (a, b) => b.puntos - a.puntos || b.exactos - a.exactos || b.jugados - a.jugados || a.name.localeCompare(b.name, 'es')
  );
  standings.forEach((s, i) => { s.rank = i + 1; });

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
      me = { id: p.id, name: p.name, emoji: p.emoji, predictions: map };
    }
  }

  return {
    now: new Date(nowMs).toISOString(),
    title: getMeta('title'),
    matches: matchViews,
    standings,
    players_count: players.length,
    me,
  };
}

// --- Autorización ----------------------------------------------------------
function isAdmin(req) {
  const pin = req.headers['x-admin-pin'];
  return pin && String(pin) === String(getMeta('admin_pin'));
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
      return sendJSON(res, 409, { error: 'Este partido ya está cerrado.' });
    }
    if (Q.predForPlayerMatch.get(player.id, matchId)) {
      return sendJSON(res, 409, { error: 'Ya hiciste tu predicción y no se puede cambiar.' });
    }
    try {
      Q.insertPrediction.run(player.id, matchId, pick, hg, ag, new Date().toISOString());
    } catch (e) {
      return sendJSON(res, 409, { error: 'Ya hiciste tu predicción y no se puede cambiar.' });
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
    const mMatch = pathname.match(/^\/api\/admin\/matches\/(\d+)(\/result|\/close)?$/);
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
