// Test estructural: stubea global.fetch para simular Zammad, levanta la app en un
// puerto y golpea los endpoints. Verifica queries construidas, filtrado de vencidos
// y forma del JSON. NO toca Zammad real.
const http = require('http');

// ---- Estado del stub: registra las queries que el proxy le pide a Zammad ----
const capturado = [];
const ahora = Date.now();
const iso = ms => new Date(ms).toISOString();

// Banco de tickets falsos por si el proxy pide abiertos (para contar vencidos).
// 2 vencidos (escalation en el pasado) + 1 en tiempo (futuro) para owner 67 y org 13.
function ticketsAbiertosFalsos() {
  return {
    tickets: [101, 102, 103],
    tickets_count: 3,
    assets: { Ticket: {
      101: { id:101, escalation_at: iso(ahora - 3600e3) },   // vencido (1h atrás)
      102: { id:102, escalation_at: iso(ahora - 86400e3) },  // vencido (1d atrás)
      103: { id:103, escalation_at: iso(ahora + 7200e3) }    // en tiempo (futuro)
    }}
  };
}

// Devuelve un tickets_count fijo para los conteos "created/closed/nuevos".
function conteoFalso(n) { return { tickets: [], tickets_count: n }; }

global.fetch = async (url) => {
  const u = decodeURIComponent(String(url));
  capturado.push(u);
  // data.json → devolver algo mínimo válido
  if (u.includes('data.json')) {
    return { ok:true, json: async () => ({ sectores:[], usuarios_derivables:[], instituciones:[] }) };
  }
  // ¿es un conteo (per_page=1) o una búsqueda de abiertos (per_page=200)?
  const esConteo = u.includes('per_page=1');
  const esAbiertos = u.includes('state_id:1 OR state_id:2') && u.includes('per_page=200');

  if (esAbiertos) {
    return { ok:true, json: async () => ticketsAbiertosFalsos() };
  }
  if (esConteo) {
    // números distintos según el tipo de query, para verificar el mapeo
    let n = 0;
    if (u.includes('created_at:>')) n = 87;               // institución: generados
    else if (u.includes('state_id:4') && u.includes('close_at:>')) n = 112; // oficial: cerrados
    else if (u.includes('state_id:1') && u.includes('organization_id')) n = 6; // derivar
    return { ok:true, json: async () => conteoFalso(n) };
  }
  return { ok:true, json: async () => conteoFalso(0) };
};

// Config de prueba (token dummy) ANTES de requerir el server
process.env.ZAMMAD_TOKEN = 'TEST';
const { app } = require('./server.js');

// Levantar y consultar
const server = http.createServer(app).listen(0, async () => {
  const port = server.address().port;
  const get = p => new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, r => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve({status:r.statusCode, json:JSON.parse(d)}));
    }).on('error', reject);
  });

  console.log('\n===== GET /api/tickets?oficiales=67&days=30&org=13 =====');
  const t = await get('/api/tickets?oficiales=67&days=30&org=13');
  console.log('status:', t.status);
  console.log(JSON.stringify(t.json, null, 2));

  console.log('\n===== GET /api/derivar?ref=321&org=13 =====');
  const d = await get('/api/derivar?ref=321&org=13');
  console.log('status:', d.status);
  console.log(JSON.stringify(d.json, null, 2));

  console.log('\n===== QUERIES ENVIADAS A ZAMMAD =====');
  capturado.filter(u=>u.includes('/api/v1/tickets/search'))
    .forEach(u => console.log('  ', u.split('query=')[1].split('&')[0]));

  console.log('\n===== ASSERTS =====');
  const A = [];
  A.push(['tickets.status 200', t.status===200]);
  A.push(['institucion.total = 87 (created)', t.json.institucion.total===87]);
  A.push(['institucion.vencidos_hoy = 2 (filtrado JS)', t.json.institucion.vencidos_hoy===2]);
  A.push(['oficial.cerrados = 112', t.json.oficiales[0].cerrados===112]);
  A.push(['oficial.vencidos_hoy = 2 (filtrado JS)', t.json.oficiales[0].vencidos_hoy===2]);
  A.push(['oficial.nombre resuelto (Elio Molina)', t.json.oficiales[0].nombre==='Elio Molina']);
  A.push(['institucion.nombre incluye ICR', /ICR/.test(t.json.institucion.nombre)]);
  A.push(['derivar.status 200', d.status===200]);
  A.push(['derivar.count = 6', d.json.count===6]);
  A.push(['derivar.referente = Franco Bono', d.json.referente==='Franco Bono']);
  A.push(['derivar.institucion = ICR', d.json.institucion==='ICR']);
  // queries correctas
  const qs = capturado.join('\n');
  A.push(['query cerrados correcta', qs.includes('owner_id:67 AND state_id:4 AND close_at:>')]);
  A.push(['query created institución correcta', qs.includes('organization_id:13 AND created_at:>')]);
  A.push(['query derivar correcta', qs.includes('owner_id:321 AND organization_id:13 AND state_id:1')]);
  let ok=true;
  A.forEach(([n,v])=>{ console.log(`  ${v?'✓':'✗'} ${n}`); if(!v) ok=false; });
  console.log('\nRESULTADO:', ok ? 'TODO OK ✓' : 'HAY FALLOS ✗');
  server.close();
  process.exit(ok?0:1);
});
