'use strict';

/* ===========================================================================
   Quiniela · Mundial 2026 (frontend)
   - Cada quien crea su jugador desde su celular (sin contraseñas).
   - Eliges quién gana Y el marcador. El ganador se deriva del marcador, así
     nunca queda inconsistente. Una vez enviado NO se puede cambiar.
   - Marcador exacto = 3 pts · Solo acertar el resultado = 1 pt.
   =========================================================================== */

const LS_TOKEN = 'quiniela_token';
const LS_ADMIN = 'quiniela_admin_pin';

let STATE = null;
let TOKEN = localStorage.getItem(LS_TOKEN) || null;
let ADMIN_PIN = localStorage.getItem(LS_ADMIN) || null;
let currentTab = ['tabla', 'yo'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'partidos';
let matchFilter = 'proximos';   // partidos (jugador): proximos | jugados | todos
let adminFilter = 'proximos';   // partidos (admin)
let roundFilter = 2;            // tabla: 2 (default) o 1
const EDITING = new Set();      // partidos abiertos que el jugador está re-editando
let pollTimer = null;
let animateOnce = true;

const DRAFTS = {};   // borradores de pronóstico del jugador: id -> {hg,ag,touched}
let ADRAFT = {};     // borradores de marcador del admin: id -> {hs,as}

const VIEW = document.getElementById('view');
const MODAL_ROOT = document.getElementById('modalRoot');

/* ---------- utilidades ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function outcome(h, a) { return h > a ? 'home' : h < a ? 'away' : 'draw'; }

async function api(path, opts = {}) {
  const { method = 'GET', body, admin = false } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers['x-player-token'] = TOKEN;
  if (admin && ADMIN_PIN) headers['x-admin-pin'] = ADMIN_PIN;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || ('Error ' + res.status));
  return data;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

function fmtDay(iso) { return new Date(iso).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }); }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }

/* ---------- carga de estado ---------- */
async function loadState() {
  STATE = await api('/api/state');
  document.getElementById('appTitle').textContent = (STATE.title || 'Quiniela').replace(/·.*$/, '').trim() || 'Quiniela';
  if (TOKEN && !STATE.me) {
    TOKEN = null; localStorage.removeItem(LS_TOKEN);
    toast('Tu sesión anterior ya no es válida. Crea o recupera tu jugador.', '');
  }
  const chip = document.getElementById('meChip');
  if (STATE.me) { chip.hidden = false; chip.textContent = `${STATE.me.emoji} ${STATE.me.name}`; }
  else chip.hidden = true;
  render();
}

/* ===========================================================================
   RENDER
   =========================================================================== */
function render() {
  const animate = animateOnce; animateOnce = false;
  if (!STATE) { VIEW.innerHTML = '<p class="empty">Cargando…</p>'; return; }
  if (currentTab === 'partidos') renderMatches(animate);
  else if (currentTab === 'tabla') renderStandings(animate);
  else if (currentTab === 'yo') renderMe(animate);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === currentTab));
  moveIndicator();
}

function staggerIn() {
  VIEW.querySelectorAll('.match, .board, .hero, .card').forEach((c, i) => {
    c.classList.add('enter'); c.style.animationDelay = Math.min(i * 45, 480) + 'ms';
  });
}

/* ---------- PARTIDOS ---------- */
function renderMatches(animate) {
  const me = STATE.me;
  let html = '';
  if (!me) {
    html += `<div class="notice" style="margin:8px 2px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span>👋 Crea tu jugador para participar.</span>
      <button class="btn small gold" data-act="register" style="margin-left:auto">Crear mi jugador</button></div>`;
  }
  if (!STATE.matches.length) {
    VIEW.innerHTML = html + `<div class="empty"><div class="big">⚽</div><p>Todavía no hay partidos.</p></div>`;
    return;
  }

  let nProx = 0, nJug = 0;
  for (const m of STATE.matches) { if (m.result) nJug++; else nProx++; }
  html += `<div class="filterbar">
    <button class="fbtn ${matchFilter === 'proximos' ? 'on' : ''}" data-filter="proximos">⏳ Próximos${nProx ? ` · ${nProx}` : ''}</button>
    <button class="fbtn ${matchFilter === 'jugados' ? 'on' : ''}" data-filter="jugados">✅ Jugados${nJug ? ` · ${nJug}` : ''}</button>
    <button class="fbtn ${matchFilter === 'todos' ? 'on' : ''}" data-filter="todos">Todos</button>
  </div>`;

  const list = STATE.matches.filter((m) => matchFilter === 'todos' ? true : matchFilter === 'jugados' ? !!m.result : !m.result);
  if (!list.length) {
    VIEW.innerHTML = html + `<div class="empty"><div class="big">🎉</div><p>${matchFilter === 'proximos' ? 'No quedan partidos por jugar.' : 'Aún no hay partidos jugados.'}</p></div>`;
    return;
  }
  let lastDay = null;
  for (const m of list) {
    const day = fmtDay(m.kickoff);
    if (day !== lastDay) { html += `<div class="dayhead"><b>${esc(day)}</b></div>`; lastDay = day; }
    html += matchCard(m);
  }
  VIEW.innerHTML = html;
  if (animate) staggerIn();
}

function goalbox(mid, side, val) {
  return `<div class="goalbox">
    <button data-step="${mid}" data-side="${side}" data-d="-1" aria-label="menos">−</button>
    <span class="g num" data-g="${mid}-${side}">${val}</span>
    <button data-step="${mid}" data-side="${side}" data-d="1" aria-label="más">+</button></div>`;
}
function wchip(mid, pick, sel, small, label) {
  return `<button class="wchip ${sel === pick ? 'sel' : ''}" data-pick="${pick}" data-mid="${mid}">${small ? `<small>${small}</small>` : ''}${esc(label)}</button>`;
}
function pchip(mid, key, val, label, sub) {
  const d = DRAFTS[mid];
  const sel = d && d.props && d.props[key] === val ? 'sel' : '';
  return `<button class="pchip ${sel}" data-prop="${key}" data-pval="${val}" data-mid="${mid}">${sub ? `<small>${esc(sub)}</small>` : ''}${esc(label)}</button>`;
}
function pnum(mid, key, label, sub) {
  const v = (DRAFTS[mid] && DRAFTS[mid].props && DRAFTS[mid].props[key] != null) ? DRAFTS[mid].props[key] : 0;
  return `<div class="prop"><div class="prop-q">${label} <small>${esc(sub)}</small></div>
    <div class="goalbox" style="margin:5px auto 0;width:max-content">
      <button data-pstep="${mid}" data-pkey="${key}" data-d="-1">−</button>
      <span class="g num" data-pnum="${mid}-${key}">${v}</span>
      <button data-pstep="${mid}" data-pkey="${key}" data-d="1">+</button></div></div>`;
}
function propsBody(m) {
  const mid = m.id;
  return `<div class="props">
    <div class="props-title">⭐ Extras · cada acierto +1 punto</div>
    <div class="prop"><div class="prop-q">⚽ ¿Quién mete el primer gol?</div><div class="prop-opts c3">
      ${pchip(mid, 'first_goal', 'home', m.home)}${pchip(mid, 'first_goal', 'none', 'Nadie')}${pchip(mid, 'first_goal', 'away', m.away)}</div></div>
    <div class="prop"><div class="prop-q">🔢 Total de goles, ¿par o impar?</div><div class="prop-opts c2">
      ${pchip(mid, 'odd_even', 'par', 'Par')}${pchip(mid, 'odd_even', 'impar', 'Impar')}</div></div>
    <div class="prop"><div class="prop-q">⏱️ ¿Gol en el 1er tiempo?</div><div class="prop-opts c2">
      ${pchip(mid, 'first_half_goal', 'si', 'Sí')}${pchip(mid, 'first_half_goal', 'no', 'No')}</div></div>
    ${pnum(mid, 'offsides', '🚩 ¿Cuántos offsides en total?', 'gana el más cercano')}
    ${pnum(mid, 'corners', '🏳️ ¿Cuántos córners en total?', 'gana el más cercano')}
    ${pnum(mid, 'fouls', '🦵 ¿Cuántas faltas en total?', 'gana el más cercano')}
    <div class="prop"><div class="prop-q">🟨 ¿Quién recibe la 1ª tarjeta?</div><div class="prop-opts c3">
      ${pchip(mid, 'first_card', 'home', m.home)}${pchip(mid, 'first_card', 'none', 'Ninguna')}${pchip(mid, 'first_card', 'away', m.away)}</div></div>
    <div class="prop"><div class="prop-q">🟥 ¿Habrá tarjeta roja?</div><div class="prop-opts c2">
      ${pchip(mid, 'red_card', 'si', 'Sí')}${pchip(mid, 'red_card', 'no', 'No')}</div></div>
  </div>`;
}

