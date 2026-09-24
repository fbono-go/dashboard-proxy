// ============================================================================
//  dashboard-proxy · Proxy exclusivo del Dashboard de Mantenimiento (Grupo Oroño)
//  Separado del proxy de la app: aísla fallas y deploys.
//
//  Solo LECTURA de Zammad y solo CONTEOS → sin fetch de artículos (sin N+1).
//  Endpoints:
//    GET /api/tickets?oficiales=67,66,68&days=30&org=13
//    GET /api/derivar?ref=321&org=13
//    GET /api/health
//    POST /api/recargar-data
//
//  Credenciales: NO hardcodeadas. Salen de config.json (que edita /config más
//  adelante) o de variables de entorno. config.json está en .gitignore.
// ============================================================================
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

// ── Config completa (infra + selección + display). Orden de precedencia:
//    defaults  <  variables de entorno  <  config.json (lo que edita /config)
//    Los secrets vacíos del archivo NO pisan a los de entorno.
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Plantilla de un PERFIL (uno por referente). Cada referente tiene su institución,
// sus oficiales, su ubicación de clima y su propia cuenta de Google.
const PROFILE_DEFAULT = {
  selection: {
    oficiales: [],
    institucionOrg: 13,
    derivarOrg: 13,
    days: 30,
    escala_institucion: 400,
    escala_oficiales: 150,
    escala_derivar: 20,
    tareas_seg_por_tarea: 4       // rueda de tareas del dashboard
  },
  weather: { lat: -32.9468, lon: -60.6393, label: 'Rosario' },
  calendar: { startHour: 6, endHour: 22 },
  google_refresh_token: '',      // se completa cuando el referente hace "Conectar con Google"
  google_calendar_id: 'primary',
  google_tasklist: '@default'
};

// Config COMPARTIDA (no cambia por referente).
const DEFAULTS = {
  zammad_url: 'https://help.gored.com.ar',
  zammad_token: '',
  data_json_url: 'https://fbono-go.github.io/App-Ticket/data.json',
  admin_password: '12345678',
  openweather_key: '',
  // Credenciales de la app de Google (una sola para todos; cada referente autoriza su cuenta)
  google_client: { client_id: '', client_secret: '' },
  // Perfiles por referente, keyed por ref_id. Ej: { "321": {..perfil..} }
  profiles: {},
  // Humor: globos en los gauges y personajes en la barra superior (global)
  humor: null   // se completa con HUMOR_DEFAULT más abajo
};

// ── Humor (compartido por todos los referentes) ──────────────────────────────
// Globos: comentarios que aparecen sobre el gauge de un oficial según sus tickets.
//   cond 'lte' = "baja a" (tickets o menos) · 'gte' = "llega a" (tickets o más)
// Personajes: animación diaria en la barra superior, a una hora y para un referente
//   ('*' = todos), repetida `veces` veces seguidas.
const HUMOR_DEFAULT = {
  activo: true,
  duracion_seg: 5,
  cada_min: 5,
  globos: [
    { activo: true, cond: 'lte', tickets: 75,  texto: 'arranca a hacer el CV 👀' },
    { activo: true, cond: 'gte', tickets: 125, texto: 'quiero ser el empleado de la semana!' },
    { activo: true, cond: 'gte', tickets: 140, texto: 'quiero ser el empleado del mes!' }
  ],
  personajes: {
    salida:   { activo: true, hora: '13:00', ref: '61', veces: 1 },   // se va sin esperar a nadie
    gimnasia: { activo: true, hora: '14:00', ref: '61', veces: 1 },   // gimnasia + bici fija
    cafe:     { activo: true, hora: '12:45', ref: '61', veces: 1 }    // doctor que llega a tomar un café
  }
};
DEFAULTS.humor = HUMOR_DEFAULT;

// Normaliza lo que llega (de /config o de un config.json viejo): nunca confía en el input.
function sanitizarHumor(h) {
  h = (h && typeof h === 'object') ? h : {};
  const entero = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  const hora = (v, def) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim()) ? String(v).trim() : def;
  const globos = (Array.isArray(h.globos) ? h.globos : HUMOR_DEFAULT.globos).slice(0, 20).map(g => ({
    activo: g && g.activo !== false,
    cond: g && g.cond === 'lte' ? 'lte' : 'gte',
    tickets: entero(g && g.tickets, 0, 9999, 0),
    texto: String((g && g.texto) || '').trim().slice(0, 80)
  })).filter(g => g.texto);
  const pj = h.personajes || {};
  const personaje = (p, def) => {
    p = (p && typeof p === 'object') ? p : {};
    return {
      activo: p.activo === undefined ? def.activo : !!p.activo,
      hora: hora(p.hora, def.hora),
      ref: String(p.ref || def.ref).slice(0, 12),
      veces: entero(p.veces, 1, 10, def.veces)
    };
  };
  return {
    activo: h.activo === undefined ? true : !!h.activo,
    duracion_seg: entero(h.duracion_seg, 2, 60, HUMOR_DEFAULT.duracion_seg),
    cada_min: entero(h.cada_min, 1, 120, HUMOR_DEFAULT.cada_min),
    globos,
    personajes: {
      salida:   personaje(pj.salida,   HUMOR_DEFAULT.personajes.salida),
      gimnasia: personaje(pj.gimnasia, HUMOR_DEFAULT.personajes.gimnasia),
      cafe:     personaje(pj.cafe,     HUMOR_DEFAULT.personajes.cafe)
    }
  };
}

// Variables de entorno pisan defaults (y también pisan lo restaurado de GitHub,
// para que rotar un secreto en Render siempre gane).
function aplicarEnv(cfg) {
  if (process.env.ZAMMAD_URL)       cfg.zammad_url = process.env.ZAMMAD_URL;
  if (process.env.ZAMMAD_TOKEN)     cfg.zammad_token = process.env.ZAMMAD_TOKEN;
  if (process.env.DATA_JSON_URL)    cfg.data_json_url = process.env.DATA_JSON_URL;
  if (process.env.OPENWEATHER_KEY)  cfg.openweather_key = process.env.OPENWEATHER_KEY;
  if (process.env.GOOGLE_CLIENT_ID) cfg.google_client.client_id = process.env.GOOGLE_CLIENT_ID;
  if (process.env.GOOGLE_CLIENT_SECRET) cfg.google_client.client_secret = process.env.GOOGLE_CLIENT_SECRET;
}

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  aplicarEnv(cfg);
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      mergeConfig(cfg, file);
    }
  } catch (e) { console.warn('[config] config.json ilegible:', e.message); }
  return cfg;
}

