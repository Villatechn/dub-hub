/* ===== api/room.js: salas temporales, sin base de datos, solo Vercel Blob ===== */
const { put, list, del } = require('@vercel/blob');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin I, L, O, 0, 1
const ROOM_TTL_MS = 48 * 60 * 60 * 1000;

/* El clip es opcional y viaja troceado: una función serverless de Vercel no acepta
   más de 4.5 MB por petición, así que el cliente manda trozos de 2.5 MB en crudo
   (~3.4 MB ya en base64) y aquí se guardan como binario. La bajada NO pasa por esta
   función: el listado devuelve las URL públicas del CDN de Blob. */
const MAX_CLIP_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_CHUNKS = 40;

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

/* salas/<CODIGO>/pistas/<id>__<timestamp>__<b64meta>.json */
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
  return { blob: metaBlob, expiresAt: Number(m[1]), blobs };
}

/* salas/<CÓDIGO>/clip/manifest__<b64meta>.json + salas/<CÓDIGO>/clip/parte__NNN.bin */
function clipFrom(blobs) {
  const man = blobs.find(b => /\/clip\/manifest__[^./]+\.json$/.test(b.pathname));
  if (!man) return null;
  const meta = b64urlDecode(man.pathname.match(/manifest__([^./]+)\.json$/)[1]);
  const partes = blobs
    .filter(b => /\/clip\/parte__\d+\.bin$/.test(b.pathname))
    .map(b => ({ i: Number(b.pathname.match(/parte__(\d+)\.bin$/)[1]), url: b.url }))
    .sort((a, b) => a.i - b.i);
  if (!meta.n || partes.length !== meta.n) return null;   // subida a medias: como si no hubiera clip
  return { name: meta.name || 'clip', type: meta.type || 'video/mp4', size: meta.size || 0,
    chunks: partes.map(p => p.url) };
}

/* limpieza oportunista: se ejecuta al crear una sala nueva, no hay cron en el plan Hobby */
async function cleanupExpired() {
  try {
    const { blobs } = await list({ prefix: 'salas/', limit: 1000 });
    const now = Date.now();
    const expiredCodes = new Set();
    for (const b of blobs) {
      const mm = b.pathname.match(/^salas\/([^/]+)\/meta__(\d+)\.json$/);
      if (mm && Number(mm[2]) < now) expiredCodes.add(mm[1]);
    }
    if (!expiredCodes.size) return;
    const toDelete = blobs
      .filter(b => {
        const cm = b.pathname.match(/^salas\/([^/]+)\//);
        return cm && expiredCodes.has(cm[1]);
      })
      .map(b => b.url);
    if (toDelete.length) await del(toDelete);
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

  let code = null;
  for (let i = 0; i < 8; i++) {
    const candidate = randomCode();
    const meta = await findRoomMeta(candidate);
    if (!meta || meta.expiresAt < Date.now()) { code = candidate; break; }
  }
  if (!code) return res.status(500).json({ error: 'no se pudo generar un código libre, intenta de nuevo' });

  const expiresAt = Date.now() + ROOM_TTL_MS;
  const content = JSON.stringify({
    clip: { name: clip.name, dur: clip.dur, size: clip.size || 0 },
    segments: segments.map(s => ({ id: safeId(s.id) || String(Math.random()).slice(2, 8), t0: s.t0, t1: s.t1 })),
    createdAt: Date.now()
  });
  await put(`salas/${code}/meta__${expiresAt}.json`, content,
    { access: 'public', contentType: 'application/json', addRandomSuffix: false });
  res.status(200).json({ code });
}

async function getRoom(req, res) {
  const code = safeCode(req.query.code);
  if (code.length !== 4) return res.status(400).json({ error: 'código inválido' });
  const meta = await findRoomMeta(code);
  if (!meta) return res.status(404).json({ error: 'sala no encontrada' });
  if (meta.expiresAt < Date.now()) return res.status(404).json({ error: 'la sala venció' });

  const metaContent = await (await fetch(meta.blob.url)).json();
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
    expiresAt: meta.expiresAt, tracks, clipFile: clipFrom(meta.blobs) });
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
  const file = body.file || {};
  if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > MAX_CHUNKS || i < 0 || i >= n)
    return res.status(400).json({ error: 'índice de trozo inválido' });
  if (Number(file.size) > MAX_CLIP_BYTES)
    return res.status(413).json({ error: 'el clip pasa de ' + Math.round(MAX_CLIP_BYTES / 1048576) + ' MB' });
  if (typeof body.b64 !== 'string' || !body.b64)
    return res.status(400).json({ error: 'trozo vacío' });

  const buf = Buffer.from(body.b64, 'base64');
  if (buf.length > MAX_CHUNK_BYTES) return res.status(413).json({ error: 'trozo demasiado grande' });

  // el primer trozo borra cualquier clip anterior de la sala
  if (i === 0) {
    const viejos = meta.blobs.filter(b => b.pathname.startsWith(`salas/${code}/clip/`));
    if (viejos.length) await del(viejos.map(b => b.url));
  }

  await put(`salas/${code}/clip/parte__${String(i).padStart(3, '0')}.bin`, buf,
    { access: 'public', contentType: 'application/octet-stream', addRandomSuffix: false });

  if (i === n - 1) {
    const fileMeta = {
      name: String(file.name || 'clip').slice(0, 80),
      type: String(file.type || 'video/mp4').slice(0, 40),
      size: Number(file.size) || 0, n
    };
    await put(`salas/${code}/clip/manifest__${b64urlEncode(fileMeta)}.json`, JSON.stringify(fileMeta),
      { access: 'public', contentType: 'application/json', addRandomSuffix: false });
  }
  res.status(200).json({ i, done: i === n - 1 });
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
  const content = await (await fetch(found.url)).json();
  res.status(200).json(content);
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

  const old = meta.blobs.filter(b => {
    const p = parseTrackPath(b.pathname);
    return p && p.id === id;
  });
  if (old.length) await del(old.map(b => b.url));

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
  await put(pathname, content, { access: 'public', contentType: 'application/json', addRandomSuffix: false });
  res.status(200).json({ ts, takes: takeCount });
}

module.exports = async function handler(req, res) {
  try {
    const action = req.query.action;
    if (req.method === 'POST' && action === 'create') return await createRoom(req, res);
    if (req.method === 'POST' && action === 'track') return await putTrack(req, res);
    if (req.method === 'POST' && action === 'clip') return await putClip(req, res);
    if (req.method === 'GET' && req.query.track) return await getTrack(req, res);
    if (req.method === 'GET' && req.query.code) return await getRoom(req, res);
    res.status(400).json({ error: 'petición inválida' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'error interno' });
  }
};