function predictorBody(m) {
  const d = DRAFTS[m.id];
  const hg = d ? d.hg : 0, ag = d ? d.ag : 0;
  const pick = d && d.touched ? outcome(hg, ag) : null;
  return `<div class="m-body">
      <div class="team"><div class="crest">${esc(m.home_emoji)}</div><div class="tname">${esc(m.home)}</div>${goalbox(m.id, 'home', hg)}</div>
      <div class="m-center"><div class="m-vs">${pick ? '–' : 'vs'}</div><div class="m-label">tu marcador</div></div>
      <div class="team"><div class="crest">${esc(m.away_emoji)}</div><div class="tname">${esc(m.away)}</div>${goalbox(m.id, 'away', ag)}</div>
    </div>
    <div class="winners">
      ${wchip(m.id, 'home', pick, 'Gana', m.home)}
      ${wchip(m.id, 'draw', pick, '', 'Empate')}
      ${wchip(m.id, 'away', pick, 'Gana', m.away)}
    </div>
    ${m.has_props ? propsBody(m) : ''}
    <button class="confirm" data-confirm="${m.id}" ${pick ? '' : 'disabled'}>${EDITING.has(m.id) ? 'Guardar cambios' : 'Enviar pronóstico'}</button>
    <div class="hint center" style="margin-top:9px">${pick ? (m.has_props ? 'Marcador exacto +3 · y elige los extras 👆 · puedes cambiar hasta que empiece' : 'Ajusta − / + para el marcador exacto (+3 pts)') : 'Elige quién gana y el marcador'}</div>`;
}

// Línea de "quién ya puso / quién falta" para partidos ABIERTOS (solo nombres).
function participantsLine(m) {
  const all = STATE.standings || [];
  if (!all.length) return '';
  const did = m.predicted_by || [];
  const didIds = new Set(did.map((p) => p.id));
  const missing = all.filter((p) => !didIds.has(p.id));
  let out = '<div class="parts">';
  out += `<div class="prow ya"><span class="plab">✅ Ya (${did.length})</span> ${did.length ? did.map((p) => `${esc(p.emoji)} ${esc(p.name)}`).join(' · ') : '<span class="muted">nadie aún</span>'}</div>`;
  if (missing.length) out += `<div class="prow falta"><span class="plab">⏳ Faltan (${missing.length})</span> ${missing.map((p) => esc(p.name)).join(' · ')}</div>`;
  else if (did.length) out += '<div class="prow ya"><span class="plab">🎉</span> ¡Ya pusieron todos!</div>';
  return out + '</div>';
}

// Resultado real de los extras + si el jugador acertó (para partidos terminados).
function propsResultBlock(m) {
  const r = m.props_result; if (!r) return '';
  const me = STATE.me;
  const myp = me && me.props ? me.props[m.id] : null;
  const win = m.prop_winners || {};
  const teamName = (v) => v === 'home' ? m.home : v === 'away' ? m.away : 'Nadie';
  const yn = (v) => v === 'si' ? 'Sí' : 'No';
  const rows = [];
  const row = (key, q, actualTxt, isNum) => {
    const winners = win[key] || [];
    const iWon = !!(me && winners.some((w) => w.name === me.name));
    const mark = myp ? (iWon ? ' ✓' : ' ✗') : '';
    const mine = (myp && isNum && myp[key] != null) ? ` <span class="muted">(tú: ${esc(myp[key])})</span>` : '';
    let winTxt = '';
    if (myp && !iWon && winners.length) {
      winTxt = `<div class="pr-win">🏆 ${winners.map((w) => `${esc(w.emoji)} ${esc(w.name)}${isNum ? ` (${esc(w.value)})` : ''}`).join(' · ')}</div>`;
    }
    rows.push(`<div class="pr-row ${myp ? (iWon ? 'hit' : 'miss') : ''}"><span class="pr-q">${esc(q)}${mine}</span><span class="pr-val">${esc(actualTxt)}${mark}</span></div>${winTxt}`);
  };
  if (r.first_goal != null) row('first_goal', 'Primer gol', teamName(r.first_goal), false);
  if (r.odd_even != null) row('odd_even', 'Goles par/impar', r.odd_even === 'par' ? 'Par' : 'Impar', false);
  if (r.first_half_goal != null) row('first_half_goal', 'Gol 1er tiempo', yn(r.first_half_goal), false);
  if (r.offsides != null) row('offsides', 'Offsides', r.offsides, true);
  if (r.corners_total != null) row('corners', 'Córners', r.corners_total, true);
  if (r.fouls_total != null) row('fouls', 'Faltas', r.fouls_total, true);
  if (r.first_card != null) row('first_card', '1ª tarjeta', teamName(r.first_card), false);
  if (r.red_card != null) row('red_card', 'Tarjeta roja', yn(r.red_card), false);
  if (!rows.length) return '';
  return `<details class="reveal" style="margin-top:9px"><summary>⭐ Resultado de los extras</summary><div class="prop-res">${rows.join('')}</div></details>`;
}

