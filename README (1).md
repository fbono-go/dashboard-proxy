# Dashboard de Mantenimiento — Grupo Oroño

Un dashboard por **referente**, cada uno con su institución, sus oficiales, su clima y su cuenta de Google. Todo desde un solo proxy.

- **Dashboard de un referente:** `https://dashboard-proxy-rx5w.onrender.com/?ref=<ID>`
- **Configuración:** `https://dashboard-proxy-rx5w.onrender.com/config?ref=<ID>`

IDs de referente: `321` Franco Bono · `61` Juan Pablo Pioli · `62` Mariana Serrano Oar · `350` Gerardo Sacramone.

Ejemplos:
```
/?ref=321   → dashboard de Franco Bono
/?ref=61    → dashboard de Pioli
```
Cada uno abre en TV, celular o compu — es solo un link.

---

## Cómo funciona la configuración

Hay dos niveles:

**Compartido (una sola vez, afecta a todos):**
- Token de Zammad
- API key de OpenWeather
- Credenciales de la app de Google (Client ID + Client Secret)

**Por referente (cada uno el suyo):**
- Institución del gauge "Tickets totales"
- Oficiales a mostrar
- Escalas de los gauges
- Ubicación del clima y horario del calendario
- Su cuenta de Google (botón "Conectar con Google")

Todo se edita en `/config?ref=<ID>`, protegido con contraseña de admin (por defecto `12345678`).

---

## Conectar Google — ahora es un botón

El referente entra a **su** `/config?ref=<ID>` y toca **"Conectar con Google"**. Inicia sesión con su cuenta, autoriza, y vuelve solo al dashboard con el calendario y las tareas andando. Sin OAuth Playground.

**Requisito previo (una vez), en Google Cloud Console:**
- El cliente OAuth debe ser tipo **Aplicación web**, con URI de redirección:
  `https://dashboard-proxy-rx5w.onrender.com/auth/google/callback`
  y origen JavaScript: `https://dashboard-proxy-rx5w.onrender.com`
- Habilitar **Google Calendar API** y **Google Tasks API**.
- Cada referente que se conecte debe estar como "usuario de prueba" en la pantalla de consentimiento (mientras la app esté en modo prueba).

---

## Puesta en marcha

1. Deploy del proxy en Render. Variables de entorno: `ZAMMAD_TOKEN`, y opcionalmente `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENWEATHER_KEY`.
2. En `/config`: cargar credenciales compartidas (Zammad, OpenWeather, app de Google).
3. Por cada referente: `/config?ref=<ID>` → elegir institución, oficiales, escalas, ubicación → guardar. Y el referente toca "Conectar con Google".

---

## Nota sobre persistencia (Render free tier)

`config.json` se borra en cada **redeploy de código** (no en reinicios). Para que los secretos compartidos sobrevivan siempre, cargalos como variables de entorno. Los perfiles por referente conviene reconfigurarlos tras un redeploy (o migrar a almacenamiento externo más adelante).

---

## Archivos

- `server.js` — proxy (Zammad, clima, Google, config por perfil, OAuth web).
- `dashboard.html` — el tablero (servido desde `/`).
- `config.html` — pantalla de configuración.
- `test.js` — batería de tests (perfiles + OAuth, con APIs simuladas).
