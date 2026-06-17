# ⚽ Quiniela Familiar — Mundial 2026

Quiniela sencilla y divertida para jugar en familia durante el Mundial 2026.
Cada quien pronostica **quién gana** o si hay **empate** en cada partido. **1 punto por acierto** y la **tabla general se actualiza sola** conforme pones los resultados.

- Cada familiar **crea su jugador desde su celular** (sin contraseñas, sin registros raros).
- Una vez que alguien elige, **no puede cambiar** su pronóstico.
- Tú (quien organiza) tienes un **panel de administrador** para poner resultados y **agregar o quitar partidos** cuando quieras.
- Ya viene **precargado con los 52 partidos reales** del Mundial 2026, del **17 al 27 de junio** (desde *Portugal vs RD Congo* en adelante).

Hecho con **Node + SQLite integrado**. Sin Firebase, sin servicios externos, sin nada que instalar de internet.

---

## ▶️ Cómo arrancarla

Desde la carpeta del proyecto:

```bash
npm start
```

**No necesitas instalar nada** (no hay `npm install`). La app usa el SQLite que
ya viene dentro de Node, el cual requiere **Node 22.5 o más nuevo**. Si tu
terminal abre por defecto un Node más viejo (muy común con conda/anaconda), el
lanzador **busca y usa automáticamente** un Node nuevo que ya tengas instalado
(por ejemplo el de Homebrew). Tú solo corres `npm start`.

> Si te dice que necesita Node 22.5+ y no lo encuentra, instálalo con
> `brew install node` y vuelve a correr `npm start`.

Verás algo así:

```
  ⚽  Quiniela Familiar — Mundial 2026
  ───────────────────────────────────────
  En esta computadora:  http://localhost:3000
  Desde el celular:     http://192.168.3.81:3000
  PIN de administrador: 2026  (cámbialo en el panel)
  ───────────────────────────────────────
```

Abre `http://localhost:3000` en tu navegador y ya está funcionando.

> Si el puerto 3000 está ocupado, arráncala en otro: `PORT=3311 npm start`

---

## 📱 Cómo entran tus familiares (desde su celular)

**Si están en la misma red WiFi** (la casa, una reunión):
solo comparte la dirección **“Desde el celular”** que aparece al arrancar
(por ejemplo `http://192.168.3.81:3000`). Cada quien la abre en su teléfono,
toca **“Crear mi jugador”**, pone su nombre y su emoji, y a pronosticar. 🎉

**Si quieres que entren desde cualquier lugar** (no solo en tu WiFi), tienes que
dejar el servidor accesible por internet. Dos caminos:

1. **Túnel rápido** (lo más fácil para probar): deja `npm start` corriendo y en
   otra terminal abre un túnel hacia el puerto 3000, por ejemplo con
   [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
   (`cloudflared tunnel --url http://localhost:3000`). Te da un link público
   que puedes mandar por WhatsApp.
2. **Subirlo a un servidor** (para que viva siempre online): cualquier VPS o
   servicio donde corra Node sirve. Copia la carpeta, corre `npm start` y listo.
   El archivo `quiniela.db` guarda todo; haz respaldo de ese archivo.

> La computadora/servidor donde corre `npm start` debe quedarse **encendida**
> mientras la familia juega: ahí vive la base de datos compartida.

---

## 👑 Administrador (solo tú)

Toca el engrane **⚙️** arriba a la derecha y mete el PIN.

- **PIN por defecto: `2026`** — cámbialo en **Ajustes → Cambiar PIN**.
- **Poner el marcador:** en el panel, cada partido tiene un marcador con botones
  − / + para los goles de cada equipo. Toca *Guardar marcador* y la tabla suma
  los puntos sola (el ganador se deriva del marcador). *Sin jugar* lo deja
  pendiente otra vez.
- **Agregar partido:** botón *➕ Agregar partido* (equipos, emojis, grupo, sede, fecha y hora).
- **Editar / eliminar partido:** botones ✏️ y 🗑️ en cada partido.
- **Cerrar o reabrir apuestas** de un partido a mano (🔒 / 🔓), por si quieres
  cerrarlo antes de tiempo.
- **Ajustes:** cambiar el título de la quiniela.
- **Jugadores:** eliminar a alguien creado por error.

---

## 📏 Reglas del juego

- En cada partido eliges **quién gana** (o empate) **y el marcador** (con los
  botones − / +). El ganador se deriva del marcador, así nunca queda
  inconsistente (no puedes poner “gana Portugal” con un marcador de empate).
- Puntos:
  - **Marcador exacto → 3 puntos** 🥇
  - **Solo acertar el resultado** (ganador/empate, marcador equivocado) **→ 1 punto**
- Una vez que envías tu pronóstico, **no se puede cambiar** (te pide confirmación antes).
- Cuando un partido empieza (o cuando le pones el marcador), **se cierran las
  apuestas** y ahí sí se revela quién pronosticó qué.
- La tabla ordena por **puntos** (desempate: más marcadores exactos, luego más
  partidos jugados, luego orden alfabético).

---

## 🔁 Reiniciar la quiniela (empezar de cero)

Borra el archivo de la base de datos y vuelve a arrancar:

```bash
rm quiniela.db quiniela.db-wal quiniela.db-shm
npm start
```

Se vuelven a precargar los 52 partidos y la tabla queda en blanco.

---

## 🛠️ Notas técnicas

- **Sin dependencias externas:** usa los módulos integrados de Node
  (`node:http`, `node:sqlite`). No hay `npm install` que falle.
- `npm start` ejecuta `node run.js`, un pequeño **lanzador** que escoge un Node
  22.5+ automáticamente. Para forzar el Node actual: `npm run start:directo`.
- Toda la info se guarda en **`quiniela.db`** (SQLite, un solo archivo). Respáldalo.
- Cambiar el puerto: `PORT=8080 npm start`.
- Cambiar el PIN sin abrir la app: `ADMIN_PIN=1111 npm start` (solo aplica en una
  base nueva; si ya existe, cámbialo desde **Ajustes**).
- Identidad sin contraseñas: cada celular guarda un **código** propio. Si alguien
  cambia de teléfono, puede entrar con *“Ya tengo un código”* (lo ve en la
  pestaña **Yo → Ver mi código**).

¡Que gane el mejor de la familia! 🏆