function matchCard(m) {
  const me = STATE.me;
  const myPred = me && me.predictions ? me.predictions[m.id] : undefined;
  const graded = !!m.result && m.home_score != null;
  const locked = m.locked;

  let status = '';
  if (graded) status = `<span class="m-status final">● Final</span>`;
  else if (locked && m.lock_reason === 'inicio') status = `<span class="m-status live"><span class="pip"></span>En vivo</span>`;
  else if (locked) status = `<span class="m-status lock">🔒 Cerrado</span>`;
  const head = `<div class="m-head">${m.grp ? `<span class="grp">Grupo ${esc(m.grp)}</span>` : ''}<span class="time num">${esc(fmtTime(m.kickoff))}</span>${m.venue ? `<span class="dot"></span><span>${esc(m.venue)}</span>` : ''}${status}</div>`;

  // Abierto: predictor si no ha pronosticado, o si está re-editando (hasta que empiece).
  if (!locked && (!myPred || EDITING.has(m.id))) {
    return `<div class="match" data-mid="${m.id}">${head}${predictorBody(m)}${participantsLine(m)}</div>`;
  }

  // Cuerpo estático
  const winCls = m.result === 'home' ? 'win-home' : m.result === 'away' ? 'win-away' : '';
  const center = graded
    ? `<div class="score-big ${winCls}"><span class="h num">${m.home_score}</span><span class="sep">–</span><span class="a num">${m.away_score}</span></div><div class="m-label">Final</div>`
    : `<div class="m-vs">VS</div>`;
  const body = `<div class="m-body">
      <div class="team"><div class="crest">${esc(m.home_emoji)}</div><div class="tname">${esc(m.home)}</div></div>
      <div class="m-center">${center}</div>
      <div class="team"><div class="crest">${esc(m.away_emoji)}</div><div class="tname">${esc(m.away)}</div></div>
    </div>`;

  let foot = '';
  if (myPred) {
    const ps = `${myPred.home_goals}–${myPred.away_goals}`;
    if (graded) {
      const exact = myPred.home_goals === m.home_score && myPred.away_goals === m.away_score;
      if (exact) foot += `<span class="pill exact">⭐ Exacto +3</span>`;
      else if (myPred.pick === m.result) foot += `<span class="pill ok">✓ Resultado +1</span>`;
      else foot += `<span class="pill no">✗ Fallaste</span>`;
      foot += `<span class="pill muted">Tu marcador <span class="num">${ps}</span></span>`;
    } else {
      foot += `<span class="pill mine">Tu pronóstico <span class="num">${ps}</span></span><button class="btn secondary small" data-editpred="${m.id}" style="padding:5px 11px;font-size:12px">✏️ Cambiar</button>`;
    }
  } else if (locked) {
    foot += `<span class="lockmsg">Apuestas cerradas</span>`;
  }

  let extra = '';
  if (locked) {
    const tot = Math.max(1, m.total_picks);
    extra += `<div class="distrib"><i class="h" style="width:${m.counts.home / tot * 100}%"></i><i class="d" style="width:${m.counts.draw / tot * 100}%"></i><i class="a" style="width:${m.counts.away / tot * 100}%"></i></div>`;
    if (m.picks && m.picks.length) {
      extra += `<button class="btn secondary small" data-reveal="${m.id}" style="width:100%;margin-top:11px">👁️ Ver qué puso cada quien · ${m.picks.length}</button>`;
    }
    if (m.has_props && m.props_result) extra += propsResultBlock(m);
  }
  return `<div class="match" data-mid="${m.id}">${head}${body}<div class="m-foot">${foot}</div>${extra}${!locked ? participantsLine(m) : ''}</div>`;
}

/* ---------- interacción del predictor ---------- */
function onStep(mid, side, delta) {
  const d = DRAFTS[mid] || (DRAFTS[mid] = { hg: 0, ag: 0, touched: false });
  d.touched = true;
  if (side === 'home') d.hg = clamp(d.hg + delta, 0, 99); else d.ag = clamp(d.ag + delta, 0, 99);
  updateCard(mid, side);
}
function onChip(mid, pick) {
  const d = DRAFTS[mid] || (DRAFTS[mid] = { hg: 0, ag: 0, touched: false });
  if (!(d.touched && outcome(d.hg, d.ag) === pick)) {
    if (pick === 'home') { d.hg = 1; d.ag = 0; }
    else if (pick === 'away') { d.hg = 0; d.ag = 1; }
    else { d.hg = 1; d.ag = 1; }
  }
  d.touched = true;
  updateCard(mid);
}
function setGoal(card, mid, side, val) {
  const g = card.querySelector(`[data-g="${mid}-${side}"]`); if (!g) return;
  if (g.textContent !== String(val)) {
    g.textContent = val; g.classList.remove('bump'); void g.offsetWidth; g.classList.add('bump');
  }
}
function updateCard(mid) {
  const card = VIEW.querySelector(`.match[data-mid="${mid}"]`); if (!card) return;
  const d = DRAFTS[mid]; if (!d) return;
  const pick = d.touched ? outcome(d.hg, d.ag) : null;
  setGoal(card, mid, 'home', d.hg);
  setGoal(card, mid, 'away', d.ag);
  card.querySelectorAll('.wchip').forEach((c) => c.classList.toggle('sel', c.dataset.pick === pick));
  const vs = card.querySelector('.m-vs'); if (vs) vs.textContent = pick ? '–' : 'vs';
  const cf = card.querySelector('.confirm'); if (cf) cf.disabled = !pick;
  const hint = card.querySelector('.hint');
  if (hint) hint.textContent = pick ? (card.querySelector('.props') ? 'Marcador exacto +3 · y elige los extras 👆' : 'Ajusta − / + para el marcador exacto (+3 pts)') : 'Elige quién gana y el marcador';
}
function onPropChip(mid, key, val) {
  const d = DRAFTS[mid] || (DRAFTS[mid] = { hg: 0, ag: 0, touched: false });
  if (!d.props) d.props = {};
  d.props[key] = val;
  const card = VIEW.querySelector(`.match[data-mid="${mid}"]`);
  if (card) card.querySelectorAll(`.pchip[data-prop="${key}"]`).forEach((c) => c.classList.toggle('sel', c.dataset.pval === val));
}
function onPropStep(mid, key, delta) {
  const d = DRAFTS[mid] || (DRAFTS[mid] = { hg: 0, ag: 0, touched: false });
  if (!d.props) d.props = {};
  const cur = d.props[key] != null ? d.props[key] : 0;
  d.props[key] = clamp(cur + delta, 0, 99);
  const el = VIEW.querySelector(`[data-pnum="${mid}-${key}"]`);
  if (el && el.textContent !== String(d.props[key])) { el.textContent = d.props[key]; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}
function onEditPred(mid) {
  const me = STATE.me; if (!me || !me.predictions[mid]) return;
  const pr = me.predictions[mid];
  const props = {};
  if (me.props && me.props[mid]) for (const k in me.props[mid]) {
    props[k] = ['offsides', 'corners', 'fouls'].includes(k) ? Number(me.props[mid][k]) : me.props[mid][k];
  }
  DRAFTS[mid] = { hg: pr.home_goals, ag: pr.away_goals, touched: true, props };
  EDITING.add(mid);
  animateOnce = false; render();
}

async function submitDraft(mid) {
  if (!STATE.me) { openRegister(); return; }
  const d = DRAFTS[mid];
  if (!d || !d.touched) { toast('Elige quién gana y el marcador.', 'err'); return; }
  const m = STATE.matches.find((x) => x.id === mid); if (!m) return;
  const pick = outcome(d.hg, d.ag);
  const win = pick === 'home' ? `Gana ${m.home}` : pick === 'away' ? `Gana ${m.away}` : 'Empate';
  let props = null;
  if (m.has_props) {
    const pp = d.props || {};
    ['offsides', 'corners', 'fouls'].forEach((k) => { if (pp[k] == null) pp[k] = 0; });
    const missing = ['first_goal', 'odd_even', 'first_half_goal', 'first_card', 'red_card'].filter((k) => pp[k] == null);
    if (missing.length) { toast('Te faltan extras por elegir 👇', 'err'); return; }
    props = { first_goal: pp.first_goal, odd_even: pp.odd_even, first_half_goal: pp.first_half_goal, offsides: pp.offsides, corners: pp.corners, fouls: pp.fouls, first_card: pp.first_card, red_card: pp.red_card };
  }
  const ok = await confirmModal('Confirmar pronóstico',
    `${esc(m.home_emoji)} <b>${esc(m.home)}</b> &nbsp;<span class="num" style="font-size:20px">${d.hg} – ${d.ag}</span>&nbsp; <b>${esc(m.away)}</b> ${esc(m.away_emoji)}
     <br><br>${esc(win)}${props ? ' <b>+ tus extras</b>' : ''}<br><br><span style="color:var(--gold);font-weight:700">✏️ Puedes cambiarlo hasta que empiece el partido.</span>`,
    'Confirmar', 'Cancelar');
  if (!ok) return;
  try {
    await api('/api/predictions', { method: 'POST', body: { match_id: mid, home_goals: d.hg, away_goals: d.ag, props } });
    const card = VIEW.querySelector(`.match[data-mid="${mid}"]`);
    if (card) { const r = card.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + 50); }
    delete DRAFTS[mid]; EDITING.delete(mid);
    toast('¡Pronóstico guardado! ✅', 'ok');
    await loadState();
  } catch (err) { toast(err.message, 'err'); await loadState(); }
}

