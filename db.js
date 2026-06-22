'use strict';

// ---------------------------------------------------------------------------
// Base de datos (SQLite integrado de Node, sin dependencias externas).
// Crea el archivo quiniela.db, el esquema y precarga los 52 partidos del
// Mundial 2026 (del 17 al 27 de junio, desde Portugal vs RD Congo).
// ---------------------------------------------------------------------------

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.QUINIELA_DB || path.join(__dirname, 'quiniela.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    emoji      TEXT NOT NULL DEFAULT '🙂',
    token      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS matches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    home       TEXT NOT NULL,
    away       TEXT NOT NULL,
    home_emoji TEXT NOT NULL DEFAULT '⚽',
    away_emoji TEXT NOT NULL DEFAULT '⚽',
    grp        TEXT,
    kickoff    TEXT NOT NULL,          -- ISO 8601 con zona horaria
    venue      TEXT,
    result     TEXT,                   -- 'home' | 'draw' | 'away' | NULL (derivado del marcador)
    home_score INTEGER,                -- goles reales del local (NULL = sin jugar)
    away_score INTEGER,                -- goles reales del visitante
    corner_line REAL DEFAULT 9.5,      -- línea over/under de córners (editable)
    props_result TEXT,                 -- JSON con el resultado real de los extras
    api_fixture_id INTEGER,            -- id del partido en API-Football (para auto-actualizar)
    closed     INTEGER NOT NULL DEFAULT 0,
    sort_key   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prop_predictions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL,
    match_id   INTEGER NOT NULL,
    prop_key   TEXT NOT NULL,          -- first_goal | odd_even | first_half_goal | offsides | corners_ou | first_card | red_card
    value      TEXT NOT NULL,          -- la elección del jugador (texto o número)
    created_at TEXT NOT NULL,
    UNIQUE(player_id, match_id, prop_key),
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY(match_id)  REFERENCES matches(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL,
    match_id   INTEGER NOT NULL,
    pick       TEXT NOT NULL,          -- 'home' | 'draw' | 'away' (derivado del marcador)
    home_goals INTEGER,                -- goles que pronostica para el local
    away_goals INTEGER,                -- goles que pronostica para el visitante
    created_at TEXT NOT NULL,
    UNIQUE(player_id, match_id),
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY(match_id)  REFERENCES matches(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- Migraciones (agregar columnas nuevas a bases ya existentes) ----------
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}
ensureColumn('matches', 'home_score', 'INTEGER');
ensureColumn('matches', 'away_score', 'INTEGER');
ensureColumn('matches', 'corner_line', 'REAL DEFAULT 9.5');
ensureColumn('matches', 'props_result', 'TEXT');
ensureColumn('matches', 'api_fixture_id', 'INTEGER');
ensureColumn('predictions', 'home_goals', 'INTEGER');
ensureColumn('predictions', 'away_goals', 'INTEGER');

// --- Valores por defecto de configuración --------------------------------
function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

if (getMeta('admin_pin') === null) setMeta('admin_pin', process.env.ADMIN_PIN || '2026');
if (getMeta('title') === null) setMeta('title', 'Quiniela Familiar · Mundial 2026');

// --- Partidos a precargar (calendario real, fuente: Wikipedia por grupo) ---
// home_emoji / away_emoji son banderas; si un teléfono no las dibuja, el
// nombre del equipo siempre se muestra como texto.
// Horarios en ET (hora del Este de EE.UU., -04:00). La familia los verá en
// hora de México (ET − 2 h). Fuentes cruzadas: NBC Sports y Yahoo Sports;
// verificado contra horarios oficiales mexicanos (México vs Corea = 19:00 MX).
const SEED_MATCHES = [
  // 17 jun — Grupos K y L
  ['Portugal', 'RD Congo', '🇵🇹', '🇨🇩', 'K', '2026-06-17T13:00:00-04:00', 'Houston'],
  ['Inglaterra', 'Croacia', '🏴', '🇭🇷', 'L', '2026-06-17T16:00:00-04:00', 'Arlington'],
  ['Ghana', 'Panamá', '🇬🇭', '🇵🇦', 'L', '2026-06-17T19:00:00-04:00', 'Toronto'],
  ['Uzbekistán', 'Colombia', '🇺🇿', '🇨🇴', 'K', '2026-06-17T22:00:00-04:00', 'Ciudad de México'],
  // 18 jun — Grupos A y B
  ['Chequia', 'Sudáfrica', '🇨🇿', '🇿🇦', 'A', '2026-06-18T12:00:00-04:00', 'Atlanta'],
  ['Suiza', 'Bosnia y Herzegovina', '🇨🇭', '🇧🇦', 'B', '2026-06-18T15:00:00-04:00', 'Los Ángeles'],
  ['Canadá', 'Catar', '🇨🇦', '🇶🇦', 'B', '2026-06-18T18:00:00-04:00', 'Vancouver'],
  ['México', 'Corea del Sur', '🇲🇽', '🇰🇷', 'A', '2026-06-18T21:00:00-04:00', 'Guadalajara'],
  // 19 jun — Grupos C y D
  ['Estados Unidos', 'Australia', '🇺🇸', '🇦🇺', 'D', '2026-06-19T15:00:00-04:00', 'Seattle'],
  ['Escocia', 'Marruecos', '🏴', '🇲🇦', 'C', '2026-06-19T18:00:00-04:00', 'Boston'],
  ['Brasil', 'Haití', '🇧🇷', '🇭🇹', 'C', '2026-06-19T20:30:00-04:00', 'Filadelfia'],
  ['Turquía', 'Paraguay', '🇹🇷', '🇵🇾', 'D', '2026-06-20T00:00:00-04:00', 'San Francisco'],
  // 20 jun — Grupos E y F
  ['Países Bajos', 'Suecia', '🇳🇱', '🇸🇪', 'F', '2026-06-20T13:00:00-04:00', 'Houston'],
  ['Alemania', 'Costa de Marfil', '🇩🇪', '🇨🇮', 'E', '2026-06-20T16:00:00-04:00', 'Toronto'],
  ['Ecuador', 'Curazao', '🇪🇨', '🇨🇼', 'E', '2026-06-20T20:00:00-04:00', 'Kansas City'],
  ['Túnez', 'Japón', '🇹🇳', '🇯🇵', 'F', '2026-06-21T00:00:00-04:00', 'Monterrey'],
  // 21 jun — Grupos G y H
  ['España', 'Arabia Saudita', '🇪🇸', '🇸🇦', 'H', '2026-06-21T12:00:00-04:00', 'Atlanta'],
  ['Bélgica', 'Irán', '🇧🇪', '🇮🇷', 'G', '2026-06-21T15:00:00-04:00', 'Los Ángeles'],
  ['Uruguay', 'Cabo Verde', '🇺🇾', '🇨🇻', 'H', '2026-06-21T18:00:00-04:00', 'Miami'],
  ['Nueva Zelanda', 'Egipto', '🇳🇿', '🇪🇬', 'G', '2026-06-21T21:00:00-04:00', 'Vancouver'],
  // 22 jun — Grupos I y J
  ['Argentina', 'Austria', '🇦🇷', '🇦🇹', 'J', '2026-06-22T13:00:00-04:00', 'Dallas'],
  ['Francia', 'Irak', '🇫🇷', '🇮🇶', 'I', '2026-06-22T17:00:00-04:00', 'Filadelfia'],
  ['Noruega', 'Senegal', '🇳🇴', '🇸🇳', 'I', '2026-06-22T20:00:00-04:00', 'Nueva York'],
  ['Jordania', 'Argelia', '🇯🇴', '🇩🇿', 'J', '2026-06-22T23:00:00-04:00', 'San Francisco'],
  // 23 jun — Grupos K y L
  ['Portugal', 'Uzbekistán', '🇵🇹', '🇺🇿', 'K', '2026-06-23T13:00:00-04:00', 'Houston'],
  ['Inglaterra', 'Ghana', '🏴', '🇬🇭', 'L', '2026-06-23T16:00:00-04:00', 'Boston'],
  ['Panamá', 'Croacia', '🇵🇦', '🇭🇷', 'L', '2026-06-23T19:00:00-04:00', 'Toronto'],
  ['Colombia', 'RD Congo', '🇨🇴', '🇨🇩', 'K', '2026-06-23T22:00:00-04:00', 'Guadalajara'],
  // 24 jun — Grupos A, B y C
  ['Suiza', 'Canadá', '🇨🇭', '🇨🇦', 'B', '2026-06-24T15:00:00-04:00', 'Vancouver'],
  ['Bosnia y Herzegovina', 'Catar', '🇧🇦', '🇶🇦', 'B', '2026-06-24T15:00:00-04:00', 'Seattle'],
  ['Escocia', 'Brasil', '🏴', '🇧🇷', 'C', '2026-06-24T18:00:00-04:00', 'Miami'],
  ['Marruecos', 'Haití', '🇲🇦', '🇭🇹', 'C', '2026-06-24T18:00:00-04:00', 'Atlanta'],
  ['Chequia', 'México', '🇨🇿', '🇲🇽', 'A', '2026-06-24T21:00:00-04:00', 'Ciudad de México'],
  ['Sudáfrica', 'Corea del Sur', '🇿🇦', '🇰🇷', 'A', '2026-06-24T21:00:00-04:00', 'Monterrey'],
  // 25 jun — Grupos D, E y F
  ['Curazao', 'Costa de Marfil', '🇨🇼', '🇨🇮', 'E', '2026-06-25T16:00:00-04:00', 'Filadelfia'],
  ['Ecuador', 'Alemania', '🇪🇨', '🇩🇪', 'E', '2026-06-25T16:00:00-04:00', 'Nueva York'],
  ['Japón', 'Suecia', '🇯🇵', '🇸🇪', 'F', '2026-06-25T19:00:00-04:00', 'Dallas'],
  ['Túnez', 'Países Bajos', '🇹🇳', '🇳🇱', 'F', '2026-06-25T19:00:00-04:00', 'Kansas City'],
  ['Turquía', 'Estados Unidos', '🇹🇷', '🇺🇸', 'D', '2026-06-25T22:00:00-04:00', 'Los Ángeles'],
  ['Paraguay', 'Australia', '🇵🇾', '🇦🇺', 'D', '2026-06-25T22:00:00-04:00', 'San Francisco'],
  // 26 jun — Grupos G, H e I
  ['Noruega', 'Francia', '🇳🇴', '🇫🇷', 'I', '2026-06-26T15:00:00-04:00', 'Boston'],
  ['Senegal', 'Irak', '🇸🇳', '🇮🇶', 'I', '2026-06-26T15:00:00-04:00', 'Toronto'],
  ['Cabo Verde', 'Arabia Saudita', '🇨🇻', '🇸🇦', 'H', '2026-06-26T20:00:00-04:00', 'Houston'],
  ['Uruguay', 'España', '🇺🇾', '🇪🇸', 'H', '2026-06-26T20:00:00-04:00', 'Guadalajara'],
  ['Egipto', 'Irán', '🇪🇬', '🇮🇷', 'G', '2026-06-26T23:00:00-04:00', 'Seattle'],
  ['Nueva Zelanda', 'Bélgica', '🇳🇿', '🇧🇪', 'G', '2026-06-26T23:00:00-04:00', 'Vancouver'],
  // 27 jun — Grupos J, K y L
  ['Panamá', 'Inglaterra', '🇵🇦', '🏴', 'L', '2026-06-27T17:00:00-04:00', 'Nueva York'],
  ['Croacia', 'Ghana', '🇭🇷', '🇬🇭', 'L', '2026-06-27T17:00:00-04:00', 'Filadelfia'],
  ['Colombia', 'Portugal', '🇨🇴', '🇵🇹', 'K', '2026-06-27T19:30:00-04:00', 'Miami'],
  ['RD Congo', 'Uzbekistán', '🇨🇩', '🇺🇿', 'K', '2026-06-27T19:30:00-04:00', 'Atlanta'],
  ['Argelia', 'Austria', '🇩🇿', '🇦🇹', 'J', '2026-06-27T22:00:00-04:00', 'Kansas City'],
  ['Jordania', 'Argentina', '🇯🇴', '🇦🇷', 'J', '2026-06-27T22:00:00-04:00', 'Dallas'],
];

// Sembrar solo la PRIMERA vez (no si el admin borró todos los partidos a
// propósito). Usamos una bandera en meta en lugar de "¿tabla vacía?".
if (getMeta('seeded') === null) {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO matches (home, away, home_emoji, away_emoji, grp, kickoff, venue, sort_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let i = 0;
  for (const m of SEED_MATCHES) {
    const [home, away, he, ae, grp, kickoff, venue] = m;
    // sort_key = fecha + índice, para mantener un orden estable aunque dos
    // partidos compartan la misma hora.
    const sortKey = kickoff + '#' + String(i).padStart(4, '0');
    insert.run(home, away, he, ae, grp, kickoff, venue, sortKey, now);
    i++;
  }
  setMeta('seeded', '1');
  console.log(`[db] Precargados ${SEED_MATCHES.length} partidos del Mundial 2026.`);
}

// Corrección de horarios (una sola vez) para bases ya existentes: pone la hora
// correcta de cada partido emparejando por equipos, SIN tocar predicciones.
if (getMeta('times_fixed_v3') === null) {
  const upd = db.prepare('UPDATE matches SET kickoff = ? WHERE home = ? AND away = ?');
  let n = 0;
  for (const m of SEED_MATCHES) n += upd.run(m[5], m[0], m[1]).changes;
  setMeta('times_fixed_v3', '1');
  if (n) console.log(`[db] Horarios corregidos en ${n} partidos.`);
}

module.exports = { db, getMeta, setMeta, DB_PATH };