// Merge profundo simple: objetos se combinan, strings vacíos se ignoran.
function mergeConfig(base, incoming) {
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v === '' || v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      mergeConfig(base[k], v);
    } else {
      base[k] = v;
    }
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    return true;
  } catch (e) { console.error('[config] no se pudo guardar:', e.message); return false; }
}

let CONFIG = loadConfig();

// ── Persistencia remota (repo PRIVADO de GitHub) ─────────────────────────────
// Render free tier borra config.json en cada redeploy. Para no recargar nada a
// mano: al guardar, la config se sube a un repo privado; al arrancar, se
// restaura desde ahí. Se activa con dos variables de entorno en Render:
//   GITHUB_TOKEN        → token fine-grained con Contents read/write SOLO en ese repo
//   GITHUB_CONFIG_REPO  → "usuario/repo-privado" (ej: fbono-go/dashboard-config)
const GH = {
  token:  process.env.GITHUB_TOKEN || '',
  repo:   process.env.GITHUB_CONFIG_REPO || '',
  branch: process.env.GITHUB_CONFIG_BRANCH || 'main',
  path:   'config.json'
};
const ghOk = () => !!(GH.token && GH.repo);
const ghUrl = () => `https://api.github.com/repos/${GH.repo}/contents/${GH.path}`;
const ghHeaders = () => ({
  'Authorization': 'Bearer ' + GH.token,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'dashboard-proxy'          // GitHub API lo exige
});

// Al arrancar: restaurar la última config guardada (si existe).
async function cargarConfigRemota() {
  if (!ghOk()) return false;
  try {
    const r = await fetch(`${ghUrl()}?ref=${GH.branch}`, { headers: ghHeaders() });
    if (r.status === 404) { console.log('[config-remota] aún no hay config en GitHub'); return false; }
    if (!r.ok) throw new Error('GitHub HTTP ' + r.status);
    const d = await r.json();
    const json = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
    mergeConfig(CONFIG, json);
    aplicarEnv(CONFIG);          // los secretos de Render siempre ganan
    saveConfig();                // copia local para lecturas sync
    console.log('[config-remota] restaurada desde GitHub ✓');
    return true;
  } catch (e) { console.warn('[config-remota] no se pudo cargar:', e.message); return false; }
}