// Modal con lo que pronosticó cada persona en un partido (ya cerrado).
function showPicks(mid) {
  const m = STATE.matches.find((x) => x.id === mid);
  if (!m || !m.picks) return;
  const graded = !!m.result && m.home_score != null;
  const head = `<div class="center" style="margin-bottom:14px">
    <div style="font-size:15px;font-weight:700">${esc(m.home_emoji)} ${esc(m.home)} vs ${esc(m.away)} ${esc(m.away_emoji)}</div>
    ${graded
      ? `<div class="num" style="font-size:30px;font-weight:700;margin-top:6px">${m.home_score} <span style="color:var(--faint)">–</span> ${m.away_score}</div><div class="hint">Resultado final</div>`
      : `<div class="hint" style="margin-top:6px">Aún sin resultado</div>`}</div>`;
  let list;
  if (!m.picks.length) list = '<p class="empty">Nadie pronosticó este partido.</p>';
  else list = m.picks.map((p) => {
    const mark = p.exact ? '<span class="pill exact">⭐ Exacto</span>' : p.correct === true ? '<span class="pill ok">✓</span>' : p.correct === false ? '<span class="pill no">✗</span>' : '';
    const sideTxt = p.pick === 'home' ? m.home : p.pick === 'away' ? m.away : 'Empate';
    return `<div class="admin-match" style="display:flex;align-items:center;gap:11px;margin-bottom:8px">
      <div class="av" style="width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-size:19px;background:rgba(255,255,255,.05);border:1px solid var(--line)">${esc(p.emoji)}</div>
      <div style="flex:1;min-width:0"><b>${esc(p.name)}</b><div class="hint">${esc(sideTxt)}</div></div>
      <span class="num" style="font-weight:700;font-size:16px">${p.home_goals}–${p.away_goals}</span>${mark}</div>`;
  }).join('');
  openModal('Pronósticos del partido', '', head + list + `<button class="btn secondary" data-close style="margin-top:8px">Cerrar</button>`);
}

/* ---------- TABLA ---------- */
function countUp(elm, to) {
  const dur = 750, t0 = performance.now();
  function f(now) { const t = Math.min(1, (now - t0) / dur); elm.textContent = Math.round((1 - Math.pow(1 - t, 3)) * to); if (t < 1) requestAnimationFrame(f); }
  requestAnimationFrame(f);
}
function renderStandings(animate) {
  const rounds = STATE.rounds || [];
  const sel = rounds.find((r) => r.key === roundFilter) || rounds[0];
  let html = `<div class="eyebrow">🏆 Tabla · ${esc(sel ? sel.name : 'general')}</div>`;
  html += `<div class="filterbar">` + rounds.map((r) =>
    `<button class="fbtn ${r.key === roundFilter ? 'on' : ''}" data-round="${r.key}">${r.key === 2 ? '🏆 ' : ''}${esc(r.name)}</button>`).join('') + `</div>`;
  const s = sel ? sel.standings : [];
  if (!s.length) {
    VIEW.innerHTML = html + `<div class="empty"><div class="big">🏆</div><p>Aún no hay puntos en esta ronda.<br>${STATE.me ? 'Empieza a pronosticar.' : 'Crea tu jugador en la pestaña “Yo”.'}</p></div>`;
    return;
  }
  const meId = STATE.me ? STATE.me.id : null;
  const top = s[0];
  html += `<div class="winner-callout ${sel.finished ? 'won' : ''}">
    <div class="wc-label">${sel.finished ? `🏆 Ganó la ${esc(sel.name)}` : `⭐ Va ganando · ${esc(sel.range)}`}</div>
    <div class="wc-who"><span class="wc-av">${esc(top.emoji)}</span><span class="wc-nm">${esc(top.name)}</span><span class="wc-pts num">${top.puntos} pts</span></div>
  </div>`;
  html += `<div class="board"><div class="trow head"><div>#</div><div>Jugador</div><div class="scorecol">Pts</div></div>`;
  for (const p of s) {
    const medal = p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : '';
    html += `<div class="trow ${p.id === meId ? 'me' : ''} ${p.rank <= 3 ? 'top' + p.rank : ''}">
        <div class="rank">${medal ? `<span class="medal">${medal}</span>` : p.rank}</div>
        <div class="who"><div class="av">${esc(p.emoji)}</div><div style="min-width:0"><div class="nm">${esc(p.name)}</div><div class="sub">${p.exactos} exactos · ${p.aciertos} aciertos</div></div></div>
        <div class="scorecol"><div class="pts num" data-pts="${p.puntos}">${animate ? 0 : p.puntos}</div><div class="ptlabel">pts</div></div>
      </div>`;
  }
  html += `</div><p class="hint center" style="margin-top:14px">Marcador exacto <b style="color:var(--gold)">+3</b> · Solo el resultado <b style="color:var(--emerald)">+1</b></p>`;
  VIEW.innerHTML = html;
  if (animate) { VIEW.querySelectorAll('[data-pts]').forEach((e) => countUp(e, Number(e.dataset.pts))); staggerIn(); }
}

/* ---------- YO ---------- */
function renderMe(animate) {
  const me = STATE.me;
  if (!me) {
    VIEW.innerHTML = `<div class="card center">
      <div style="font-size:50px">🙋</div>
      <h2 style="margin:8px 0 4px">Únete a la quiniela</h2>
      <p class="muted" style="margin-bottom:18px">Crea tu jugador para empezar a pronosticar.</p>
      <button class="btn" data-act="register">Crear mi jugador</button>
      <button class="btn secondary" style="margin-top:10px" data-act="restore">Ya tengo un código</button>
    </div>`;
    if (animate) staggerIn();
    return;
  }
  const my = STATE.standings.find((p) => p.id === me.id) || { puntos: 0, exactos: 0, aciertos: 0, total: 0 };
  const preds = STATE.matches.filter((m) => me.predictions[m.id]);
  let list = '';
  if (!preds.length) list = `<div class="empty"><div class="big">📝</div><p>Aún no has pronosticado.<br>Ve a “Partidos” y elige.</p></div>`;
  else {
    for (const m of preds) {
      const pr = me.predictions[m.id];
      const graded = !!m.result && m.home_score != null;
      let st = `<span class="pill muted">Pendiente</span>`;
      if (graded) {
        const exact = pr.home_goals === m.home_score && pr.away_goals === m.away_score;
        st = exact ? `<span class="pill exact">⭐ +3</span>` : pr.pick === m.result ? `<span class="pill ok">✓ +1</span>` : `<span class="pill no">✗</span>`;
      }
      list += `<div class="match" style="margin-bottom:9px;padding:12px">
        <div class="m-head" style="margin:0">
          ${m.grp ? `<span class="grp">G${esc(m.grp)}</span>` : ''}
          <span style="font-weight:700;color:var(--txt)">${esc(m.home_emoji)} ${esc(m.home)} <span class="num">${pr.home_goals}–${pr.away_goals}</span> ${esc(m.away)} ${esc(m.away_emoji)}</span>
        </div>
        <div class="m-foot" style="margin-top:9px">${st}${graded ? `<span class="pill muted">Final <span class="num">${m.home_score}–${m.away_score}</span></span>` : ''}</div>
      </div>`;
    }
  }
  VIEW.innerHTML = `
    <div class="hero">
      <div class="av">${esc(me.emoji)}</div>
      <div style="flex:1;min-width:0">
        <h2>${esc(me.name)}</h2>
        <p class="muted" style="font-size:13px">${my.exactos} exactos · ${my.aciertos} aciertos · ${my.total} pronósticos</p>
      </div>
      <div class="ptbig"><div class="n num" data-pts="${my.puntos}">${animate ? 0 : my.puntos}</div><div class="ptlabel">puntos</div></div>
    </div>
    <div class="eyebrow">📋 Mis pronósticos</div>
    ${list}
    <button class="btn secondary small" data-act="showcode" style="margin-top:14px">🔑 Ver mi código (para otro celular)</button>`;
  if (animate) { VIEW.querySelectorAll('[data-pts]').forEach((e) => countUp(e, Number(e.dataset.pts))); }
}

