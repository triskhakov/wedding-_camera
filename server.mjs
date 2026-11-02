import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED = new Set(['queued', 'sending', 'delivered', 'unknown']);
function positive(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid positive integer configuration');
  return number;
}

// Header validation and resource bounds, not a complete image decoder.
function validJpeg(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2; let dimensions = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > bytes.length - 2) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return false;
      const height = bytes.readUInt16BE(offset + 3); const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > 12000 || height > 12000 || width * height > 24 * 1024 * 1024) return false;
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) return false;
      dimensions = true;
    }
    if (marker === 0xda) return dimensions && length >= 6 && offset + length < bytes.length - 2;
    offset += length;
  }
  return false;
}

export function createWeddingServer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const port = positive(env.PORT, 3000);
  if (env.NODE_ENV === 'production' && !env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN is required in production');
  const publicOrigin = new URL(env.PUBLIC_ORIGIN || `http://localhost:${port}`).origin;
  if (env.NODE_ENV === 'production' && !publicOrigin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chatId = env.TELEGRAM_CHAT_ID || '';
  const enabled = Boolean(token && chatId);
  const maxShots = 15;
  const maxBytes = positive(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
  const eventCap = positive(env.EVENT_UPLOAD_CAP, 3000);
  const timeout = positive(env.TELEGRAM_TIMEOUT_MS, 30000);
  const maxConcurrent = positive(env.MAX_CONCURRENT_UPLOADS, 8);
  let activeUploads = 0;
  const sessionCap = positive(env.SESSIONS_PER_IP_PER_DAY, 200);
  const dataPath = resolve(env.DATA_FILE || join(ROOT, 'data', 'uploads.json'));
  mkdirSync(dirname(dataPath), { recursive: true });
  const state = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : { version: 1, sessions: {}, photos: {}, sessionIps: {} };
  if (state.version !== 1 || !state.sessions || !state.photos || !state.sessionIps) throw new Error('Invalid upload state');
  function persist() {
    const temp = `${dataPath}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, dataPath);
  }
  for (const photo of Object.values(state.photos)) {
    if (photo.status === 'sending') photo.status = 'unknown';
    else if (photo.status === 'queued') photo.status = 'failed';
  }
  persist();
  const rates = new Map();
  const hash = value => createHash('sha256').update(value).digest('hex');
  function clientIp(req) {
    if (env.TRUST_PROXY === '1') return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }
  function allowRate(key, limit, period) {
    const now = Date.now();
    if (rates.size > 10000) for (const [k, v] of rates) if (now >= v.until) rates.delete(k);
    let bucket = rates.get(key);
    if (!bucket || now >= bucket.until) { bucket = { count: 0, until: now + period }; rates.set(key, bucket); }
    return ++bucket.count <= limit;
  }
  function session(req) {
    const value = /(?:^|;\s*)wedding_guest=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    return value && state.sessions[hash(value)] ? hash(value) : null;
  }
  function count(sessionId) {
    return Object.values(state.photos).filter(p => RESERVED.has(p.status) && (!sessionId || p.sessionId === sessionId)).length;
  }
  const remaining = id => Math.max(0, maxShots - count(id));
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
  function fail(res, status, code, message) { json(res, status, { ok: false, code, message }); }
  function validOrigin(req) { return req.headers.origin === publicOrigin; }
  async function readBody(req, limit = maxBytes) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('Файл слишком большой.'), { code: 'FILE_TOO_LARGE', status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const server = http.createServer(async (req, res) => {
    let ownsUploadSlot = false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const path = req.url?.split('?')[0];
    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(ROOT, 'index.html'))); return;
      }
      if (req.method === 'GET' && path === '/api/session') {
        const ip = hash(clientIp(req));
        if (!allowRate(`session:${ip}`, 300, 60000)) return fail(res, 429, 'RATE_LIMIT', 'Слишком много запросов. Попробуйте позже.');
        let id = session(req);
        if (!id) {
          // A shared network may contain many real guests; this is only abuse resistance, not identity verification.
          const day = new Date().toISOString().slice(0, 10);
          const bucket = state.sessionIps[ip];
          const issued = bucket?.day === day ? bucket.count : 0;
          if (issued >= sessionCap) return fail(res, 429, 'SESSION_LIMIT', 'Лимит новых сессий для этой сети. Обратитесь к организатору.');
          if (Object.keys(state.sessions).length >= positive(env.MAX_SESSIONS, 10000)) return fail(res, 503, 'SESSION_LIMIT', 'Новые сессии временно недоступны.');
          const value = randomBytes(32).toString('hex'); id = hash(value);
          state.sessions[id] = { createdAt: Date.now() };
          state.sessionIps[ip] = { day, count: issued + 1 };
          persist();
          res.setHeader('Set-Cookie', `wedding_guest=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
        }
        return json(res, 200, { remaining: remaining(id), maxShots, uploadsEnabled: enabled });
      }
      if (req.method === 'POST' && path === '/api/admin/session') {
        if (!validOrigin(req)) return fail(res, 403, 'INVALID_ORIGIN', 'Недопустимый источник запроса.');
        if (!allowRate(`pin:${hash(clientIp(req))}`, 5, 15 * 60000)) return fail(res, 429, 'RATE_LIMIT', 'Слишком много попыток входа. Попробуйте позже.');
        if (!env.ADMIN_PIN) return fail(res, 503, 'ADMIN_DISABLED', 'Вход организаторов пока не настроен.');
        const id = session(req);
        if (!id) return fail(res, 401, 'SESSION_REQUIRED', 'Обновите страницу для создания сессии.');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return fail(res, 415, 'INVALID_REQUEST', 'Ожидается JSON.');
        let submitted;
        try { submitted = JSON.parse((await readBody(req, 1024)).toString('utf8')); }
        catch { return fail(res, 400, 'INVALID_REQUEST', 'Некорректный запрос.'); }
        if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return fail(res, 400, 'INVALID_REQUEST', 'Некорректный запрос.');
        const supplied = typeof submitted?.pin === 'string' ? submitted.pin : '';
        if (!timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(hash(env.ADMIN_PIN), 'hex'))) return fail(res, 401, 'INVALID_PIN', 'Неверный ПИН-код.');
        state.sessions[id].adminUntil = Date.now() + 30 * 60000;
        persist();
        return json(res, 200, { ok: true });
      }
      if (req.method !== 'POST' || path !== '/api/photos') return fail(res, 404, 'NOT_FOUND', 'Не найдено.');
      if (!validOrigin(req)) return fail(res, 403, 'INVALID_ORIGIN', 'Недопустимый источник запроса.');
      if (!enabled) return fail(res, 503, 'UPLOADS_DISABLED', 'Отправка фотографий пока не настроена.');
      const id = session(req);
      if (!id) return fail(res, 401, 'SESSION_REQUIRED', 'Обновите страницу для создания сессии.');
      if (!allowRate(`upload-session:${id}`, 30, 60000) || !allowRate(`upload-ip:${hash(clientIp(req))}`, 300, 60000)) return fail(res, 429, 'RATE_LIMIT', 'Слишком много загрузок. Попробуйте позже.');
      const photoId = req.headers['x-photo-id'];
      if (typeof photoId !== 'string' || !UUID.test(photoId)) return fail(res, 400, 'INVALID_PHOTO_ID', 'Некорректный идентификатор снимка.');
      const previous = state.photos[photoId];
      if (previous && previous.sessionId !== id) return fail(res, 409, 'PHOTO_ID_CONFLICT', 'Идентификатор снимка уже используется.');
      if (previous?.status === 'delivered') return json(res, 200, { ok: true, photoId, remaining: remaining(id) });
      if (previous?.status === 'unknown') return fail(res, 409, 'UNKNOWN_DELIVERY', 'Результат отправки неизвестен. Проверьте снимок в Telegram с организатором; не отправляйте повторно.');
      if (previous && ['sending', 'queued'].includes(previous.status)) return fail(res, 409, 'DELIVERY_IN_PROGRESS', 'Снимок ещё отправляется. Попробуйте проверить позже.');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'image/jpeg') return fail(res, 415, 'INVALID_IMAGE', 'Разрешены только JPEG-фотографии.');
      if (Number(req.headers['content-length']) > maxBytes) return fail(res, 413, 'FILE_TOO_LARGE', 'Файл слишком большой.');
      let author;
      try { author = decodeURIComponent(String(req.headers['x-guest-name'] || '')); } catch { return fail(res, 400, 'INVALID_NAME', 'Некорректное имя.'); }
      author = author.trim() || 'Гость';
      if (author.length > 100 || /[\x00-\x1f\x7f]/.test(author)) return fail(res, 400, 'INVALID_NAME', 'Имя должно содержать не более 100 символов без управляющих знаков.');
      if (activeUploads >= maxConcurrent) return fail(res, 503, 'SERVER_BUSY', 'Сервер занят отправкой снимков. Попробуйте позже.');
      activeUploads++; ownsUploadSlot = true;
      const bytes = await readBody(req);
      if (!validJpeg(bytes)) return fail(res, 415, 'INVALID_IMAGE', 'Некорректный JPEG или превышен предел 24 Мп / 12000 пикселей по стороне.');
      // Recheck after body streaming; reservations below are synchronous, before Telegram await.
      const raced = state.photos[photoId];
      if (raced && raced.status !== 'failed') return fail(res, 409, raced.status === 'unknown' ? 'UNKNOWN_DELIVERY' : 'DELIVERY_IN_PROGRESS', 'Снимок уже обрабатывается.');
      if (!remaining(id)) return fail(res, 429, 'SHOT_LIMIT', 'Лимит 15 снимков исчерпан.');
      if (count() >= eventCap) return fail(res, 429, 'EVENT_LIMIT', 'Достигнут общий лимит мероприятия.');
      state.photos[photoId] = { sessionId: id, status: 'queued', createdAt: Date.now() };
      persist();
      const photo = state.photos[photoId];
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', new Blob([bytes], { type: 'image/jpeg' }), `wedding_${photoId}.jpg`);
      form.append('caption', `📸 Фото от гостя: ${author}\nID: ${photoId}`);
      photo.status = 'sending'; persist();
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeout) });
        const result = await response.json();
        if (result.ok === true) {
          photo.status = 'delivered'; photo.messageId = result.result?.message_id; persist();
          return json(res, 200, { ok: true, photoId, remaining: remaining(id) });
        }
        if (result.ok === false) {
          photo.status = 'failed'; persist();
          return fail(res, 502, 'TELEGRAM_REJECTED', 'Telegram отклонил отправку. Попробуйте позже.');
        }
        throw new Error('Unrecognized Telegram response');
      } catch {
        photo.status = 'unknown'; persist();
        return fail(res, 409, 'UNKNOWN_DELIVERY', 'Результат отправки неизвестен. Организатор должен проверить Telegram перед повторной отправкой.');
      }
    } catch (error) {
      if (!res.headersSent) fail(res, error.status || 500, error.code === 'FILE_TOO_LARGE' ? error.code : 'SERVER_ERROR', error.code === 'FILE_TOO_LARGE' ? error.message : 'Ошибка сервера. Попробуйте позже.');
      else res.end();
    } finally {
      if (ownsUploadSlot) activeUploads--;
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createWeddingServer();
  const port = positive(process.env.PORT, 3000);
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Wedding server listening on port ${port}`));
}
