'use strict';

/* ===========================================================================
   Actualizador automático de la Quiniela (fuente: API pública de ESPN).
   - Sin API key, sin dependencias: solo fetch (Node 18+).
   - Al terminar cada partido del Mundial 2026, llena marcador + los 7 extras.
   - Habla con tu propio servidor por HTTP (endpoints admin). Corre cada par de
     minutos con un systemd timer. Si ESPN falla, NO rompe nada: simplemente no
     escribe y el admin puede capturar a mano.
   Uso:  QUINIELA_URL=http://localhost:3000 ADMIN_PIN=tuPin node updater.js
   =========================================================================== */

const BASE = (process.env.QUINIELA_URL || 'http://localhost:3000').replace(/\/$/, '');
const PIN = process.env.ADMIN_PIN || '2026';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
const SCOREBOARD_RANGE = process.env.ESPN_RANGE || '20260611-20260719'; // todo el torneo

// Nombres ES (tu quiniela) -> nombres EN (ESPN). Se admiten varios alias.
const ES2EN = {
  'Portugal': ['Portugal'], 'RD Congo': ['Congo DR', 'DR Congo', 'Congo'], 'Uzbekistán': ['Uzbekistan'],
  'Colombia': ['Colombia'], 'Inglaterra': ['England'], 'Croacia': ['Croatia'], 'Ghana': ['Ghana'],
  'Panamá': ['Panama'], 'Chequia': ['Czechia', 'Czech Republic'], 'Sudáfrica': ['South Africa'],
  'México': ['Mexico'], 'Corea del Sur': ['South Korea', 'Korea Republic'], 'Suiza': ['Switzerland'],
  'Bosnia y Herzegovina': ['Bosnia & Herzegovina', 'Bosnia and Herzegovina', 'Bosnia-Herzegovina'],
  'Canadá': ['Canada'], 'Catar': ['Qatar'], 'Escocia': ['Scotland'], 'Marruecos': ['Morocco'],
  'Brasil': ['Brazil'], 'Haití': ['Haiti'], 'Estados Unidos': ['United States', 'USA'], 'Australia': ['Australia'],
  'Turquía': ['Türkiye', 'Turkiye', 'Turkey'], 'Paraguay': ['Paraguay'], 'Alemania': ['Germany'],
  'Costa de Marfil': ["Côte d'Ivoire", 'Ivory Coast', 'Cote dIvoire'], 'Ecuador': ['Ecuador'],
  'Curazao': ['Curaçao', 'Curacao'], 'Países Bajos': ['Netherlands', 'Holland'], 'Suecia': ['Sweden'],
  'Túnez': ['Tunisia'], 'Japón': ['Japan'], 'Bélgica': ['Belgium'], 'Irán': ['Iran', 'IR Iran'],
  'Nueva Zelanda': ['New Zealand'], 'Egipto': ['Egypt'], 'España': ['Spain'], 'Arabia Saudita': ['Saudi Arabia'],
  'Uruguay': ['Uruguay'], 'Cabo Verde': ['Cape Verde', 'Cabo Verde'], 'Francia': ['France'], 'Irak': ['Iraq'],
  'Noruega': ['Norway'], 'Senegal': ['Senegal'], 'Argentina': ['Argentina'], 'Austria': ['Austria'],
  'Jordania': ['Jordan'], 'Argelia': ['Algeria'],
};

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
// Conjunto de claves normalizadas con las que un nombre ES puede aparecer en ESPN.
function enKeys(esName) {
  const al = ES2EN[esName] || [esName];
  return new Set([norm(esName), ...al.map(norm)]);
}
function nameMatches(esName, espnName) {
  return enKeys(esName).has(norm(espnName));
}

// Inglés(ESPN) -> Español, y set de equipos "reales" (para detectar TBD).
const EN2ES = {};
const VALID_TEAMS = new Set();
for (const [es, aliases] of Object.entries(ES2EN)) for (const a of aliases) { EN2ES[norm(a)] = es; VALID_TEAMS.add(norm(a)); }
function toES(en) { return EN2ES[norm(en)] || en; }
function isRealTeam(en) { return VALID_TEAMS.has(norm(en)); }
const SLUG2PHASE = { 'round-of-32': 'r32', 'round-of-16': 'r16', 'quarterfinals': 'qf' };

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log(new Date().toISOString(), ...a); }