/* ===========================================================================
   EVENTOS (vista principal)
   =========================================================================== */
VIEW.addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  if (step) { onStep(Number(step.dataset.step), step.dataset.side, Number(step.dataset.d)); return; }
  const chip = e.target.closest('[data-pick]');
  if (chip && chip.dataset.mid) { onChip(Number(chip.dataset.mid), chip.dataset.pick); return; }
  const pc = e.target.closest('[data-prop]');
  if (pc) { onPropChip(Number(pc.dataset.mid), pc.dataset.prop, pc.dataset.pval); return; }
  const ps = e.target.closest('[data-pstep]');
  if (ps) { onPropStep(Number(ps.dataset.pstep), ps.dataset.pkey, Number(ps.dataset.d)); return; }
  const ep = e.target.closest('[data-editpred]');
  if (ep) { onEditPred(Number(ep.dataset.editpred)); return; }
  const cf = e.target.closest('[data-confirm]');
  if (cf) { submitDraft(Number(cf.dataset.confirm)); return; }
  const rev = e.target.closest('[data-reveal]');
  if (rev) { showPicks(Number(rev.dataset.reveal)); return; }
  const fb = e.target.closest('[data-filter]');
  if (fb) { matchFilter = fb.dataset.filter; animateOnce = true; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const rb = e.target.closest('[data-round]');
  if (rb) { roundFilter = Number(rb.dataset.round); animateOnce = true; render(); return; }
  const act = e.target.closest('[data-act]');
  if (act) { const a = act.dataset.act; if (a === 'register') openRegister(); else if (a === 'restore') openRestore(); else if (a === 'showcode') showCode(); }
});

