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

// ── Config (token/URL desde config.json o env; nunca en el código) ───────────
function loadConfig() {
  const cfg = {
    zammad_url:    process.env.ZAMMAD_URL    || 'https://help.gored.com.ar',
    zammad_token:  process.env.ZAMMAD_TOKEN  || '',
    data_json_url: process.env.DATA_JSON_URL || 'https://fbono-go.github.io/App-Ticket/data.json'
  };
  try {
    const p = path.join(__dirname, 'config.json');
    if (fs.existsSync(p)) Object.assign(cfg, JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { console.warn('[config] config.json ilegible:', e.message); }
  return cfg;
}
let CONFIG = loadConfig();
const HEADERS = () => ({ 'Authorization': 'Token token=' + CONFIG.zammad_token, 'Content-Type': 'application/json' });

// Estados Zammad (lógica fija de la instancia): 1=nuevo, 2=abierto, 4=cerrado
const STATE_ABIERTOS = '(state_id:1 OR state_id:2)';

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

function aplicarData(data) {
  const owners = {};
  (data.sectores || []).forEach(s => { if (s.ref_id) owners[s.ref_id] = s.ref; });
  (data.referentes_historicos || []).forEach(r => { owners[r.id] = r.nombre; });
  (data.usuarios_derivables || []).forEach(u => { owners[u.id] = u.nombre; });
  if (Object.keys(owners).length) OWNERS = owners;

  // Instituciones: data.json puede traerlas como 'instituciones' [{id, abrev|nombre}]
  const inst = {};
  (data.instituciones || []).forEach(i => { inst[i.id] = i.abrev || i.abreviatura || i.nombre; });
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
async function countTickets(query) {
  const d = await zammadSearch(query, 1);
  if (typeof d.tickets_count === 'number') return d.tickets_count;
  return Array.isArray(d.tickets) ? d.tickets.length : 0;
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
    const days = parseInt(req.query.days || '30');
    const org  = parseInt(req.query.org || req.query.icr_org || '13'); // institución del gauge "totales"
    const oficiales = (req.query.oficiales || '')
      .split(',').map(x => parseInt(x.trim())).filter(Boolean);
    const desdeIso = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

    // Gauge institución: generados últimos N días + vencidos actuales de la institución
    const [instTotal, instVencidos] = await Promise.all([
      countTickets(`organization_id:${org} AND created_at:>${desdeIso}`),
      countVencidos(`organization_id:${org}`)
    ]);

    // Gauges de oficiales (en paralelo): cerrados 30d + vencidos del oficial
    const oficialesData = await Promise.all(oficiales.map(async id => {
      const [cerrados, vencidos] = await Promise.all([
        countTickets(`owner_id:${id} AND state_id:4 AND close_at:>${desdeIso}`),
        countVencidos(`owner_id:${id}`)
      ]);
      return { owner_id: id, nombre: OWNERS[id] || ('Agente ' + id), cerrados, vencidos_hoy: vencidos };
    }));

    res.json({
      generado_en: new Date().toISOString(),
      periodo_dias: days,
      institucion: {
        org_id: org,
        nombre: `Tickets totales ${INSTITUCIONES[org] || org}`,
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
    const ref = parseInt(req.query.ref);
    const org = parseInt(req.query.org);
    if (!ref || !org) return res.status(400).json({ error: 'Faltan parámetros ref y org' });

    const count = await countTickets(`owner_id:${ref} AND organization_id:${org} AND state_id:1`);

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

module.exports = { app, _internals: { loadConfig, aplicarData, countTickets, countVencidos, get CONFIG(){return CONFIG;}, set CONFIG(v){CONFIG=v;}, get OWNERS(){return OWNERS;}, get INSTITUCIONES(){return INSTITUCIONES;} } };