// --- Parseo de un summary de ESPN a nuestro esquema, en NUESTRA orientación ---
function resolveFromSummary(match, summary) {
  const comp = summary.header.competitions[0].competitors;
  // Identifica qué competidor de ESPN es NUESTRO local y cuál visitante.
  const espnHome = comp.find((c) => nameMatches(match.home, c.team.displayName) || nameMatches(match.home, c.team.shortDisplayName || ''));
  const espnAway = comp.find((c) => c !== espnHome);
  if (!espnHome || !espnAway) return null;
  const homeId = espnHome.team.id, awayId = espnAway.team.id;
  const sideOf = (teamId) => (String(teamId) === String(homeId) ? 'home' : String(teamId) === String(awayId) ? 'away' : null);

  const home_score = Number(espnHome.score);
  const away_score = Number(espnAway.score);
  if (!Number.isInteger(home_score) || !Number.isInteger(away_score)) return null;

  const ke = Array.isArray(summary.keyEvents) ? summary.keyEvents : [];
  const isGoal = (t) => (/goal/i.test(t) && !/disallow|cancel|no goal|own goal\?/i.test(t)) || /penalty\s*-\s*scored/i.test(t);
  const isCard = (t) => /card/i.test(t);
  const isRed = (t) => /red card/i.test(t);

  const goals = ke.filter((k) => k.type && isGoal(k.type.text) && k.team);
  const cards = ke.filter((k) => k.type && isCard(k.type.text) && k.team);

  const firstGoal = goals[0] ? sideOf(goals[0].team.id) : 'none';
  const firstHalfGoal = goals.some((k) => (k.period && Number(k.period.number) === 1)) ? 'si' : 'no';
  const firstCard = cards[0] ? sideOf(cards[0].team.id) : 'none';
  const redCard = ke.some((k) => k.type && isRed(k.type.text)) ? 'si' : 'no';

  // Estadísticas del boxscore (offsides, córners) — totales del partido.
  let offsides = null, corners = null;
  const teams = (summary.boxscore && summary.boxscore.teams) || [];
  const sumStat = (name) => {
    let total = 0, found = false;
    for (const t of teams) {
      const st = (t.statistics || []).find((s) => s.name === name);
      if (st && st.displayValue != null && !isNaN(Number(st.displayValue))) { total += Number(st.displayValue); found = true; }
    }
    return found ? total : null;
  };
  offsides = sumStat('offsides');
  corners = sumStat('wonCorners');
  const fouls = sumStat('foulsCommitted');

  const props = {
    first_goal: firstGoal || 'none',
    odd_even: (home_score + away_score) % 2 === 0 ? 'par' : 'impar',
    first_half_goal: firstHalfGoal,
    first_card: firstCard || 'none',
    red_card: redCard,
  };
  if (offsides != null) props.offsides = offsides;
  if (corners != null) props.corners_total = corners;
  if (fouls != null) props.fouls_total = fouls;

  return { home_score, away_score, props };
}

// Fase final: trae los equipos de cada fase (16vos/8vos/cuartos) y quién avanzó.
async function resolveKnockout(adminHeaders) {
  const sb = await getJSON(`${ESPN}/scoreboard?dates=20260628-20260720&limit=200`);
  const byPhase = {};
  for (const e of (sb.events || [])) {
    const slug = e.season && e.season.slug;
    const phase = SLUG2PHASE[slug];
    if (phase) (byPhase[phase] || (byPhase[phase] = [])).push(e);
  }
  for (const phaseKey of Object.keys(byPhase)) {
    const evs = byPhase[phaseKey].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const allReal = evs.every((e) => e.competitions[0].competitors.every((x) => isRealTeam(x.team.displayName)));
    if (!allReal) continue; // aún hay equipos por definir (TBD)
    const teams = [];
    for (const e of evs) {
      const finished = e.status.type.completed === true;
      for (const c of e.competitions[0].competitors) {
        teams.push({ team: toES(c.team.displayName), advanced: finished ? (c.winner === true ? 1 : 0) : null });
      }
    }
    try {
      await fetch(`${BASE}/api/admin/ko`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ phase: phaseKey, first_kickoff: evs[0].date, teams }) });
      const done = evs.filter((e) => e.status.type.completed).length;
      log(`  KO ${phaseKey}: ${teams.length} equipos (${done}/${evs.length} jugados)`);
    } catch (e) { log('  KO error', phaseKey, e.message); }
  }
}

