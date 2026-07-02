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
const DEFAULTS = {
  zammad_url: 'https://help.gored.com.ar',
  zammad_token: '',
  data_json_url: 'https://fbono-go.github.io/App-Ticket/data.json',
  admin_password: '12345678',
  openweather_key: '',
  weather: { lat: -32.9468, lon: -60.6393, label: 'Rosario' },
  selection: {
    oficiales: [67, 66, 68, 64, 65],
    institucionOrg: 13,
    derivarRef: 321,
    derivarOrg: 13,
    days: 30,
    escala_institucion: 400,
    escala_oficiales: 150,
    escala_derivar: 20
  },
  calendar: { startHour: 6, endHour: 22 }
};

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  // Entorno pisa defaults (para secrets en Render)
  if (process.env.ZAMMAD_URL)     cfg.zammad_url = process.env.ZAMMAD_URL;
  if (process.env.ZAMMAD_TOKEN)   cfg.zammad_token = process.env.ZAMMAD_TOKEN;
  if (process.env.DATA_JSON_URL)  cfg.data_json_url = process.env.DATA_JSON_URL;
  if (process.env.OPENWEATHER_KEY) cfg.openweather_key = process.env.OPENWEATHER_KEY;
  // config.json pisa lo anterior, pero ignorando strings vacíos (no borra secrets)
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
const HEADERS = () => ({ 'Authorization': 'Token token=' + CONFIG.zammad_token, 'Content-Type': 'application/json' });

// Estados Zammad (lógica fija de la instancia): 1=nuevo, 2=abierto, 4=cerrado
const STATE_ABIERTOS = '(state_id:1 OR state_id:2)';

// Abreviaturas de institución para el gauge (más cortas que el nombre completo)
const ABREV = { 14:'DMO', 138:'GOG', 33:'GO', 13:'ICR', 132:'SAME', 15:'SN', 12:'SP' };
function nombreInstGauge(org) {
  return `Tickets totales ${ABREV[org] || INSTITUCIONES[org] || org}`;
}

// ── Fuente de verdad: data.json (mismo archivo que usa la app y el frontend) ──
// OWNERS (id→nombre), SECTORES e INSTITUCIONES se arman desde data.json.
// Fallback embebido para que el proxy nunca quede sin nombres.
const FALLBACK_OWNERS = {
  321:'Franco Bono', 61:'Juan Pablo Pioli', 62:'Mariana Serrano Oar', 350:'Gerardo Sacramone',
  67:'Elio Molina', 66:'Carlos Carranza', 68:'Fausto Casco', 64:'Agustín Gentiletti',
  65:'Damián Benítez', 69:'Claudio Rojas', 70:'Ramón Carballo', 71:'Gabriel Moreno',
  72:'Néstor Bacaro', 74:'Elias Gutierrez', 75:'Gustavo Salinas', 77:'Rodrigo Buitron',
  79:'Emiliano Godoy', 141:'Martin Galuppo', 245:'Brandon Villalba'
};
const FALLBACK_INSTITUCIONES = { 14:'DMO', 38:'GOG', 33:'GO', 13:'ICR', 32:'SAME', 15:'SN', 12:'SP' };

let OWNERS        = { ...FALLBACK_OWNERS };
let INSTITUCIONES = { ...FALLBACK_INSTITUCIONES };
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

