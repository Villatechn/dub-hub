/* ===== api/room.js: salas temporales, sin base de datos, sobre Vercel Blob PRIVADO =====

   El store es privado, así que nada se sirve por URL pública: todo lo lee esta
   función con get() y lo reenvía. Requiere @vercel/blob >= 2.3.                     */
const { put, list, del, get } = require('@vercel/blob');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin I, L, O, 0, 1
const ROOM_TTL_MS = 48 * 60 * 60 * 1000;

/* El clip es opcional y viaja troceado: una función serverless de Vercel no acepta
   más de 4.5 MB por petición, así que el cliente manda trozos de 2.5 MB en crudo
   (~3.4 MB ya en base64) y aquí se guardan como binario. Al bajar, cada trozo pasa
   otra vez por esta función porque el store es privado. */
const MAX_CLIP_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_CHUNKS = 40;

const ACCESS = { access: 'private' };

function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
function safeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}
function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
}
function safeNum(n, max) {
  const v = Number(n);
  return Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}
function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function b64urlDecode(s) {
  try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }
  catch (e) { return {}; }
}
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return req.body;
}

/* lee un blob privado entero a Buffer; null si no existe */
async function readBlob(pathname) {
  const r = await get(pathname, ACCESS);
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}
async function readJson(pathname) {
  const buf = await readBlob(pathname);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
}

/* salas/<CÓDIGO>/pistas/<id>__<timestamp>__<b64meta>.json */
function parseTrackPath(pathname) {
  const m = pathname.match(/^salas\/[^/]+\/pistas\/([^_]+)__(\d+)__([^./]+)\.json$/);
  if (!m) return null;
  return { id: m[1], ts: Number(m[2]), meta: b64urlDecode(m[3]) };
}

/* un solo list() por sala: de ahí salen el meta, las pistas y el clip */
async function findRoomMeta(code) {
  const { blobs } = await list({ prefix: `salas/${code}/` });
  const metaBlob = blobs.find(b => /\/meta__\d+\.json$/.test(b.pathname));
  if (!metaBlob) return null;
  const m = metaBlob.pathname.match(/meta__(\d+)\.json$/);
  return { pathname: metaBlob.pathname, expiresAt: Number(m[1]), blobs };
}

/* salas/<CÓDIGO>/clip/<TS>__manifest__<b64meta>.json + <TS>__parte__<NNN>.bin
   El TS agrupa una subida: así resubir el clip no reescribe pathnames existentes
   (el SDK moderno lanza error al sobrescribir) ni sirve trozos viejos cacheados. */