async function main() {
  const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-pin': PIN };
  const state = await getJSON(`${BASE}/api/state`);
  const now = Date.now();

  // 1) Partidos de grupos. Solo tocamos ESPN si hay alguno por cerrar (≥95 min
  // desde su inicio, sin resolver) — así no machacamos la API.
  const pending = state.matches.filter((m) => !m.result || (m.has_props && !m.props_result));
  const GRACE = 95 * 60 * 1000;
  const due = pending.filter((m) => Date.parse(m.kickoff) + GRACE <= now);
  if (due.length) await resolveGroups(due, adminHeaders);
  else log(`Sin partidos de grupos por cerrar (pendientes: ${pending.length}).`);

  // 2) Eliminatorias (a partir del 27 jun): equipos por fase + quién avanza.
  if (now >= Date.parse('2026-06-27T00:00:00-04:00')) {
    try { await resolveKnockout(adminHeaders); } catch (e) { log('KO error', e.message); }
  }
}

async function resolveGroups(due, adminHeaders) {
  const sb = await getJSON(`${ESPN}/scoreboard?dates=${SCOREBOARD_RANGE}&limit=400`);
  const espnEvents = (sb.events || []).map((e) => {
    const c = e.competitions[0].competitors;
    return { id: e.id, status: e.status.type.name, competitors: c };
  });

  let resolved = 0, unmatched = [];
  for (const m of due) {
    // Empareja por equipos (en cualquier orientación).
    const ev = espnEvents.find((e) => {
      const names = e.competitors.map((c) => c.team.displayName);
      return names.some((n) => nameMatches(m.home, n)) && names.some((n) => nameMatches(m.away, n));
    });
    if (!ev) { unmatched.push(`${m.home} vs ${m.away}`); continue; }
    if (ev.status !== 'STATUS_FULL_TIME') continue; // aún no termina

    let summary;
    try { summary = await getJSON(`${ESPN}/summary?event=${ev.id}`); }
    catch (e) { log('  error summary', ev.id, e.message); continue; }
    await sleep(250); // ser educado con ESPN

    const r = resolveFromSummary(m, summary);
    if (!r) { log(`  no pude parsear ${m.home} vs ${m.away} (ev ${ev.id})`); continue; }

    try {
      if (!m.result) {
        await fetch(`${BASE}/api/admin/matches/${m.id}/result`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ home_score: r.home_score, away_score: r.away_score }) });
      }
      if (m.has_props && !m.props_result) {
        await fetch(`${BASE}/api/admin/matches/${m.id}/props`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ props_result: r.props }) });
      }
      resolved++;
      log(`  ✓ ${m.home} ${r.home_score}-${r.away_score} ${m.away}${m.has_props ? `  extras: 1ergol=${r.props.first_goal} offs=${r.props.offsides} corners=${r.props.corners_total} 1atarj=${r.props.first_card} roja=${r.props.red_card}` : ''}`);
    } catch (e) { log('  error escribiendo', m.home, e.message); }
  }
  log(`Resueltos: ${resolved}.` + (unmatched.length ? ` Sin emparejar (${unmatched.length}): ${unmatched.join(', ')}` : ''));
}

if (require.main === module) {
  main().catch((e) => { log('ERROR', e.message); process.exit(1); });
}
module.exports = { resolveFromSummary, nameMatches };
