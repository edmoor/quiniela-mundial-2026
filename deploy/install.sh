#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Instalador de la Quiniela para un servidor Ubuntu/Debian (Hetzner, etc.)
# Uso (dentro de la carpeta del repo ya clonado):
#     ADMIN_PIN=tuPin bash deploy/install.sh
# Instala Node 22 si falta y deja la app corriendo como servicio (systemd),
# que se reinicia sola y arranca al prender el servidor.
# ---------------------------------------------------------------------------
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="${ADMIN_PIN:-2026}"
PORT="${PORT:-3000}"

# Usar $SUDO solo si no somos root (en Hetzner es común entrar como root).
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "▸ Carpeta de la app: $DIR"
echo "▸ Puerto: $PORT  ·  PIN admin: $PIN"

# 1) Node 22+ (lo que necesita node:sqlite)
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  echo "▸ Instalando Node 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
echo "▸ Node: $(node -v)"

# 2) Servicio systemd
echo "▸ Creando servicio systemd 'quiniela'…"
$SUDO tee /etc/systemd/system/quiniela.service >/dev/null <<UNIT
[Unit]
Description=Quiniela Familiar Mundial 2026
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=ADMIN_PIN=$PIN
ExecStart=/usr/bin/node $DIR/run.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now quiniela
sleep 2
$SUDO systemctl --no-pager status quiniela | head -6 || true

echo
echo "✅ Quiniela corriendo en http://localhost:$PORT  (PIN admin: $PIN)"
echo "   Siguiente: exponla con tu dominio + HTTPS (Cloudflare Tunnel) — ver DEPLOY.md, Paso 3."