// GET /api/tickets?oficiales=67,66,68&days=30&org=13
// Devuelve: gauge de institución ("tickets totales") + un gauge por oficial.
app.get('/api/tickets', async (req, res) => {
  try {
    const sel = CONFIG.selection || {};
    const days = parseInt(req.query.days || sel.days || '30');
    const org  = parseInt(req.query.org || req.query.icr_org || sel.institucionOrg || '13'); // institución del gauge "totales"
    const oficiales = (req.query.oficiales
      ? req.query.oficiales.split(',').map(x => parseInt(x.trim())).filter(Boolean)
      : (sel.oficiales || []));
    const desdeIso = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

    // Gauge institución: generados últimos N días (campo custom 'facility', no organization_id)
    const [instTotal, instVencidos] = await Promise.all([
      searchAllCount(`facility:${org} AND created_at:>${desdeIso}`),
      countVencidos(`facility:${org}`)
    ]);

    // Gauges de oficiales (en paralelo): cerrados 30d + vencidos del oficial
    // Usamos searchAllCount (paginado) porque tickets_count no es confiable en esta instancia.
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
      institucion: {
        org_id: org,
        nombre: nombreInstGauge(org),
        total: instTotal,
        vencidos_hoy: instVencidos
      },
      oficiales: oficialesData
    });
  } catch (e) {
    console.error('/api/tickets', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/derivar?ref=321&org=13
// Devuelve: nuevos actuales del referente en esa institución (backlog a derivar).
app.get('/api/derivar', async (req, res) => {
  try {
    const sel = CONFIG.selection || {};
    const ref = parseInt(req.query.ref || sel.derivarRef);
    const org = parseInt(req.query.org || sel.derivarOrg);
    if (!ref || !org) return res.status(400).json({ error: 'Faltan parámetros ref y org' });

    const count = await searchAllCount(`owner_id:${ref} AND facility:${org} AND state_id:1`);

    res.json({
      generado_en: new Date().toISOString(),
      ref_id: ref, referente: OWNERS[ref] || ('Agente ' + ref),
      org_id: org, institucion: INSTITUCIONES[org] || String(org),
      count
    });
  } catch (e) {
    console.error('/api/derivar', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Configuración ────────────────────────────────────────────────────────────
// Vista PÚBLICA (la que consume el dashboard): sin secrets.
function configPublica() {
  return {
    selection: CONFIG.selection,
    calendar: CONFIG.calendar,
    weather: CONFIG.weather,
    // banderas para el admin (saber si ya hay algo cargado, sin exponerlo)
    flags: {
      zammad_token_set: !!CONFIG.zammad_token,
      openweather_key_set: !!CONFIG.openweather_key
    }
  };
}

// GET /api/config → lo que el dashboard necesita para armar sus queries y render.
app.get('/api/config', (req, res) => res.json(configPublica()));

// Listas para poblar los dropdowns del admin (instituciones, referentes, oficiales).
app.get('/api/opciones', (req, res) => {
  res.json({
    instituciones: Object.entries(INSTITUCIONES).map(([id, nombre]) => ({ id: parseInt(id), nombre, abrev: ABREV[id] || nombre })),
    referentes: REFERENTES,
    oficiales: OFICIALES
  });
});

// POST /api/config → guarda cambios. Requiere contraseña. Secrets vacíos no pisan.
app.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (body.password !== CONFIG.admin_password) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  delete body.password;
  mergeConfig(CONFIG, body);        // aplica en memoria (ignora strings vacíos)
  const ok = saveConfig();          // persiste a disco
  res.json({ ok, guardado: configPublica() });
});

// Cambiar la propia contraseña de admin.
app.post('/api/config/password', (req, res) => {
  const { password, nueva } = req.body || {};
  if (password !== CONFIG.admin_password) return res.status(401).json({ error: 'Contraseña incorrecta' });
  if (!nueva || String(nueva).length < 4) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });
  CONFIG.admin_password = String(nueva);
  const ok = saveConfig();
  res.json({ ok });
});

// Servir la pantalla de configuración.
app.get('/config', (req, res) => res.sendFile(path.join(__dirname, 'config.html')));

// Salud del proxy (para el watchdog del dashboard y para chequear config).
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    zammad_url: CONFIG.zammad_url,
    token_cargado: !!CONFIG.zammad_token,
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

app.get('/', (req, res) => res.send('dashboard-proxy OK'));

// ── Arranque (solo si se ejecuta directo; require() no levanta el server) ─────
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  app.listen(PORT, async () => {
    console.log('dashboard-proxy escuchando en puerto ' + PORT);
    if (!CONFIG.zammad_token) console.warn('⚠  Sin token de Zammad. Cargalo en config.json o env ZAMMAD_TOKEN.');
    await cargarDataJson();
    setInterval(cargarDataJson, 30 * 60 * 1000);
    setInterval(() => { fetch(SELF_URL).catch(() => {}); }, 14 * 60 * 1000); // keep-alive Render
  });
}

module.exports = { app, _internals: { loadConfig, aplicarData, cargarDataJson, saveConfig, countVencidos, searchAllCount, get CONFIG(){return CONFIG;}, set CONFIG(v){CONFIG=v;}, get OWNERS(){return OWNERS;}, get INSTITUCIONES(){return INSTITUCIONES;}, get REFERENTES(){return REFERENTES;}, get OFICIALES(){return OFICIALES;} } };
