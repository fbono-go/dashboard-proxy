# Dashboard de Mantenimiento — Grupo Oroño

Sistema de dos partes:

- **`dashboard.html`** — el tablero que se muestra en la TV 4K (Chrome pantalla completa).
- **`dashboard-proxy/`** — el servidor (proxy) que habla con Zammad, OpenWeather y Google, y sirve la pantalla de configuración.

---

## 1. Estado de cada módulo

| Módulo | Fuente | Estado |
|--------|--------|--------|
| Gauges (institución, oficiales, a derivar) | Zammad | ✅ Funcionando con datos reales |
| Clima + alerta de tormentas | OpenWeather | ✅ Listo — falta cargar la API key |
| Calendario (hoy + 3 días) | Google Calendar | ⚙️ Listo — falta credenciales OAuth |
| Tareas | Google Tasks | ⚙️ Listo — falta credenciales OAuth |

Cada módulo **se enciende solo** cuando su credencial está cargada en `/config`. Mientras tanto muestra datos de ejemplo, así el dashboard nunca queda roto ni vacío.

---

## 2. Deploy del proxy (Render)

1. Subí el contenido de `dashboard-proxy/` al repo de GitHub `dashboard-proxy`.
2. En Render → el servicio toma el commit → **Manual Deploy** si no lo hace solo.
3. Variables de entorno en Render (**Environment**):
   - `ZAMMAD_TOKEN` = token de Zammad (ya cargado).
   - El resto de las credenciales se cargan desde la pantalla `/config`.

> **Nota sobre persistencia:** en Render free tier, la config que se guarda desde `/config` (selección, escalas, API keys de clima/Google) se borra en cada redeploy de código. El `ZAMMAD_TOKEN` está a salvo porque va como variable de entorno. Tras un redeploy, volvé a `/config` y guardá de nuevo (o cargá las keys como variables de entorno: `OPENWEATHER_KEY`, etc.).

---

## 3. Configuración

Entrá a `https://<tu-proxy>.onrender.com/config` (contraseña por defecto: `12345678`).

Ahí cargás: token de Zammad, API key de OpenWeather + ubicación, credenciales de Google, qué institución/referente/oficiales mostrar, escalas de los gauges y horario del calendario.

---

## 4. Clima (OpenWeather) — rápido

1. Creá una cuenta gratis en https://openweathermap.org/api
2. Copiá tu **API key**.
3. Pegala en `/config` → sección Clima. Ajustá lat/lon si hace falta (Rosario ya viene puesto).

El clima se enciende en el próximo refresco.

---

## 5. Google Calendar + Tasks — instrucciones

Esto necesita crear credenciales OAuth una sola vez. Pasos:

### a) Crear el proyecto y habilitar APIs
1. Entrá a https://console.cloud.google.com
2. Creá un proyecto nuevo (ej. "Dashboard Mantenimiento").
3. En **APIs y servicios → Biblioteca**, habilitá:
   - **Google Calendar API**
   - **Google Tasks API**

### b) Crear las credenciales OAuth
1. **APIs y servicios → Pantalla de consentimiento OAuth** → tipo "Externo" → completá lo mínimo → agregá tu cuenta de Google como usuario de prueba.
2. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente OAuth** → tipo **Aplicación de escritorio**.
3. Guardá el **Client ID** y el **Client Secret**.

### c) Obtener el Refresh Token
La forma más simple, con el **OAuth Playground** de Google:
1. Entrá a https://developers.google.com/oauthplayground
2. Arriba a la derecha (⚙ Settings) → tildá **"Use your own OAuth credentials"** → pegá tu Client ID y Client Secret.
3. En la lista de la izquierda, seleccioná estos scopes:
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/tasks.readonly`
4. **Authorize APIs** → iniciá sesión con la cuenta cuyo calendario/tareas querés mostrar.
5. **Exchange authorization code for tokens** → copiá el **Refresh token**.

### d) Cargar en el dashboard
En `/config` → sección Google, pegá **Client ID**, **Client Secret** y **Refresh Token**. Dejá `Calendar ID` en `primary` (o el ID de otro calendario) y `Task List` en `@default`.

El calendario y las tareas se encienden en el próximo refresco.

---

## 6. La TV

El dashboard ahora se sirve desde el proxy y tiene **URL propia**:

```
https://dashboard-proxy-rx5w.onrender.com/
```

En la TV, abrí esa URL en Chrome a pantalla completa (kiosk). El botón ⚙ **Config** lleva a la pantalla de configuración (en la misma pestaña), y el botón **Volver** regresa al dashboard. El tablero se auto-refresca y se auto-recupera si pierde conexión.

Links útiles:
- Dashboard: `https://dashboard-proxy-rx5w.onrender.com/`
- Configuración: `https://dashboard-proxy-rx5w.onrender.com/config`
- Estado: `https://dashboard-proxy-rx5w.onrender.com/api/health`

> El `dashboard.html` va **dentro del repo del proxy** (el proxy lo sirve). Cuando lo actualices, subilo al repo junto con `server.js`.
