#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Activa el actualizador automático (ESPN) como systemd timer cada 2 minutos.
# Corre esto UNA vez en el servidor, dentro de la carpeta del repo:
#     bash deploy/enable-updater.sh
# Lee el puerto y el PIN del servicio 'quiniela' ya instalado.
# ---------------------------------------------------------------------------
set -e
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=/etc/systemd/system/quiniela.service

PORT="$(grep -oP 'PORT=\K[0-9]+' "$UNIT" 2>/dev/null | head -1)"; [ -z "$PORT" ] && PORT=3000
PIN="$(grep -oP 'ADMIN_PIN=\K.*' "$UNIT" 2>/dev/null | head -1)"; [ -z "$PIN" ] && PIN="${ADMIN_PIN:-2026}"
echo "▸ App: http://localhost:$PORT  · usando el PIN del servicio quiniela"

$SUDO tee /etc/systemd/system/quiniela-updater.service >/dev/null <<UNIT
[Unit]
Description=Quiniela updater (ESPN, marcador + extras)
After=network.target quiniela.service

[Service]
Type=oneshot
WorkingDirectory=$DIR
Environment=QUINIELA_URL=http://localhost:$PORT
Environment=ADMIN_PIN=$PIN
ExecStart=/usr/bin/node $DIR/updater.js
UNIT

$SUDO tee /etc/systemd/system/quiniela-updater.timer >/dev/null <<UNIT
[Unit]
Description=Corre el actualizador de la Quiniela cada 2 minutos

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now quiniela-updater.timer
$SUDO systemctl start quiniela-updater.service
sleep 3
echo
echo "✅ Actualizador activo (cada 2 min). Última corrida:"
journalctl -u quiniela-updater.service --no-pager -n 15 2>/dev/null | tail -15 || $SUDO systemctl status quiniela-updater.service --no-pager | tail -8