/* ---------- registro ---------- */
const EMOJIS = ['🦁','🐯','🐉','🔥','⚽','🏆','👑','🦅','🐺','🌟','🍀','🚀','🎯','🐮','🦊','😎','🤓','🐻'];
function openRegister() {
  let selEmoji = EMOJIS[0];
  const body = `
    <label class="field"><span>¿Cómo te llamas?</span>
      <input id="regName" maxlength="24" placeholder="Tu nombre" autocomplete="off" /></label>
    <label class="field"><span>Elige tu emoji</span></label>
    <div class="emoji-row" id="emojiRow">${EMOJIS.map((e, i) => `<button class="emoji-pick ${i === 0 ? 'sel' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
    <div class="stack" style="margin-top:18px">
      <button class="btn" id="regGo">Crear jugador</button>
      <button class="btn secondary" data-close>Cancelar</button></div>`;
  const m = openModal('Crear mi jugador', 'Sin contraseñas. Usa el mismo celular para volver a entrar.', body);
  m.querySelector('#emojiRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-e]'); if (!b) return;
    selEmoji = b.dataset.e; m.querySelectorAll('.emoji-pick').forEach((x) => x.classList.toggle('sel', x === b));
  });
  m.querySelector('#regGo').addEventListener('click', async () => {
    const name = m.querySelector('#regName').value.trim();
    if (name.length < 2) { toast('Escribe tu nombre.', 'err'); return; }
    try {
      const data = await api('/api/players', { method: 'POST', body: { name, emoji: selEmoji } });
      TOKEN = data.token; localStorage.setItem(LS_TOKEN, TOKEN);
      closeModal(); confetti(innerWidth / 2, innerHeight * 0.35);
      toast(`¡Bienvenido, ${data.name}! 🎉`, 'ok');
      currentTab = 'partidos'; animateOnce = true; await loadState();
    } catch (err) { toast(err.message, 'err'); }
  });
  setTimeout(() => m.querySelector('#regName').focus(), 120);
}
function openRestore() {
  const body = `
    <label class="field"><span>Pega tu código</span><input id="codeIn" placeholder="código-xxxx" autocomplete="off" /></label>
    <div class="stack" style="margin-top:8px"><button class="btn" id="codeGo">Entrar</button><button class="btn secondary" data-close>Cancelar</button></div>`;
  const m = openModal('Entrar con mi código', 'Si ya creaste tu jugador en otro celular, pega aquí tu código.', body);
  m.querySelector('#codeGo').addEventListener('click', async () => {
    const code = m.querySelector('#codeIn').value.trim(); if (!code) return;
    const prev = TOKEN; TOKEN = code;
    try { await api('/api/me'); localStorage.setItem(LS_TOKEN, code); closeModal(); toast('¡Sesión recuperada! ✅', 'ok'); animateOnce = true; await loadState(); }
    catch (err) { TOKEN = prev; toast('Código no válido.', 'err'); }
  });
}
function showCode() {
  const body = `
    <p class="muted" style="font-size:13.5px;margin-bottom:10px">Guarda este código para entrar con tu mismo jugador en otro celular. No lo compartas o podrán pronosticar por ti.</p>
    <div class="card" style="word-break:break-all;font-family:'Space Grotesk',monospace;font-size:13px;text-align:center">${esc(TOKEN)}</div>
    <div class="stack" style="margin-top:14px"><button class="btn" id="copyCode">Copiar código</button><button class="btn secondary" data-close>Cerrar</button></div>`;
  const m = openModal('Mi código secreto', '', body);
  m.querySelector('#copyCode').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(TOKEN); toast('Copiado 📋', 'ok'); }
    catch { toast('Mantén presionado el texto para copiar.', ''); }
  });
}

/* ===========================================================================
   MODALES
   =========================================================================== */
function openModal(title, sub, bodyHTML) {
  closeModal();
  const overlay = el(`<div class="overlay"><div class="modal" role="dialog">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-close>✕</button></div>
      ${sub ? `<p class="sub">${esc(sub)}</p>` : ''}<div class="modal-body"></div></div></div>`);
  overlay.querySelector('.modal-body').innerHTML = bodyHTML;
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) closeModal(); });
  MODAL_ROOT.appendChild(overlay);
  return overlay.querySelector('.modal');
}
function closeModal() { MODAL_ROOT.innerHTML = ''; }

function confirmModal(title, htmlMsg, okLabel = 'Aceptar', cancelLabel = 'Cancelar') {
  return new Promise((resolve) => {
    const body = `<p style="font-size:15px;line-height:1.55">${htmlMsg}</p>
      <div class="stack" style="margin-top:18px"><button class="btn" id="cfOk">${esc(okLabel)}</button>
      <button class="btn secondary" id="cfNo">${esc(cancelLabel)}</button></div>`;
    const m = openModal(title, '', body);
    const overlay = m.closest('.overlay');
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; closeModal(); resolve(v); };
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('#cfOk')) done(true);
      else if (e.target.closest('#cfNo') || e.target.closest('[data-close]') || e.target === overlay) done(false);
    });
  });
}

/* ===========================================================================
   ADMINISTRADOR
   =========================================================================== */
document.getElementById('adminBtn').addEventListener('click', openAdmin);
async function openAdmin() {
  if (ADMIN_PIN) {
    try { await api('/api/admin/verify', { method: 'POST', admin: true }); return adminPanel(); }
    catch (_) { ADMIN_PIN = null; localStorage.removeItem(LS_ADMIN); }
  }
  const body = `
    <label class="field"><span>PIN de administrador</span><input id="pinIn" type="password" inputmode="numeric" placeholder="PIN" autocomplete="off" /></label>
    <div class="stack"><button class="btn" id="pinGo">Entrar</button><button class="btn secondary" data-close>Cancelar</button></div>
    <p class="hint" style="margin-top:10px">Solo quien organiza usa esto: poner marcadores y administrar partidos.</p>`;
  const m = openModal('Administrador', '', body);
  m.querySelector('#pinGo').addEventListener('click', async () => {
    ADMIN_PIN = m.querySelector('#pinIn').value.trim();
    try { await api('/api/admin/verify', { method: 'POST', admin: true }); localStorage.setItem(LS_ADMIN, ADMIN_PIN); adminPanel(); }
    catch (err) { ADMIN_PIN = null; toast('PIN incorrecto.', 'err'); }
  });
  setTimeout(() => m.querySelector('#pinIn').focus(), 120);
}

function adminPanel() {
  const body = `
    <div class="stack" style="margin-bottom:14px">
      <button class="btn gold" data-admin="addmatch">➕ Agregar partido</button>
      <div class="row2"><button class="btn secondary small" data-admin="settings">⚙️ Ajustes</button><button class="btn secondary small" data-admin="players">👥 Jugadores</button></div>
      <button class="btn secondary small" data-admin="help">🎁 Ayudar a un jugador</button>
    </div>
    <div class="eyebrow">⚽ Partidos — captura el marcador</div>
    <div id="adminMatches"></div>`;
  const m = openModal('Panel de administrador', 'Pon el marcador real, agrega o quita partidos.', body);
  m.addEventListener('click', (e) => {
    const a = e.target.closest('[data-admin]');
    if (a) { const w = a.dataset.admin; if (w === 'addmatch') return openMatchForm(null); if (w === 'settings') return openSettings(); if (w === 'players') return openPlayers(); if (w === 'help') return openHelp(); }
    const af = e.target.closest('[data-afilter]');
    if (af) { adminFilter = af.dataset.afilter; return renderAdminMatches(m); }
    const as = e.target.closest('[data-astep]');
    if (as) return onAdminStep(Number(as.dataset.astep), as.dataset.side, Number(as.dataset.d));
    const sv = e.target.closest('[data-savescore]');
    if (sv) return saveScore(Number(sv.dataset.savescore));
    const cl = e.target.closest('[data-clearscore]');
    if (cl) return clearScore(Number(cl.dataset.clearscore));
    const ct = e.target.closest('[data-close-toggle]');
    if (ct) return toggleClose(Number(ct.dataset.mid), ct.dataset.closed === '1' ? 0 : 1);
    const ed = e.target.closest('[data-edit]');
    if (ed) return openMatchForm(Number(ed.dataset.edit));
    const dl = e.target.closest('[data-del]');
    if (dl) return deleteMatch(Number(dl.dataset.del));
  });
  renderAdminMatches(m);
}
function renderAdminMatches(modal) {
  const box = modal.querySelector('#adminMatches'); if (!box) return;
  ADRAFT = {};
  for (const m of STATE.matches) ADRAFT[m.id] = { hs: m.home_score == null ? 0 : m.home_score, as: m.away_score == null ? 0 : m.away_score };
  if (!STATE.matches.length) { box.innerHTML = '<p class="empty">No hay partidos. Agrega uno.</p>'; return; }

  let nProx = 0, nJug = 0;
  for (const m of STATE.matches) { if (m.result) nJug++; else nProx++; }
  let html = `<div class="filterbar">
    <button class="fbtn ${adminFilter === 'proximos' ? 'on' : ''}" data-afilter="proximos">⏳ Por jugar${nProx ? ` · ${nProx}` : ''}</button>
    <button class="fbtn ${adminFilter === 'jugados' ? 'on' : ''}" data-afilter="jugados">✅ Con marcador${nJug ? ` · ${nJug}` : ''}</button>
    <button class="fbtn ${adminFilter === 'todos' ? 'on' : ''}" data-afilter="todos">Todos</button>
  </div>`;
  const list = STATE.matches.filter((m) => adminFilter === 'todos' ? true : adminFilter === 'jugados' ? !!m.result : !m.result);
  let lastDay = null;
  for (const m of list) {
    const day = fmtDay(m.kickoff);
    if (day !== lastDay) { html += `<div class="eyebrow" style="margin:14px 2px 8px">${esc(day)}</div>`; lastDay = day; }
    const saved = m.result ? `<div class="hint center" style="margin-top:6px">Guardado: <b class="num">${m.home_score}–${m.away_score}</b></div>` : '';
    html += `<div class="admin-match">
      <div class="am-top">${m.grp ? `<span class="grp">G${esc(m.grp)}</span>` : ''}<span>${esc(m.home_emoji)} ${esc(m.home)} vs ${esc(m.away)} ${esc(m.away_emoji)}</span><span class="time num">${esc(fmtTime(m.kickoff))}</span></div>
      <div class="am-score">
        ${goalboxAdmin(m.id, 'hs', ADRAFT[m.id].hs)}<span class="sep">–</span>${goalboxAdmin(m.id, 'as', ADRAFT[m.id].as)}
      </div>
      <div class="am-actions"><button class="btn small" data-savescore="${m.id}">Guardar marcador</button><button class="btn small secondary" data-clearscore="${m.id}">Sin jugar</button></div>
      <div class="am-actions" style="margin-top:7px">
        <button class="btn small secondary" data-close-toggle data-mid="${m.id}" data-closed="${m.closed ? 1 : 0}">${m.closed ? '🔓 Reabrir' : '🔒 Cerrar'}</button>
        <button class="btn small secondary" data-edit="${m.id}" style="flex:0 0 auto">✏️</button>
        <button class="btn small danger" data-del="${m.id}" style="flex:0 0 auto">🗑️</button>
      </div>${saved}</div>`;
  }
  if (!list.length) html += `<div class="empty"><div class="big">🎉</div><p>${adminFilter === 'proximos' ? 'Ya pusiste todos los marcadores.' : 'No hay partidos en esta vista.'}</p></div>`;
  box.innerHTML = html;
}
function goalboxAdmin(mid, side, val) {
  return `<div class="goalbox">
    <button data-astep="${mid}" data-side="${side}" data-d="-1">−</button>
    <span class="g num" data-ag="${mid}-${side}">${val}</span>
    <button data-astep="${mid}" data-side="${side}" data-d="1">+</button></div>`;
}
function onAdminStep(mid, side, delta) {
  const d = ADRAFT[mid]; if (!d) return;
  d[side] = clamp(d[side] + delta, 0, 99);
  const g = document.querySelector(`[data-ag="${mid}-${side}"]`);
  if (g) { g.textContent = d[side]; g.classList.remove('bump'); void g.offsetWidth; g.classList.add('bump'); }
}
async function saveScore(mid) {
  const d = ADRAFT[mid]; if (!d) return;
  try {
    await api(`/api/admin/matches/${mid}/result`, { method: 'POST', admin: true, body: { home_score: d.hs, away_score: d.as } });
    toast('Marcador guardado ✅', 'ok'); await loadState();
    const modal = document.querySelector('.modal'); if (modal && modal.querySelector('#adminMatches')) renderAdminMatches(modal);
  } catch (err) { toast(err.message, 'err'); }
}
async function clearScore(mid) {
  try {
    await api(`/api/admin/matches/${mid}/result`, { method: 'POST', admin: true, body: { clear: true } });
    toast('Marcado como sin jugar', 'ok'); await loadState();
    const modal = document.querySelector('.modal'); if (modal && modal.querySelector('#adminMatches')) renderAdminMatches(modal);
  } catch (err) { toast(err.message, 'err'); }
}
async function toggleClose(mid, closed) {
  try { await api(`/api/admin/matches/${mid}/close`, { method: 'POST', admin: true, body: { closed: !!closed } }); await loadState();
    const modal = document.querySelector('.modal'); if (modal && modal.querySelector('#adminMatches')) renderAdminMatches(modal);
  } catch (err) { toast(err.message, 'err'); }
}
async function deleteMatch(mid) {
  const m = STATE.matches.find((x) => x.id === mid);
  const ok = await confirmModal('Eliminar partido', `¿Eliminar <b>${esc(m ? m.home + ' vs ' + m.away : '')}</b> y sus pronósticos?`, 'Eliminar', 'Cancelar');
  if (!ok) return;
  try { await api(`/api/admin/matches/${mid}`, { method: 'DELETE', admin: true }); toast('Partido eliminado', 'ok'); await loadState(); adminPanel(); }
  catch (err) { toast(err.message, 'err'); }
}
function openMatchForm(id) {
  const m = id ? STATE.matches.find((x) => x.id === id) : null;
  const dtVal = m ? toLocalInput(m.kickoff) : '';
  const body = `
    <div class="row2">
      <label class="field"><span>Equipo local</span><input id="mfHome" value="${m ? esc(m.home) : ''}" placeholder="Local" /></label>
      <label class="field"><span>Equipo visitante</span><input id="mfAway" value="${m ? esc(m.away) : ''}" placeholder="Visitante" /></label></div>
    <div class="row2">
      <label class="field"><span>Emoji local</span><input id="mfHe" value="${m ? esc(m.home_emoji) : '⚽'}" /></label>
      <label class="field"><span>Emoji visitante</span><input id="mfAe" value="${m ? esc(m.away_emoji) : '⚽'}" /></label></div>
    <div class="row2">
      <label class="field"><span>Grupo</span><input id="mfGrp" value="${m && m.grp ? esc(m.grp) : ''}" placeholder="K" /></label>
      <label class="field"><span>Sede</span><input id="mfVenue" value="${m && m.venue ? esc(m.venue) : ''}" placeholder="Ciudad" /></label></div>
    <label class="field"><span>Fecha y hora</span><input id="mfKick" type="datetime-local" value="${dtVal}" /></label>
    <div class="stack" style="margin-top:8px"><button class="btn" id="mfSave">${id ? 'Guardar cambios' : 'Agregar partido'}</button><button class="btn secondary" data-back-admin>Volver</button></div>`;
  const modal = openModal(id ? 'Editar partido' : 'Agregar partido', '', body);
  modal.querySelector('[data-back-admin]').addEventListener('click', () => adminPanel());
  modal.querySelector('#mfSave').addEventListener('click', async () => {
    const payload = {
      home: modal.querySelector('#mfHome').value.trim(), away: modal.querySelector('#mfAway').value.trim(),
      home_emoji: modal.querySelector('#mfHe').value.trim() || '⚽', away_emoji: modal.querySelector('#mfAe').value.trim() || '⚽',
      grp: modal.querySelector('#mfGrp').value.trim(), venue: modal.querySelector('#mfVenue').value.trim(),
      kickoff: fromLocalInput(modal.querySelector('#mfKick').value),
    };
    if (!payload.home || !payload.away) { toast('Faltan los equipos.', 'err'); return; }
    if (!payload.kickoff) { toast('Pon la fecha y hora.', 'err'); return; }
    try {
      if (id) await api(`/api/admin/matches/${id}`, { method: 'PATCH', admin: true, body: payload });
      else await api('/api/admin/matches', { method: 'POST', admin: true, body: payload });
      toast('Guardado ✅', 'ok'); await loadState(); adminPanel();
    } catch (err) { toast(err.message, 'err'); }
  });
}
function openSettings() {
  const body = `
    <label class="field"><span>Título de la quiniela</span><input id="stTitle" value="${esc(STATE.title || '')}" maxlength="60" /></label>
    <p class="hint" style="margin:-4px 2px 12px">ℹ️ Las apuestas se cierran solas a la hora de inicio de cada partido. Para dar más o menos tiempo, edita la hora (✏️).</p>
    <button class="btn" id="stSave" style="margin-bottom:18px">Guardar ajustes</button>
    <div class="eyebrow">🔐 Cambiar PIN</div>
    <label class="field"><span>Nuevo PIN (3 a 12 caracteres)</span><input id="stPin" type="text" autocomplete="off" /></label>
    <button class="btn secondary" id="stPinSave">Cambiar PIN</button>
    <button class="btn secondary" data-back-admin style="margin-top:18px">Volver</button>`;
  const modal = openModal('Ajustes', '', body);
  modal.querySelector('[data-back-admin]').addEventListener('click', () => adminPanel());
  modal.querySelector('#stSave').addEventListener('click', async () => {
    try { await api('/api/admin/settings', { method: 'POST', admin: true, body: { title: modal.querySelector('#stTitle').value.trim() } }); toast('Ajustes guardados ✅', 'ok'); await loadState(); }
    catch (err) { toast(err.message, 'err'); }
  });
  modal.querySelector('#stPinSave').addEventListener('click', async () => {
    const np = modal.querySelector('#stPin').value.trim();
    try { await api('/api/admin/pin', { method: 'POST', admin: true, body: { new_pin: np } }); ADMIN_PIN = np; localStorage.setItem(LS_ADMIN, np); toast('PIN cambiado ✅', 'ok'); modal.querySelector('#stPin').value = ''; }
    catch (err) { toast(err.message, 'err'); }
  });
}
async function openPlayers() {
  let players;
  try { players = (await api('/api/admin/players', { admin: true })).players || []; }
  catch (err) { toast(err.message, 'err'); return; }
  const ptsById = {};
  for (const s of STATE.standings) ptsById[s.id] = s;
  let html = players.length ? '' : '<p class="empty">Aún no hay jugadores.</p>';
  for (const p of players) {
    const st = ptsById[p.id] || { puntos: 0, total: 0 };
    html += `<div class="admin-match">
      <div style="display:flex;align-items:center;gap:11px">
        <div class="av" style="width:38px;height:38px;border-radius:12px;display:grid;place-items:center;font-size:20px;background:rgba(255,255,255,.05);border:1px solid var(--line)">${esc(p.emoji)}</div>
        <div style="flex:1;min-width:0"><b>${esc(p.name)}</b><div class="hint">${st.puntos} pts · ${st.total} pronósticos</div></div>
        <button class="btn danger small" data-delplayer="${p.id}" style="flex:0 0 auto">🗑️</button>
      </div>
      <div style="margin-top:9px;display:flex;gap:7px;align-items:center">
        <code style="flex:1;min-width:0;font-size:11px;background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:9px;padding:8px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'Space Grotesk',monospace;color:var(--muted)">${esc(p.token)}</code>
        <button class="btn secondary small" data-copycode="${esc(p.token)}" style="flex:0 0 auto">📋 Copiar</button>
      </div>
    </div>`;
  }
  const modal = openModal('Jugadores y sus códigos', 'Pásale su código a quien lo olvidó: con él entra a su mismo jugador desde otro celular (en “Yo → Ya tengo un código”).', html + `<button class="btn secondary" data-back-admin style="margin-top:12px">Volver</button>`);
  modal.querySelector('[data-back-admin]').addEventListener('click', () => adminPanel());
  modal.addEventListener('click', async (e) => {
    const cp = e.target.closest('[data-copycode]');
    if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copycode); toast('Código copiado 📋', 'ok'); } catch { toast('Mantén presionado el código para copiar.', ''); } return; }
    const b = e.target.closest('[data-delplayer]'); if (!b) return;
    const id = Number(b.dataset.delplayer); const p = players.find((x) => x.id === id);
    const ok = await confirmModal('Eliminar jugador', `¿Eliminar a <b>${esc(p ? p.name : '')}</b> y sus pronósticos?`, 'Eliminar', 'Cancelar');
    if (!ok) return;
    try { await api(`/api/admin/players/${id}`, { method: 'DELETE', admin: true }); toast('Jugador eliminado', 'ok'); await loadState(); openPlayers(); }
    catch (err) { toast(err.message, 'err'); }
  });
}

// Panel discreto: darle puntos a un jugador corrigiendo sus extras "seguros".
function openHelp(preselect) {
  const players = STATE.standings;
  if (!players.length) { toast('No hay jugadores aún.', 'err'); return; }
  const gradedProp = STATE.matches.filter((m) => m.has_props && m.props_result);
  let mh = gradedProp.length ? '' : '<p class="empty">Aún no hay partidos jugados con extras.</p>';
  for (const m of gradedProp) {
    mh += `<div class="admin-match" style="display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0"><b>${esc(m.home)} <span class="num">${m.home_score}-${m.away_score}</span> ${esc(m.away)}</b><div class="hint">${esc(fmtDay(m.kickoff))}</div></div>
      <button class="btn gold small" data-help="${m.id}" style="flex:0 0 auto">🎁 +hasta 5</button></div>`;
  }
  const body = `
    <p class="hint" style="margin-bottom:10px">Le pongo correctos sus extras "seguros" (primer gol, par/impar, gol 1er tiempo, 1ª tarjeta, tarjeta roja). <b>No le quita a nadie</b>; solo se ve como que acertó.</p>
    <label class="field"><span>¿A quién ayudo?</span>
      <select id="helpPlayer">${players.map((p) => `<option value="${p.id}">${esc(p.emoji)} ${esc(p.name)} · ${p.puntos} pts (#${p.rank})</option>`).join('')}</select></label>
    <div class="eyebrow">Toca un partido para darle puntos (poco a poco)</div>
    <div id="helpMatches">${mh}</div>
    <button class="btn secondary" data-back-admin style="margin-top:12px">Volver</button>`;
  const modal = openModal('🎁 Ayudar a un jugador', 'Sube a alguien sin afectar a los demás.', body);
  if (preselect != null) modal.querySelector('#helpPlayer').value = String(preselect);
  modal.querySelector('[data-back-admin]').addEventListener('click', () => adminPanel());
  modal.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-help]'); if (!b) return;
    const mid = Number(b.dataset.help);
    const pid = Number(modal.querySelector('#helpPlayer').value);
    try {
      const r = await api('/api/admin/help', { method: 'POST', admin: true, body: { player_id: pid, match_id: mid } });
      toast(r.gained ? `🎁 +${r.gained} ${r.gained === 1 ? 'punto' : 'puntos'}` : 'Ya tenía esos extras correctos', 'ok');
      await loadState();
      openHelp(pid);
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ---------- fechas ---------- */
function toLocalInput(iso) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v) { if (!v) return ''; const d = new Date(v); return isNaN(d.getTime()) ? '' : d.toISOString(); }

/* ===========================================================================
   CONFETI (canvas, sin librerías)
   =========================================================================== */
const FX = document.getElementById('fx'); const fxc = FX.getContext('2d');
let DPR = Math.min(2, window.devicePixelRatio || 1);
function fxResize() { DPR = Math.min(2, window.devicePixelRatio || 1); FX.width = innerWidth * DPR; FX.height = innerHeight * DPR; }
fxResize(); window.addEventListener('resize', () => { fxResize(); moveIndicator(); });
let parts = [], raf = null;
function confetti(x, y) {
  const cols = ['#19e08c', '#ffcf5a', '#a08cff', '#46d6ff', '#ffffff'];
  for (let i = 0; i < 90; i++) parts.push({
    x: x * DPR, y: y * DPR, vx: (Math.random() - .5) * 13 * DPR, vy: (Math.random() * -11 - 4) * DPR,
    g: .42 * DPR, life: 1, col: cols[i % cols.length], s: (Math.random() * 5 + 3) * DPR, rot: Math.random() * 6, vr: (Math.random() - .5) * .4,
  });
  if (!raf) raf = requestAnimationFrame(fxTick);
}
function fxTick() {
  fxc.clearRect(0, 0, FX.width, FX.height);
  parts = parts.filter((p) => p.life > 0);
  for (const p of parts) {
    p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= .99; p.life -= .012; p.rot += p.vr;
    fxc.save(); fxc.translate(p.x, p.y); fxc.rotate(p.rot); fxc.globalAlpha = Math.max(0, p.life); fxc.fillStyle = p.col;
    fxc.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .62); fxc.restore();
  }
  if (parts.length) raf = requestAnimationFrame(fxTick); else { fxc.clearRect(0, 0, FX.width, FX.height); raf = null; }
}

/* ===========================================================================
   PESTAÑAS + ARRANQUE
   =========================================================================== */
function moveIndicator() {
  const bar = document.querySelector('.tabbar'), ind = document.querySelector('.tab-ind');
  if (!bar || !ind) return;
  const w = bar.clientWidth / 3, idx = ['partidos', 'tabla', 'yo'].indexOf(currentTab);
  ind.style.transform = `translateX(${idx * w}px)`;
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  currentTab = b.dataset.tab; animateOnce = true; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
}));
document.getElementById('meChip').addEventListener('click', () => { currentTab = 'yo'; animateOnce = true; render(); });

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (MODAL_ROOT.children.length || VIEW.querySelector('details[open]') || Object.keys(DRAFTS).length) return;
    try { await loadState(); } catch (_) {}
  }, 12000);
}
(async function init() {
  try { await loadState(); }
  catch (err) { VIEW.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>No se pudo conectar.<br>${esc(err.message)}</p></div>`; }
  moveIndicator();
  startPolling();
})();