// Al guardar: subir la config al repo (necesita el sha actual si el archivo existe).
async function guardarConfigRemota() {
  if (!ghOk()) return false;
  try {
    let sha;
    const g = await fetch(`${ghUrl()}?ref=${GH.branch}`, { headers: ghHeaders() });
    if (g.ok) sha = (await g.json()).sha;
    const body = {
      message: 'Actualización de configuración del dashboard',
      branch: GH.branch,
      content: Buffer.from(JSON.stringify(CONFIG, null, 2)).toString('base64')
    };
    if (sha) body.sha = sha;
    const r = await fetch(ghUrl(), { method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('GitHub HTTP ' + r.status);
    return true;
  } catch (e) { console.warn('[config-remota] no se pudo guardar:', e.message); return false; }
}

// Guardado completo: local (rápido) + remoto (persistente entre redeploys).
async function persistConfig() {
  const local = saveConfig();
  const remoto = await guardarConfigRemota();
  return { local, remoto };
}

// Devuelve el perfil de un referente; lo crea con defaults si no existe (auto-provisión).
function getProfile(ref) {
  ref = String(ref || '');
  if (!ref) ref = String(defaultRef());
  if (!CONFIG.profiles[ref]) {
    CONFIG.profiles[ref] = JSON.parse(JSON.stringify(PROFILE_DEFAULT));
  }
  return CONFIG.profiles[ref];
}
// Referente por defecto: el primero de la lista de referentes conocidos.
function defaultRef() {
  return (REFERENTES[0] && REFERENTES[0].id) || 321;
}

const HEADERS = () => ({ 'Authorization': 'Token token=' + CONFIG.zammad_token, 'Content-Type': 'application/json' });

// ── Zona horaria ──────────────────────────────────────────────────────────────
// El servidor (Render) corre en UTC; los horarios del dashboard son de Argentina.
// NUNCA usar getHours()/setHours() del servidor para horas de eventos: la hora
// local se parsea del string que devuelve Google (pidiendo timeZone en la query).
const TZ_DEFAULT = 'America/Argentina/Cordoba';   // Rosario · UTC-3, sin horario de verano

// "YYYY-MM-DD" de hoy en la zona dada (en-CA formatea exactamente así)
function fechaLocalHoy(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
// Offset RFC3339 de la zona, ej. "-03:00" (para armar timeMin/timeMax)
function offsetDeZona(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date());
  const v = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT+00:00';
  const off = v.replace('GMT', '');
  return off === '' ? '+00:00' : off;
}
// Días de diferencia entre dos "YYYY-MM-DD" (b - a)
function diasEntre(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
// Suma días a un "YYYY-MM-DD"
function sumarDias(iso, n) { return new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10); }

// Estados Zammad (lógica fija de la instancia): 1=nuevo, 2=abierto, 4=cerrado
const STATE_ABIERTOS = '(state_id:1 OR state_id:2)';

// Abreviaturas de institución para el gauge (más cortas que el nombre completo)
const ABREV = { 14:'DMO', 138:'GOG', 33:'GO', 13:'ICR', 132:'SAME', 15:'SN', 12:'SP' };
function nombreInstGauge(org) {
  return `Tickets totales ${ABREV[org] || INSTITUCIONES[org] || org}`;
}

// ── Fuente de verdad: data.json ──────────────────────────────────────────────
// Se intenta bajar de GitHub Pages; si no está accesible (repo privado, Pages caído),
// se usa esta copia embebida con los datos reales. Así el proxy NUNCA queda sin datos.
const DATA_EMBEBIDO = {
  sectores: [
    { sector_id: 1, letra: 'A', ref_id: 61,  ref: 'Juan Pablo Pioli' },
    { sector_id: 2, letra: 'B', ref_id: 321, ref: 'Franco Bono' },
    { sector_id: 3, letra: 'C', ref_id: 62,  ref: 'Mariana Serrano Oar' },
    { sector_id: 6, letra: 'E', ref_id: 350, ref: 'Gerardo Sacramone' }
  ],
  referentes_historicos: [
    { id: 40, nombre: 'Simon Villavicencio' }, { id: 59, nombre: 'Soledad Del Cerro' },
    { id: 60, nombre: 'Andrés Haugh' }, { id: 41, nombre: 'Pedidos Grupo Oroño' }
  ],
  usuarios_derivables: [
    { id: 67, nombre: 'Elio Molina', tipo: 'Oficial' },
    { id: 66, nombre: 'Carlos Carranza', tipo: 'Oficial' },
    { id: 68, nombre: 'Fausto Casco', tipo: 'Oficial' },
    { id: 64, nombre: 'Agustín Gentiletti', tipo: 'Oficial' },
    { id: 65, nombre: 'Damián Benítez', tipo: 'Oficial' },
    { id: 69, nombre: 'Claudio Rojas', tipo: 'Oficial' },
    { id: 70, nombre: 'Ramón Carballo', tipo: 'Oficial' },
    { id: 71, nombre: 'Gabriel Moreno', tipo: 'Oficial' },
    { id: 72, nombre: 'Néstor Bacaro', tipo: 'Oficial' },
    { id: 74, nombre: 'Gutierrez Elias', tipo: 'Oficial' },
    { id: 75, nombre: 'Gustavo Salinas', tipo: 'Oficial' },
    { id: 77, nombre: 'Rodrigo Buitron', tipo: 'Oficial' },
    { id: 79, nombre: 'Emiliano Godoy', tipo: 'Oficial' },
    { id: 141, nombre: 'Martin Galuppo', tipo: 'Oficial' },
    { id: 245, nombre: 'Brandon Villalba', tipo: 'Oficial' },
    { id: 59, nombre: 'Soledad Del Cerro Hoteleria', tipo: 'Oficial' }
  ],
  instituciones: [
    { v: '14', t: 'Diagnóstico Médico Oroño' }, { v: '138', t: 'GO Gastro' },
    { v: '33', t: 'Grupo Oroño' }, { v: '13', t: 'Instituto Cardiovascular Rosario' },
    { v: '132', t: 'MEDICINA ESENCIAL SA' }, { v: '15', t: 'Sanatorio de Niños' },
    { v: '12', t: 'Sanatorio Parque' }
  ]
};

let OWNERS        = {};
let INSTITUCIONES = {};
let REFERENTES    = [];  // [{id, nombre}] para el dropdown de "a derivar"
let OFICIALES     = [];  // [{id, nombre}] para los checkboxes de oficiales

function aplicarData(data) {
  // Owners: referentes (sectores), históricos y usuarios derivables
  const owners = {};
  (data.sectores || []).forEach(s => { if (s.ref_id) owners[s.ref_id] = s.ref; });
  (data.referentes_historicos || []).forEach(r => { owners[r.id] = r.nombre; });
  (data.usuarios_derivables || []).forEach(u => { owners[u.id] = u.nombre; });
  if (Object.keys(owners).length) OWNERS = owners;

  // Referentes (para dropdown "a derivar") desde sectores
  const refs = (data.sectores || []).filter(s => s.ref_id).map(s => ({ id: s.ref_id, nombre: s.ref }));
  if (refs.length) REFERENTES = refs;

  // Oficiales (para checkboxes) desde usuarios_derivables con tipo Oficial
  const ofs = (data.usuarios_derivables || []).filter(u => u.tipo === 'Oficial').map(u => ({ id: u.id, nombre: u.nombre }));
  if (ofs.length) OFICIALES = ofs;

  // Instituciones: data.json usa {v, t} donde v es string → convertir a int como clave
  const inst = {};
  (data.instituciones || []).forEach(i => {
    const id = parseInt(i.v || i.id);
    const nombre = i.t || i.abrev || i.abreviatura || i.nombre;
    if (id && nombre) inst[id] = nombre;
  });
  if (Object.keys(inst).length) INSTITUCIONES = inst;
}

// Aplicar el embebido de entrada (garantiza datos aunque GitHub Pages no responda)
aplicarData(DATA_EMBEBIDO);

async function cargarDataJson() {
  try {
    const r = await fetch(CONFIG.data_json_url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    aplicarData(await r.json());
    console.log(`[data.json] OK · owners=${Object.keys(OWNERS).length} · instituciones=${Object.keys(INSTITUCIONES).length}`);
  } catch (e) {
    console.log('[data.json] no se pudo cargar (' + e.message + ') → uso valores previos/fallback');
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(compression());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Helpers de Zammad ────────────────────────────────────────────────────────
async function zammadSearch(query, perPage) {
  const url = `${CONFIG.zammad_url}/api/v1/tickets/search?query=${encodeURIComponent(query)}&page=1&per_page=${perPage}`;
  const r = await fetch(url, { headers: HEADERS() });
  if (!r.ok) throw new Error('Zammad HTTP ' + r.status + ' en query: ' + query);
  return r.json();
}

// Conteo puro y barato: per_page=1 y leemos tickets_count (total real del match).
// NOTA: tickets_count en Zammad es confiable para queries simples sobre campos indexados
// como owner_id, state_id, close_at. Para created_at y organization_id puede fallar
// → usamos searchAllCount que pagina y cuenta tickets reales.
async function countTickets(query) {
  const d = await zammadSearch(query, 1);
  if (typeof d.tickets_count === 'number' && d.tickets_count > 0) return d.tickets_count;
  // fallback: si tickets_count no es confiable, contar los ids devueltos
  if (Array.isArray(d.tickets)) return d.tickets.length;
  return 0;
}

// Conteo paginado — IDÉNTICO al searchAll probado del proxy de la app.
// Cuenta tickets hidratados desde assets.Ticket y corta por esa longitud,
// exactamente como el reporte que funciona bien en producción.
async function searchAllCount(query) {
  const perPage = 200;
  let page = 1, total = 0;
  while (true) {
    const url = `${CONFIG.zammad_url}/api/v1/tickets/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
    const r = await fetch(url, { headers: HEADERS() });
    if (!r.ok) throw new Error('Zammad HTTP ' + r.status);
    const d = await r.json();
    const assetTickets = (d.assets && d.assets.Ticket) ? d.assets.Ticket : {};
    const ids = Array.isArray(d.tickets) ? d.tickets : [];
    const tickets = ids.map(id => assetTickets[id]).filter(Boolean);
    total += tickets.length;
    if (tickets.length < perPage) break;   // corta igual que el reporte probado
    if (total >= 5000) break;              // tope de seguridad
    page++;
  }
  return total;
}

// Vencidos = patrón PROBADO del proxy de la app: traer abiertos y filtrar en JS
// por escalation_at < ahora. (La API de Zammad no compara datetime de forma
// confiable en el query string; esto es lo que ya funciona en producción.)
async function countVencidos(baseQuery) {
  const perPage = 200;
  let page = 1, vencidos = 0;
  const ahora = Date.now();
  while (true) {
    const url = `${CONFIG.zammad_url}/api/v1/tickets/search?query=${encodeURIComponent(baseQuery + ' AND ' + STATE_ABIERTOS)}&page=${page}&per_page=${perPage}`;
    const r = await fetch(url, { headers: HEADERS() });
    if (!r.ok) throw new Error('Zammad HTTP ' + r.status);
    const d = await r.json();
    const assets = (d.assets && d.assets.Ticket) || {};
    const ids = Array.isArray(d.tickets) ? d.tickets : [];
    const tickets = ids.map(id => assets[id]).filter(Boolean);
    for (const t of tickets) {
      if (t.escalation_at && new Date(t.escalation_at).getTime() < ahora) vencidos++;
    }
    if (tickets.length < perPage) break;
    if (page >= 25) break; // tope de seguridad (5000)
    page++;
  }
  return vencidos;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// GET /api/tickets?ref=321   (usa el perfil del referente; params opcionales lo pisan)
// Devuelve: gauge de institución ("tickets totales") + un gauge por oficial.
app.get('/api/tickets', async (req, res) => {
  try {
    const prof = getProfile(req.query.ref);
    const sel = prof.selection || {};
    const days = parseInt(req.query.days || sel.days || '30');
    const org  = parseInt(req.query.org || sel.institucionOrg || '13');
    const oficiales = (req.query.oficiales
      ? req.query.oficiales.split(',').map(x => parseInt(x.trim())).filter(Boolean)
      : (sel.oficiales || []));
    const desdeIso = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

    const [instTotal, instVencidos] = await Promise.all([
      searchAllCount(`facility:${org} AND created_at:>${desdeIso}`),
      countVencidos(`facility:${org}`)
    ]);

    const oficialesData = await Promise.all(oficiales.map(async id => {
      const [cerrados, vencidos] = await Promise.all([
        searchAllCount(`owner_id:${id} AND state_id:4 AND close_at:>${desdeIso}`),
        countVencidos(`owner_id:${id}`)
      ]);
      return { owner_id: id, nombre: OWNERS[id] || ('Agente ' + id), cerrados, vencidos_hoy: vencidos };
    }));

    res.json({
      generado_en: new Date().toISOString(),
      periodo_dias: days,
      institucion: { org_id: org, nombre: nombreInstGauge(org), total: instTotal, vencidos_hoy: instVencidos },
      oficiales: oficialesData
    });
  } catch (e) {
    console.error('/api/tickets', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/derivar?ref=321   (el referente ES el ref; la institución sale de su perfil)
app.get('/api/derivar', async (req, res) => {
  try {
    const refId = parseInt(req.query.ref || defaultRef());
    const prof = getProfile(refId);
    const org = parseInt(req.query.org || (prof.selection && prof.selection.derivarOrg) || prof.selection.institucionOrg);
    if (!refId || !org) return res.status(400).json({ error: 'Faltan parámetros ref y org' });

    const count = await searchAllCount(`owner_id:${refId} AND facility:${org} AND state_id:1`);

    res.json({
      generado_en: new Date().toISOString(),
      ref_id: refId, referente: OWNERS[refId] || ('Agente ' + refId),
      org_id: org, institucion: ABREV[org] || INSTITUCIONES[org] || String(org),
      count
    });
  } catch (e) {
    console.error('/api/derivar', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Configuración ────────────────────────────────────────────────────────────
// Vista PÚBLICA de un perfil (la que consume el dashboard): sin secrets.
function configPublica(ref) {
  const prof = getProfile(ref);
  return {
    ref: String(ref || defaultRef()),
    referente: OWNERS[ref] || OWNERS[defaultRef()] || '',
    selection: prof.selection,
    calendar: prof.calendar,
    weather: prof.weather,
    google: { calendar_id: prof.google_calendar_id, tasklist: prof.google_tasklist },
    humor: sanitizarHumor(CONFIG.humor),   // global: igual para todos los referentes
    flags: {
      zammad_token_set: !!CONFIG.zammad_token,
      openweather_key_set: !!CONFIG.openweather_key,
      google_app_set: !!(CONFIG.google_client.client_id && CONFIG.google_client.client_secret),
      google_connected: !!prof.google_refresh_token   // ¿este referente ya conectó su Google?
    }
  };
}

// GET /api/config?ref=321 → config del perfil de ese referente.
app.get('/api/config', (req, res) => res.json(configPublica(req.query.ref)));

// Listas para poblar los dropdowns del admin (instituciones, referentes, oficiales).
app.get('/api/opciones', (req, res) => {
  res.json({
    instituciones: Object.entries(INSTITUCIONES).map(([id, nombre]) => ({ id: parseInt(id), nombre, abrev: ABREV[id] || nombre })),
    referentes: REFERENTES,
    oficiales: OFICIALES
  });
});

// POST /api/config?ref=321 → guarda el perfil del referente. Requiere contraseña.
app.post('/api/config', async (req, res) => {
  const body = req.body || {};
  if (body.password !== CONFIG.admin_password) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  delete body.password;
  const ref = String(req.query.ref || body.ref || defaultRef());
  delete body.ref;

  // Campos compartidos (si vienen) van al nivel raíz; el resto, al perfil.
  const compartidos = {};
  ['zammad_url','zammad_token','openweather_key','google_client'].forEach(k => {
    if (body[k] !== undefined) { compartidos[k] = body[k]; delete body[k]; }
  });
  if (Object.keys(compartidos).length) mergeConfig(CONFIG, compartidos);

  // Humor se REEMPLAZA entero (no merge): si se borró un globo, tiene que desaparecer.
  if (body.humor !== undefined) { CONFIG.humor = sanitizarHumor(body.humor); delete body.humor; }

  const prof = getProfile(ref);
  mergeConfig(prof, body);          // selection/weather/calendar/google_* del perfil
  const p = await persistConfig();
  res.json({ ok: p.local, persistencia_remota: p.remoto, guardado: configPublica(ref) });
});

// Cambiar la contraseña de admin.
app.post('/api/config/password', async (req, res) => {
  const { password, nueva } = req.body || {};
  if (password !== CONFIG.admin_password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  if (!nueva || String(nueva).length < 4) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });
  CONFIG.admin_password = String(nueva);
  const p = await persistConfig();
  res.json({ ok: p.local, persistencia_remota: p.remoto });
});

// Servir la pantalla de configuración.
app.get('/config', (req, res) => res.sendFile(path.join(__dirname, 'config.html')));

// ── Clima (OpenWeather) ──────────────────────────────────────────────────────
// Mapea el código de clima de OpenWeather a un emoji.
function iconoClima(id, esNoche) {
  if (id >= 200 && id < 300) return '⛈️';          // tormenta
  if (id >= 300 && id < 400) return '🌦️';          // llovizna
  if (id >= 500 && id < 600) return '🌧️';          // lluvia
  if (id >= 600 && id < 700) return '🌨️';          // nieve
  if (id >= 700 && id < 800) return '🌫️';          // niebla
  if (id === 800) return esNoche ? '🌙' : '☀️';    // despejado
  if (id === 801) return esNoche ? '☁️' : '🌤️';    // pocas nubes
  return '☁️';                                       // nublado
}

app.get('/api/clima', async (req, res) => {
  try {
    if (!CONFIG.openweather_key) return res.status(400).json({ error: 'Falta la API key de OpenWeather (cargala en /config)' });
    const prof = getProfile(req.query.ref);
    const { lat, lon, label } = prof.weather || {};
    const base = 'https://api.openweathermap.org/data/2.5';
    const qs = `lat=${lat}&lon=${lon}&appid=${CONFIG.openweather_key}&units=metric&lang=es`;

    // Clima actual + pronóstico (para avisar tormentas próximas)
    const [rNow, rFc] = await Promise.all([
      fetch(`${base}/weather?${qs}`),
      fetch(`${base}/forecast?${qs}&cnt=8`) // próximas ~24 h (8 tramos de 3 h)
    ]);
    if (!rNow.ok) throw new Error('OpenWeather HTTP ' + rNow.status);
    const now = await rNow.json();
    const fc = rFc.ok ? await rFc.json() : { list: [] };

    const w0 = (now.weather && now.weather[0]) || {};
    const esNoche = now.dt < now.sys?.sunrise || now.dt > now.sys?.sunset;
    // ¿tormenta ahora o en las próximas horas? (códigos 2xx = thunderstorm)
    const tormentaAhora = w0.id >= 200 && w0.id < 300;
    const tormentaProx = (fc.list || []).some(f => (f.weather && f.weather[0] && f.weather[0].id >= 200 && f.weather[0].id < 300));

    res.json({
      tempC: Math.round(now.main?.temp ?? 0),
      cond: (w0.description || '').replace(/^\w/, c => c.toUpperCase()),
      icon: iconoClima(w0.id || 800, esNoche),
      storm: tormentaAhora || tormentaProx,
      label: label || now.name || '',
      generado_en: new Date().toISOString()
    });
  } catch (e) {
    console.error('/api/clima', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Calendar + Tasks (OAuth web "Conectar con Google") ────────────────
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks.readonly'
].join(' ');
const REDIRECT_URI = () =>
  (process.env.PUBLIC_URL || 'https://dashboard-proxy-rx5w.onrender.com') + '/auth/google/callback';

function googleAppOk() {
  const g = CONFIG.google_client || {};
  return !!(g.client_id && g.client_secret);
}
function googleConnected(prof) {
  return !!(googleAppOk() && prof.google_refresh_token);
}
// Intercambia el refresh_token del perfil por un access_token temporal.
async function googleAccessToken(prof) {
  const body = new URLSearchParams({
    client_id: CONFIG.google_client.client_id,
    client_secret: CONFIG.google_client.client_secret,
    refresh_token: prof.google_refresh_token,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (!r.ok) throw new Error('Google OAuth HTTP ' + r.status);
  const d = await r.json();
  if (!d.access_token) throw new Error('Google no devolvió access_token');
  return d.access_token;
}

// 1) El referente toca "Conectar con Google" → lo mandamos al consentimiento de Google.
app.get('/auth/google', (req, res) => {
  if (!googleAppOk()) return res.status(400).send('Falta cargar las credenciales de la app de Google en /config (Client ID y Secret).');
  const ref = String(req.query.ref || defaultRef());
  const params = new URLSearchParams({
    client_id: CONFIG.google_client.client_id,
    redirect_uri: REDIRECT_URI(),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',      // para recibir refresh_token
    prompt: 'consent',           // fuerza refresh_token aunque ya haya autorizado antes
    state: ref                   // llevamos el ref para saber a qué perfil guardar
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// 2) Google vuelve acá con el code → lo canjeamos por refresh_token y lo guardamos en el perfil.
app.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const ref = String(req.query.state || defaultRef());
    if (!code) throw new Error('Falta el code de Google');
    const body = new URLSearchParams({
      code,
      client_id: CONFIG.google_client.client_id,
      client_secret: CONFIG.google_client.client_secret,
      redirect_uri: REDIRECT_URI(),
      grant_type: 'authorization_code'
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const d = await r.json();
    if (!r.ok || !d.refresh_token) {
      throw new Error('Google no devolvió refresh_token (' + (d.error || r.status) + '). Probá de nuevo desde Config.');
    }
    const prof = getProfile(ref);
    prof.google_refresh_token = d.refresh_token;
    await persistConfig();     // la conexión de Google es lo que más duele perder en un redeploy
    // Volvemos a la config del referente con un aviso de éxito.
    res.redirect(`/config?ref=${encodeURIComponent(ref)}&google=ok`);
  } catch (e) {
    console.error('/auth/google/callback', e.message);
    res.status(500).send('Error conectando con Google: ' + e.message + '. <a href="/config">Volver</a>');
  }
});

// Desconectar Google de un perfil.
app.post('/auth/google/disconnect', async (req, res) => {
  const { password } = req.body || {};
  if (password !== CONFIG.admin_password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const ref = String(req.query.ref || req.body.ref || defaultRef());
  getProfile(ref).google_refresh_token = '';
  await persistConfig();
  res.json({ ok: true });
});

// GET /api/calendario?ref=321 → eventos de hoy + 3 días del calendario del referente.
app.get('/api/calendario', async (req, res) => {
  try {
    const prof = getProfile(req.query.ref);
    if (!googleConnected(prof)) return res.status(400).json({ error: 'Google no conectado para este referente' });
    const token = await googleAccessToken(prof);
    const tz = prof.tz || TZ_DEFAULT;
    const hoyStr = fechaLocalHoy(tz);              // "YYYY-MM-DD" en Argentina, no en UTC
    const off = offsetDeZona(tz);                  // "-03:00"
    const calId = encodeURIComponent(prof.google_calendar_id || 'primary');

    // 1) Color por defecto del calendario (los eventos sin colorId lo heredan).
    let calColor = null;
    try {
      const rCal = await fetch(`https://www.googleapis.com/calendar/v3/users/me/calendarList/${calId}`,
        { headers: { Authorization: 'Bearer ' + token } });
      if (rCal.ok) { const dCal = await rCal.json(); calColor = dCal.backgroundColor || null; }
    } catch (_) { /* si falla, usamos fallback */ }

    // 2) Eventos: timeMin/timeMax en medianoche LOCAL, y timeZone= para que Google
    //    devuelva los dateTime ya convertidos a la zona del dashboard.
    const timeMin = encodeURIComponent(`${hoyStr}T00:00:00${off}`);
    const timeMax = encodeURIComponent(`${sumarDias(hoyStr, 4)}T00:00:00${off}`);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`
      + `?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=50&timeZone=${encodeURIComponent(tz)}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Calendar API HTTP ' + r.status);
    const d = await r.json();

    // Paleta MODERNA de Google Calendar (la que se ve en la UI) por colorId 1-11.
    const GCal_COLORS = {
      '1':'#7986cb',  // Lavanda
      '2':'#33b679',  // Salvia
      '3':'#8e24aa',  // Uva
      '4':'#e67c73',  // Flamenco
      '5':'#f6bf26',  // Banana
      '6':'#f4511e',  // Mandarina
      '7':'#039be5',  // Pavo real
      '8':'#616161',  // Grafito
      '9':'#3f51b5',  // Arándano
      '10':'#0b8043', // Albahaca
      '11':'#d50000'  // Tomate
    };
    const FALLBACK = '#1976d2';

    // Los colores de calendarList suelen venir en versión pastel (muy claros para
    // texto blanco). Si el color es demasiado luminoso, se oscurece hacia su tono
    // profundo — el celeste lavado tira a azul marino, el rosa pálido a bordó, etc.
    function legible(hex) {
      if (!/^#?[0-9a-fA-F]{6}$/.test(hex || '')) return hex;
      const h = hex.replace('#', '');
      let r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;   // luminancia percibida 0-255
      if (lum <= 165) return '#' + h;                      // ya es oscuro → se respeta tal cual
      // Oscurecer proporcionalmente manteniendo el tono (target ~luminancia 110)
      const k = 110 / lum;
      r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k);
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    const eventos = [];
    (d.items || []).forEach(ev => {
      if (!ev.start || !ev.start.dateTime) return;
      // La hora se parsea DEL STRING (viene en la zona pedida) — jamás getHours() del servidor.
      const s = ev.start.dateTime, e = ev.end.dateTime;           // "2026-07-06T12:30:00-03:00"
      const sFecha = s.slice(0, 10), eFecha = e.slice(0, 10);
      const day = diasEntre(hoyStr, sFecha);
      if (day < 0 || day > 3) return;
      const start = parseInt(s.slice(11, 13)) + parseInt(s.slice(14, 16)) / 60;
      let end = parseInt(e.slice(11, 13)) + parseInt(e.slice(14, 16)) / 60;
      if (eFecha !== sFecha) end = 24;                            // cruza medianoche → recortar al día
      const color = legible(GCal_COLORS[ev.colorId] || calColor || FALLBACK);
      eventos.push({ day, start, end, title: ev.summary || '(sin título)', color });
    });
    res.json(eventos);
  } catch (e) {
    console.error('/api/calendario', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tareas?ref=321 → tareas del referente, con estado derivado de la fecha.
app.get('/api/tareas', async (req, res) => {
  try {
    const prof = getProfile(req.query.ref);
    if (!googleConnected(prof)) return res.status(400).json({ error: 'Google no conectado para este referente' });
    const token = await googleAccessToken(prof);
    const lista = encodeURIComponent(prof.google_tasklist || '@default');
    const url = `https://tasks.googleapis.com/tasks/v1/lists/${lista}/tasks?showCompleted=true&maxResults=50`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Tasks API HTTP ' + r.status);
    const d = await r.json();
    // "Hoy" en la zona del dashboard, no en la del servidor (UTC en Render).
    // El due de Google Tasks es fecha pura ("2026-07-06T00:00:00.000Z") → se
    // compara por string de fecha, sin pasar por Date/setHours del servidor.
    const hoyStr = fechaLocalHoy(prof.tz || TZ_DEFAULT);
    const tareas = (d.items || []).map(t => {
      let due = 'soon';
      if (t.status === 'completed') due = 'done';
      else if (t.due) {
        const dueStr = t.due.slice(0, 10);
        if (dueStr === hoyStr) due = 'today';
        else if (dueStr < hoyStr) due = 'overdue';
      }
      return { title: t.title || '(sin título)', due };
    }).filter(t => t.title.trim());
    res.json(tareas);
  } catch (e) {
    console.error('/api/tareas', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Preventivo: estado por proveedor ─────────────────────────────────────────
// Lee del proxy de la app (gored-proxy), que es el dueño de los datos del
// preventivo. Acá solo se cuenta: no se escribe nada.
const PREV_URL = process.env.PREVENTIVO_URL || 'https://gored-proxy-ov5y.onrender.com/api/preventivo';
const PREV_TTL_MS = 10 * 60 * 1000;      // la barra no necesita más frescura que esto
const PREV_TIMEOUT_MS = 90 * 1000;       // gored-proxy puede estar despertando (Render free)
const prevCache = new Map();             // org → { t, data }
const prevEnCurso = new Map();           // org → promesa (evita pedidos duplicados)

// Misma regla de colores que la app (preventivo-ui.js) y el panel
// (panel-preventivo.html). Si cambia, cambiar en los tres.
//   gris: nunca tuvo un preventivo · rojo: vencido · naranja: 0 a 7 días
//   amarillo: 8 a 14 días · verde: 15 días o más
function estadoPreventivo(e) {
  if (e.semaforo === 'gris' || !e.ultimo_preventivo) return 'gris';
  const d = e.dias_restantes;
  if (typeof d !== 'number' || !isFinite(d)) return 'gris';
  if (d < 0) return 'rojo';
  if (d <= 7) return 'naranja';
  if (d <= 14) return 'amarillo';
  return 'verde';
}

async function prevGet(ruta) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PREV_TIMEOUT_MS);
  try {
    const r = await fetch(PREV_URL + ruta, { signal: ctrl.signal });
    if (!r.ok) throw new Error('preventivo HTTP ' + r.status + ' en ' + ruta);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function armarPreventivo(org) {
  // Los proveedores salen del catálogo de tipos: cambiar de contrato es tocar una
  // celda de la planilla, y el dashboard lo toma solo.
  const tipos = await prevGet('/tipos');
  const lista = Array.isArray(tipos) ? tipos : (tipos.tipos || []);
  const claves = [...new Set(lista
    .map(t => String(t.proveedor_actual || '').trim().toLowerCase())
    .filter(Boolean))];
  const responsables = claves.map(c => ({ clave: c, nombre: c.charAt(0).toUpperCase() + c.slice(1) }));

  const vacia = (clave, nombre) => ({ clave, nombre, total: 0, rojo: 0, naranja: 0, amarillo: 0, verde: 0, gris: 0 });

  // Proveedores: una barra por empresa.
  const filasProv = await Promise.all(responsables.map(async (p) => {
    const s = await prevGet(`/semaforo?institucion=${org}&responsable=${encodeURIComponent(p.clave)}`);
    // `atencion` trae todo lo que no está en verde según el servidor; lo que
    // falta más de 30 días viene solo contado en totales.verde.
    const f = vacia(p.clave, p.nombre);
    f.total = s.total || 0;
    f.verde = (s.totales && s.totales.verde) || 0;
    (s.atencion || []).forEach(e => { f[estadoPreventivo(e)]++; });
    return f;
  }));

  // Mantenimiento propio: una barra por tipo de equipo ("ICR - Sillas de ruedas"),
  // porque mezclar sillas, camillas y ascensores en una sola no dice nada.
  // Se usa el inventario (trae cada equipo con su estado) para poder separar por tipo.
  const nombreTipo = new Map(lista.map(t => [String(t.tipo_id || '').trim(), String(t.nombre || '').trim()]));
  const sigla = ABREV[org] || INSTITUCIONES[org] || ('Inst. ' + org);
  const inv = await prevGet(`/inventario?institucion=${org}&responsable=oficial`);
  const porTipo = new Map();
  (inv.equipos || []).forEach(e => {
    const tipo = String(e.tipo || '').trim();
    if (!porTipo.has(tipo)) {
      const nom = nombreTipo.get(tipo) || tipo.replace(/_/g, ' ') || 'Sin tipo';
      porTipo.set(tipo, vacia('oficial:' + tipo, `${sigla} - ${nom}`));
    }
    const f = porTipo.get(tipo);
    f.total++;
    f[estadoPreventivo(e)]++;
  });

  const filas = filasProv.concat([...porTipo.values()]);

  return {
    generado_en: new Date().toISOString(),
    institucion: { org_id: org, nombre: nombreInstGauge(org) },
    // solo quien tiene equipos en esta institución; el más comprometido primero
    proveedores: filas.filter(p => p.total > 0)
      .sort((a, b) => (b.rojo - a.rojo) || (b.naranja - a.naranja) || (b.total - a.total))
  };
}

// GET /api/preventivo?ref=321  (la institución sale del perfil del referente)
// Si hay un dato guardado se responde al instante y, si está viejo, se refresca
// por detrás: la TV nunca espera a que gored-proxy despierte.
app.get('/api/preventivo', async (req, res) => {
  const prof = getProfile(req.query.ref);
  const sel = prof.selection || {};
  const org = parseInt(req.query.org || sel.institucionOrg || '13');
  const guardado = prevCache.get(org);
  const fresco = guardado && (Date.now() - guardado.t) < PREV_TTL_MS;

  if (!fresco && !prevEnCurso.has(org)) {
    const p = armarPreventivo(org)
      .then(data => { prevCache.set(org, { t: Date.now(), data }); return data; })
      .finally(() => prevEnCurso.delete(org));
    p.catch(e => console.error('/api/preventivo', e.message));
    prevEnCurso.set(org, p);
  }

  if (guardado) return res.json(Object.assign({}, guardado.data, { en_cache: !fresco }));
  try {
    res.json(await prevEnCurso.get(org));
  } catch (e) {
    res.status(502).json({ error: 'No se pudo leer el preventivo: ' + e.message });
  }
});

// Salud del proxy (para el watchdog del dashboard y para chequear config).
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    zammad_url: CONFIG.zammad_url,
    token_cargado: !!CONFIG.zammad_token,
    persistencia_github: ghOk(),          // ¿la config sobrevive redeploys?
    owners: Object.keys(OWNERS).length,
    instituciones: Object.keys(INSTITUCIONES).length,
    ts: new Date().toISOString()
  });
});

// Forzar recarga de data.json (tras editar el archivo en el repo).
app.post('/api/recargar-data', async (req, res) => {
  await cargarDataJson();
  res.json({ ok: true, owners: Object.keys(OWNERS).length, instituciones: Object.keys(INSTITUCIONES).length });
});

// El dashboard se sirve desde la raíz → tiene URL propia (la TV apunta acá).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ── Páginas legales (las exige Google para publicar la pantalla de consentimiento OAuth) ──
const CONTACTO_LEGAL = 'fbono@grupoorono.com.ar';
function paginaLegal(titulo, cuerpoHtml) {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + titulo + ' · Dashboard Mantenimiento</title>'
    + '<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#1f2937}'
    + 'h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.6em}a{color:#0b5fff}</style></head><body>'
    + '<h1>' + titulo + '</h1>' + cuerpoHtml
    + '<p><small>Última actualización: septiembre de 2026 · <a href="/">Volver al dashboard</a></small></p>'
    + '</body></html>';
}

app.get('/privacy', (req, res) => {
  res.type('html').send(paginaLegal('Política de privacidad',
    '<p>Dashboard Mantenimiento es una herramienta interna de Grupo Oroño (Rosario, Argentina) que muestra en pantalla el estado de los tickets de mantenimiento, el calendario y las tareas de cada referente.</p>'
    + '<h2>Qué datos de Google usamos</h2>'
    + '<p>Solo si el referente toca <b>"Conectar con Google"</b> y lo autoriza, la aplicación solicita acceso de <b>solo lectura</b> a:</p>'
    + '<ul><li>Google Calendar (<code>calendar.readonly</code>): eventos del calendario del propio usuario.</li>'
    + '<li>Google Tasks (<code>tasks.readonly</code>): tareas del propio usuario.</li></ul>'
    + '<h2>Para qué los usamos</h2>'
    + '<p>Únicamente para mostrar esos eventos y tareas en el dashboard del propio usuario. No modificamos ni borramos nada en su cuenta de Google.</p>'
    + '<h2>Qué guardamos</h2>'
    + '<p>Guardamos un token de actualización (refresh token) asociado al perfil del referente, en la configuración privada del servicio, para no pedirle que inicie sesión cada vez. No guardamos copias del contenido de su calendario ni de sus tareas: se consultan a Google en el momento de mostrarlos.</p>'
    + '<h2>Con quién compartimos los datos</h2>'
    + '<p>No vendemos, cedemos ni compartimos los datos de Google con terceros, ni los usamos para publicidad. Solo los ve el propio usuario en su dashboard.</p>'
    + '<p>El uso y la transferencia a cualquier otra aplicación de la información recibida de las API de Google cumplirá con la <a href="https://developers.google.com/terms/api-services-user-data-policy">Política de datos de usuario de los servicios de las API de Google</a>, incluidos los requisitos de uso limitado.</p>'
    + '<h2>Cómo desconectar y borrar los datos</h2>'
    + '<p>El usuario puede desconectar su cuenta desde la pantalla de configuración del dashboard, o revocar el acceso en <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. También puede pedir que eliminemos su token escribiendo a <a href="mailto:' + CONTACTO_LEGAL + '">' + CONTACTO_LEGAL + '</a>.</p>'
    + '<h2>Contacto</h2>'
    + '<p><a href="mailto:' + CONTACTO_LEGAL + '">' + CONTACTO_LEGAL + '</a></p>'));
});

app.get('/terms', (req, res) => {
  res.type('html').send(paginaLegal('Condiciones del servicio',
    '<p>Dashboard Mantenimiento es una herramienta interna de Grupo Oroño destinada al personal autorizado de mantenimiento y a los referentes de cada sector.</p>'
    + '<h2>Uso</h2>'
    + '<p>El acceso es solo para uso laboral interno. Conectar una cuenta de Google es opcional y el usuario puede desconectarla en cualquier momento.</p>'
    + '<h2>Disponibilidad</h2>'
    + '<p>El servicio se ofrece tal cual está, sin garantía de disponibilidad continua. Puede modificarse o interrumpirse sin previo aviso.</p>'
    + '<h2>Datos</h2>'
    + '<p>El tratamiento de los datos se describe en la <a href="/privacy">Política de privacidad</a>.</p>'
    + '<h2>Contacto</h2>'
    + '<p><a href="mailto:' + CONTACTO_LEGAL + '">' + CONTACTO_LEGAL + '</a></p>'));
});

// ── Arranque (solo si se ejecuta directo; require() no levanta el server) ─────
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  app.listen(PORT, async () => {
    console.log('dashboard-proxy escuchando en puerto ' + PORT);
    await cargarConfigRemota();   // restaura la config guardada (sobrevive redeploys)
    if (!CONFIG.zammad_token) console.warn('⚠  Sin token de Zammad. Cargalo en config.json o env ZAMMAD_TOKEN.');
    if (!ghOk()) console.warn('⚠  Sin persistencia remota: la config se pierde en cada redeploy. Configurá GITHUB_TOKEN y GITHUB_CONFIG_REPO.');
    await cargarDataJson();
    setInterval(cargarDataJson, 30 * 60 * 1000);
    setInterval(() => { fetch(SELF_URL).catch(() => {}); }, 14 * 60 * 1000); // keep-alive Render
  });
}

module.exports = { app, _internals: { loadConfig, aplicarData, cargarDataJson, saveConfig, persistConfig, cargarConfigRemota, guardarConfigRemota, countVencidos, searchAllCount, getProfile, defaultRef, get CONFIG(){return CONFIG;}, set CONFIG(v){CONFIG=v;}, get OWNERS(){return OWNERS;}, get INSTITUCIONES(){return INSTITUCIONES;}, get REFERENTES(){return REFERENTES;}, get OFICIALES(){return OFICIALES;} } };
