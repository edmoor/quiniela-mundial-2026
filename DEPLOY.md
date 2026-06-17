# 🚀 Cómo subir la Quiniela para tu familia

## La idea (léelo primero — importante)

Esta app **no es una página estática**: es un **servidor Node + base de datos
SQLite** (`quiniela.db`). Eso cambia dónde puede vivir:

| Pieza | Para qué sirve | ¿Guarda los datos? |
|---|---|---|
| **GitHub** | Guardar el **código** y hacer `git push` | ❌ no, solo el código |
| **GitHub Pages / Cloudflare Pages** | Páginas **estáticas** | ❌ **no pueden correr esta app** (no ejecutan Node) |
| **Tu servidor Hetzner** | **Corre la app** y guarda `quiniela.db` | ✅ **sí, aquí viven los datos** |
| **Cloudflare** | Tu **dominio + HTTPS** (puerta de entrada) | ❌ no (para esta app) |

> Sobre tu duda: **Cloudflare NO guarda los datos de esta app.** Cloudflare sirve
> como dominio/HTTPS/escudo. (Sí tiene su propia base de datos “D1”, pero usarla
> obligaría a reescribir todo el backend; no vale la pena.) Los pronósticos se
> guardan en `quiniela.db` **en tu Hetzner**.

**Conclusión:** el camino correcto, **gratis para ti** (ya pagas Hetzner) y rápido es:

```
GitHub (código)  →  Hetzner (corre la app + datos)  →  Cloudflare (tu dominio con HTTPS)
```

> ⚠️ Evita servicios “gratis” tipo Render/Railway free: **borran el archivo de la
> base** en cada reinicio y perderías todos los pronósticos. Tu Hetzner tiene disco
> persistente: es el lugar correcto para una base SQLite.

---

## Paso 1 · Subir el código a GitHub

El proyecto **ya está como repositorio git con el primer commit hecho**. Solo falta
crear el repo en GitHub y empujar.

**Opción A — desde la web (sin instalar nada):**
1. Entra a <https://github.com/new>, crea un repo **privado** llamado `quiniela-mundial-2026` (sin README, sin .gitignore).
2. En tu compu, dentro de la carpeta del proyecto:

```bash
git remote add origin https://github.com/TU_USUARIO/quiniela-mundial-2026.git
git push -u origin main
```

**Opción B — con GitHub CLI:**
```bash
brew install gh
gh auth login
gh repo create quiniela-mundial-2026 --private --source=. --push
```

> El archivo `quiniela.db` **no** se sube (está en `.gitignore`): los datos viven
> solo en el servidor, como debe ser.

---

## Paso 2 · Correr la app en tu servidor Hetzner

Conéctate por SSH a tu servidor y:

```bash
# 1) Instalar Node 22 y git (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2) Bajar el código
cd /opt
sudo git clone https://github.com/TU_USUARIO/quiniela-mundial-2026.git
cd quiniela-mundial-2026

# 3) Probar que arranca (Ctrl+C para salir)
ADMIN_PIN=ELPINQUEQUIERAS PORT=3000 node run.js
```

Para que quede **prendido siempre** (y reinicie solo), usa el servicio systemd que
ya viene en el repo:

```bash
# Ajusta la ruta y tu PIN dentro del archivo si hace falta:
sudo cp deploy/quiniela.service /etc/systemd/system/quiniela.service
sudo nano /etc/systemd/system/quiniela.service   # revisa WorkingDirectory y ADMIN_PIN

sudo systemctl daemon-reload
sudo systemctl enable --now quiniela
sudo systemctl status quiniela        # debe decir "active (running)"
```

Ahora la app corre en `http://IP_DE_TU_SERVIDOR:3000` (interno).

---

## Paso 3 · Conectar tu dominio con HTTPS (Cloudflare)

### Opción A — Cloudflare Tunnel (recomendada: sin abrir puertos, HTTPS automático)

Usa tu Cloudflare + tu dominio. Es lo más rápido y seguro.

```bash
# En el servidor:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

cloudflared tunnel login                 # abre un link, autoriza tu dominio
cloudflared tunnel create quiniela       # crea el túnel (guarda el ID y el .json)
cloudflared tunnel route dns quiniela quiniela.TUDOMINIO.com
```

Crea `/etc/cloudflared/config.yml` (usa `deploy/cloudflared-config.example.yml` de
guía) apuntando a `http://localhost:3000`, y déjalo como servicio:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Listo: tu familia entra a **https://quiniela.TUDOMINIO.com** 🎉

### Opción B — DNS directo + Caddy (si prefieres no usar túnel)

1. En Cloudflare → DNS: registro **A** `quiniela` → IP de tu Hetzner (naranja/proxied).
2. Abre puertos 80 y 443 en el firewall del servidor.
3. Instala Caddy (HTTPS automático) y usa `deploy/Caddyfile.example`:

```bash
sudo apt-get install -y caddy
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # pon tu dominio
sudo systemctl restart caddy
```

---

## Actualizar la app después (tu flujo con git)

```bash
# En tu compu: cambias algo y subes
git add -A && git commit -m "mejora X" && git push

# En el servidor: bajas y reinicias
cd /opt/quiniela-mundial-2026
git pull
sudo systemctl restart quiniela
```

---

## Respaldos y mantenimiento

- **Todo** (jugadores, pronósticos, partidos, marcadores) está en `quiniela.db`.
  Respáldalo de vez en cuando:
  ```bash
  cp /opt/quiniela-mundial-2026/quiniela.db ~/quiniela-backup-$(date +%F).db
  ```
- **Reiniciar la quiniela desde cero:**
  ```bash
  sudo systemctl stop quiniela
  rm /opt/quiniela-mundial-2026/quiniela.db*
  sudo systemctl start quiniela
  ```
- **Cambiar el PIN de admin:** desde la app (⚙️ → Ajustes) o cambiando
  `ADMIN_PIN` en el servicio systemd y reiniciando.