function clipFrom(blobs, code) {
  const mans = blobs
    .map(b => {
      const m = b.pathname.match(/\/clip\/(\d+)__manifest__([^./]+)\.json$/);
      return m ? { ts: Number(m[1]), meta: b64urlDecode(m[2]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts);
  if (!mans.length) return null;

  const { ts, meta } = mans[0];
  const partes = blobs
    .map(b => {
      const m = b.pathname.match(/\/clip\/(\d+)__parte__(\d+)\.bin$/);
      return m && Number(m[1]) === ts ? Number(m[2]) : null;
    })
    .filter(i => i !== null)
    .sort((a, b) => a - b);
  if (!meta.n || partes.length !== meta.n) return null;   // subida a medias: como si no hubiera clip

  return {
    name: meta.name || 'clip', type: meta.type || 'video/mp4', size: meta.size || 0,
    // el store es privado: los trozos se bajan por esta misma función, no del CDN
    chunks: partes.map(i => `/api/room?code=${code}&clip=${i}&ts=${ts}`)
  };
}

async function borrarTodo(blobs) {
  if (blobs.length) await del(blobs.map(b => b.pathname));
}

/* limpieza oportunista: se ejecuta al crear una sala nueva, no hay cron en el plan Hobby */
async function cleanupExpired() {
  try {
    const { blobs } = await list({ prefix: 'salas/', limit: 1000 });
    const now = Date.now();
    const vencidas = new Set();
    for (const b of blobs) {
      const mm = b.pathname.match(/^salas\/([^/]+)\/meta__(\d+)\.json$/);
      if (mm && Number(mm[2]) < now) vencidas.add(mm[1]);
    }
    if (!vencidas.size) return;
    await borrarTodo(blobs.filter(b => {
      const cm = b.pathname.match(/^salas\/([^/]+)\//);
      return cm && vencidas.has(cm[1]);
    }));
  } catch (e) { /* si falla la limpieza no debe bloquear la creación de la sala */ }
}

async function createRoom(req, res) {
  const body = readBody(req);
  const clip = body.clip;
  const segments = body.segments;
  if (!clip || typeof clip.name !== 'string' || typeof clip.dur !== 'number')
    return res.status(400).json({ error: 'falta la info del clip' });
  if (!Array.isArray(segments) || !segments.length)
    return res.status(400).json({ error: 'faltan los segmentos' });
  for (const s of segments) {
    if (!s || typeof s.t0 !== 'number' || typeof s.t1 !== 'number' || s.t1 <= s.t0)
      return res.status(400).json({ error: 'segmento inválido' });
  }

  await cleanupExpired();

  let code = null, restos = null;
  for (let i = 0; i < 8; i++) {
    const candidato = randomCode();
    const meta = await findRoomMeta(candidato);
    if (!meta) { code = candidato; break; }
    if (meta.expiresAt < Date.now()) { code = candidato; restos = meta.blobs; break; }
  }
  if (!code) return res.status(500).json({ error: 'no se pudo generar un código libre, intenta de nuevo' });

  // si el código venía de una sala vencida que la limpieza no alcanzó, barrerla ahora:
  // dejar su meta viejo haría que findRoomMeta devolviera cualquiera de los dos
  if (restos) await borrarTodo(restos);

  const expiresAt = Date.now() + ROOM_TTL_MS;
  const content = JSON.stringify({
    clip: { name: clip.name, dur: clip.dur, size: clip.size || 0 },
    segments: segments.map(s => ({ id: safeId(s.id) || String(Math.random()).slice(2, 8), t0: s.t0, t1: s.t1 })),
    createdAt: Date.now()
  });
  await put(`salas/${code}/meta__${expiresAt}.json`, content,
    { ...ACCESS, contentType: 'application/json', addRandomSuffix: false });
  res.status(200).json({ code });
}

async function getRoom(req, res) {
  const code = safeCode(req.query.code);
  if (code.length !== 4) return res.status(400).json({ error: 'código inválido' });
  const meta = await findRoomMeta(code);
  if (!meta) return res.status(404).json({ error: 'sala no encontrada' });
  if (meta.expiresAt < Date.now()) return res.status(404).json({ error: 'la sala venció' });

  const metaContent = await readJson(meta.pathname);
  if (!metaContent) return res.status(404).json({ error: 'sala no encontrada' });

  const tracks = meta.blobs.map(b => {
    const p = parseTrackPath(b.pathname);
    if (!p) return null;
    return {
      id: p.id, ts: p.ts, size: b.size,
      name: p.meta.name || '', actor: p.meta.actor || '',
      color: p.meta.color || '', gain: p.meta.gain || 1,
      takes: p.meta.takes || 0
    };
  }).filter(Boolean);

  res.status(200).json({ clip: metaContent.clip, segments: metaContent.segments,
    expiresAt: meta.expiresAt, tracks, clipFile: clipFrom(meta.blobs, code) });
}

async function getTrack(req, res) {
  const code = safeCode(req.query.code);
  const id = safeId(req.query.track);
  if (code.length !== 4 || !id) return res.status(400).json({ error: 'petición inválida' });
  const { blobs } = await list({ prefix: `salas/${code}/pistas/` });
  const found = blobs.find(b => {
    const p = parseTrackPath(b.pathname);
    return p && p.id === id;
  });
  if (!found) return res.status(404).json({ error: 'pista no encontrada' });
  const content = await readJson(found.pathname);
  if (!content) return res.status(404).json({ error: 'pista no encontrada' });
  res.status(200).json(content);
}

/* baja un trozo del clip; el store es privado, así que pasa por aquí */
async function getClipChunk(req, res) {
  const code = safeCode(req.query.code);
  const i = safeNum(req.query.clip, MAX_CHUNKS - 1);
  const ts = safeNum(req.query.ts, Number.MAX_SAFE_INTEGER);
  if (code.length !== 4 || i === null || ts === null)
    return res.status(400).json({ error: 'petición inválida' });

  const buf = await readBlob(`salas/${code}/clip/${ts}__parte__${String(i).padStart(3, '0')}.bin`);
  if (!buf) return res.status(404).json({ error: 'trozo no encontrado' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.status(200);
  res.end(buf);
}

/* sube un trozo del clip; el último trozo escribe el manifiesto */
async function putClip(req, res) {
  const code = safeCode(req.query.code);
  if (code.length !== 4) return res.status(400).json({ error: 'código inválido' });
  const meta = await findRoomMeta(code);
  if (!meta) return res.status(404).json({ error: 'sala no encontrada' });
  if (meta.expiresAt < Date.now()) return res.status(404).json({ error: 'la sala venció' });

  const body = readBody(req);
  const i = Number(body.i), n = Number(body.n);
  const ts = safeNum(body.ts, Number.MAX_SAFE_INTEGER);
  const file = body.file || {};
  if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > MAX_CHUNKS || i < 0 || i >= n)
    return res.status(400).json({ error: 'índice de trozo inválido' });
  if (ts === null) return res.status(400).json({ error: 'falta el sello de la subida' });
  if (Number(file.size) > MAX_CLIP_BYTES)
    return res.status(413).json({ error: 'el clip pasa de ' + Math.round(MAX_CLIP_BYTES / 1048576) + ' MB' });
  if (typeof body.b64 !== 'string' || !body.b64)
    return res.status(400).json({ error: 'trozo vacío' });

  const buf = Buffer.from(body.b64, 'base64');
  if (buf.length > MAX_CHUNK_BYTES) return res.status(413).json({ error: 'trozo demasiado grande' });

  // el primer trozo borra cualquier clip anterior de la sala
  if (i === 0)
    await borrarTodo(meta.blobs.filter(b => b.pathname.startsWith(`salas/${code}/clip/`)));

  await put(`salas/${code}/clip/${ts}__parte__${String(i).padStart(3, '0')}.bin`, buf,
    { ...ACCESS, contentType: 'application/octet-stream', addRandomSuffix: false });

  if (i === n - 1) {
    const fileMeta = {
      name: String(file.name || 'clip').slice(0, 80),
      type: String(file.type || 'video/mp4').slice(0, 40),
      size: Number(file.size) || 0, n
    };
    await put(`salas/${code}/clip/${ts}__manifest__${b64urlEncode(fileMeta)}.json`, JSON.stringify(fileMeta),
      { ...ACCESS, contentType: 'application/json', addRandomSuffix: false });
  }
  res.status(200).json({ i, done: i === n - 1 });
}

async function putTrack(req, res) {
  const code = safeCode(req.query.code);
  if (code.length !== 4) return res.status(400).json({ error: 'código inválido' });
  const meta = await findRoomMeta(code);
  if (!meta) return res.status(404).json({ error: 'sala no encontrada' });
  if (meta.expiresAt < Date.now()) return res.status(404).json({ error: 'la sala venció' });

  const body = readBody(req);
  const track = body.track;
  if (!track || typeof track !== 'object') return res.status(400).json({ error: 'falta la pista' });
  const id = safeId(track.id);
  if (!id) return res.status(400).json({ error: 'id de pista inválido' });
  const takes = track.takes && typeof track.takes === 'object' ? track.takes : {};
  const takeCount = Object.keys(takes).length;
  if (!takeCount) return res.status(400).json({ error: 'la pista no tiene tomas' });

  await borrarTodo(meta.blobs.filter(b => {
    const p = parseTrackPath(b.pathname);
    return p && p.id === id;
  }));

  const ts = Date.now();
  const fileMeta = {
    name: String(track.name || '').slice(0, 60),
    actor: String(track.actor || '').slice(0, 60),
    color: String(track.color || ''),
    gain: Number(track.gain) || 1,
    takes: takeCount
  };
  const pathname = `salas/${code}/pistas/${id}__${ts}__${b64urlEncode(fileMeta)}.json`;
  const content = JSON.stringify({
    id, name: track.name || '', actor: track.actor || '',
    color: track.color || '', gain: track.gain || 1, takes
  });
  await put(pathname, content, { ...ACCESS, contentType: 'application/json', addRandomSuffix: false });
  res.status(200).json({ ts, takes: takeCount });
}

module.exports = async function handler(req, res) {
  try {
    const action = req.query.action;
    if (req.method === 'POST' && action === 'create') return await createRoom(req, res);
    if (req.method === 'POST' && action === 'track') return await putTrack(req, res);
    if (req.method === 'POST' && action === 'clip') return await putClip(req, res);
    if (req.method === 'GET' && req.query.clip !== undefined) return await getClipChunk(req, res);
    if (req.method === 'GET' && req.query.track) return await getTrack(req, res);
    if (req.method === 'GET' && req.query.code) return await getRoom(req, res);
    res.status(400).json({ error: 'petición inválida' });
  } catch (e) {
    const msg = String(e && e.message || e);
    // el error crudo del SDK no le dice nada a nadie; traducirlo al arreglo real
    if (/No token found|BLOB_READ_WRITE_TOKEN/i.test(msg))
      return res.status(500).json({ error: 'al servidor le falta el almacén: conecta el Blob store en Vercel (pestaña Storage) y vuelve a desplegar' });
    if (/private store|public access/i.test(msg))
      return res.status(500).json({ error: 'el Blob store no coincide con el modo de acceso del código (se espera un store privado)' });
    res.status(500).json({ error: msg || 'error interno' });
  }
};
