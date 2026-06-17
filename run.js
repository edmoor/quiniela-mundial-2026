'use strict';

/* ===========================================================================
   Lanzador de la Quiniela.
   La app usa el SQLite integrado de Node (node:sqlite), que existe desde
   Node 22.5. Algunas terminales (p.ej. con conda) traen un Node más viejo
   por defecto. Este lanzador detecta tu Node y, si es viejo, busca y usa
   automáticamente una versión 22.5+ que ya tengas instalada (Homebrew, etc.).
   Así solo corres "npm start" y funciona, sin instalar nada.
   =========================================================================== */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER = path.join(__dirname, 'server.js');

function meetsMin(major, minor) {
  return major > 22 || (major === 22 && minor >= 5);
}

// 1) ¿El Node con el que arrancamos ya sirve? -> corre directo.
const selfParts = process.versions.node.split('.').map(Number);
if (meetsMin(selfParts[0], selfParts[1])) {
  require('./server.js');
  return;
}

// 2) Si no, busca otra versión de Node 22.5+ instalada en la máquina.
function versionOf(bin) {
  try {
    const out = cp.execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = out.match(/^v(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch (_) {
    return null;
  }
}

const candidates = [];
const add = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };

['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].forEach(add);
(process.env.PATH || '').split(path.delimiter).forEach((d) => { if (d) add(path.join(d, 'node')); });
// Versiones de nvm / fnm si existen (de la más nueva a la más vieja)
for (const base of [path.join(os.homedir(), '.nvm/versions/node'),
                    path.join(os.homedir(), '.fnm/node-versions')]) {
  try {
    if (fs.existsSync(base)) {
      fs.readdirSync(base).sort().reverse().forEach((v) => add(path.join(base, v, 'bin/node')));
    }
  } catch (_) {}
}

let best = null, bestV = null;
for (const c of candidates) {
  if (c === process.execPath) continue;
  if (!fs.existsSync(c)) continue;
  const v = versionOf(c);
  if (v && meetsMin(v[0], v[1])) { best = c; bestV = v; break; }
}

if (best) {
  console.log(`(Tu Node por defecto es v${process.versions.node}; uso Node v${bestV.join('.')} para arrancar.)`);
  const r = cp.spawnSync(best, ['--no-warnings', SERVER], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
} else {
  console.error('\n  ⚠️  La Quiniela necesita Node.js 22.5 o más nuevo.');
  console.error(`     Tu Node por defecto es v${process.versions.node} y no encontré otro más nuevo.`);
  console.error('     Instala una versión nueva y vuelve a intentar, por ejemplo:');
  console.error('         brew install node');
  console.error('     (o abre una terminal nueva donde "node -v" muestre 22.5 o más).\n');
  process.exit(1);
}
