const PHOTO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNTED = "('sending','delivered','unknown')";
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const hash = async text => hex(await digest(text));
function numberSetting(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid configuration');
  return n;
}
function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers,
  } });
}
const failure = (status, code, message) => reply(status, { ok: false, code, message });
function logFailure(stage, photoId, error) {
  const name = /^[A-Za-z0-9_]{1,40}$/.test(error?.name || '') ? error.name : 'Error';
  console.error('wedding_upload_failure', { stage, ...(PHOTO_UUID.test(photoId || '') ? { photoId } : {}), name });
}
async function rate(db, key, limit, period, now) {
  return Boolean(await db.prepare(`INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
    expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at<=? OR count<? RETURNING count`).bind(key, now + period, now, now, now, limit).first());
}
async function findSession(request, db) {
  const value = /(?:^|;\s*)wedding_guest=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie') || '')?.[1];
  if (!value) return null;
  const id = await hash(value);
  return (await db.prepare('SELECT id FROM sessions WHERE id=?').bind(id).first()) ? id : null;
}
async function shotsRemaining(db, sessionId) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM photos WHERE session_id=? AND status IN ${COUNTED}`).bind(sessionId).first();
  return Math.max(0, 15 - Number(row.total));
}
async function boundedBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw { status: 413, code: 'FILE_TOO_LARGE' };
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = []; let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, 30000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw { status: 413, code: 'FILE_TOO_LARGE' }; }
      parts.push(value);
    }
    if (timedOut) throw { code: 'BODY_TIMEOUT' };
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  return data;
}
async function multipartFields(request, limit, contentType) {
  if (Number(request.headers.get('Content-Length')) > limit) throw { code: 'FILE_TOO_LARGE' };
  const reader = request.body?.getReader();
  if (!reader) throw { code: 'INVALID_MULTIPART' };
  let size = 0; let timedOut = false; let oversized = false; let done = false; let output;
  const timer = setTimeout(() => {
    timedOut = true;
    output.error(new Error('BODY_TIMEOUT'));
    reader.cancel().catch(() => {});
  }, 120000);
  const stream = new ReadableStream({
    start(controller) { output = controller; },
    async pull(controller) {
      try {
        const part = await reader.read();
        if (timedOut) return;
        if (part.done) { done = true; controller.close(); return; }
        size += part.value.byteLength;
        if (size > limit) { oversized = true; controller.error(new Error('FILE_TOO_LARGE')); await reader.cancel(); return; }
        controller.enqueue(part.value);
      } catch (error) { if (!timedOut) controller.error(error); }
    },
    cancel() { return reader.cancel(); },
  });
  try {
    return await new Response(stream, { headers: { 'Content-Type': contentType } }).formData();
  } catch (error) {
    if (timedOut) throw { code: 'BODY_TIMEOUT' };
    if (oversized) throw { code: 'FILE_TOO_LARGE' };
    throw { code: 'INVALID_MULTIPART', name: error?.name };
  } finally {
    clearTimeout(timer);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function documentRequest(chatId, blob, filename, caption) {
  const boundary = `wedding${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const safeName = filename.replace(/[\r\n"\\]/g, '_');
  const prefix = encoder.encode(field('chat_id', chatId) + field('caption', caption) + `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeName}"\r\nContent-Type: ${blob.type}\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const fileReader = blob.stream().getReader(); let phase = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (phase === 0) { phase = 1; controller.enqueue(prefix); return; }
        const chunk = await fileReader.read();
        if (!chunk.done) { controller.enqueue(chunk.value); return; }
        controller.enqueue(suffix); controller.close(); fileReader.releaseLock(); phase = 2;
      } catch (error) { controller.error(error); }
    },
    async cancel() { if (phase !== 2) { await fileReader.cancel(); fileReader.releaseLock(); } },
  });
  const length = prefix.byteLength + blob.size + suffix.byteLength;
  let body = stream;
  // Workers recognize this stream's exact length and emit Content-Length instead of chunked transfer.
  if (typeof FixedLengthStream === 'function') {
    const fixed = new FixedLengthStream(length);
    stream.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  }
  return {
    body,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(length) },
    duplex: 'half',
  };
}
// Structural/resource validation only, not a complete image decoder.
export function validJpeg(bytes, maxDimension = 12000, maxPixels = 24 * 1024 * 1024) {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; let dimensions = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (!marker || marker === 216 || marker === 217 || marker === 1 || (marker >= 208 && marker <= 215)) return false;
    if (offset + 2 > bytes.length - 2) return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length - 2) return false;
    if ([192, 193, 194].includes(marker)) {
      if (length < 8) return false;
      const height = view.getUint16(offset + 3); const width = view.getUint16(offset + 5);
      if (!width || !height || width > maxDimension || height > maxDimension || width * height > maxPixels) return false;
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) return false;
      dimensions = true;
    }
    if (marker === 218) return dimensions && length >= 6 && offset + length < bytes.length - 2;
    offset += length;
  }
  return false;
}

async function originalFormat(file) {
  // Camera originals may append motion-video or vendor metadata after the image.
  // Detect the format from a bounded prefix without requiring image bytes to end the file.
  const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  const jpegMarker = bytes[3];
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && jpegMarker >= 192 && jpegMarker <= 254 && jpegMarker !== 200 && !(jpegMarker >= 208 && jpegMarker <= 217)) return { type: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 20 && bytes.subarray(0, 8).every((n, i) => n === [137, 80, 78, 71, 13, 10, 26, 10][i])) return { type: 'image/png', extension: 'png' };
  if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
    if (size >= 20 && size <= file.size) return { type: 'image/webp', extension: 'webp' };
  }
  const jxlContainer = [0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10];
  if ((bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 10) || (bytes.length >= 12 && jxlContainer.every((n, i) => bytes[i] === n))) return { type: 'image/jxl', extension: 'jxl' };
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { type: 'image/gif', extension: 'gif' };
  if (bytes.length >= 14 && ascii(0, 2) === 'BM') return { type: 'image/bmp', extension: 'bmp' };
  if (bytes.length >= 8 && ((ascii(0, 2) === 'II' && bytes[2] === 42 && bytes[3] === 0) || (ascii(0, 2) === 'MM' && bytes[2] === 0 && bytes[3] === 42))) return { type: 'image/tiff', extension: 'tiff' };
  if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > file.size) return null;
    const brands = [ascii(8, 12)];
    for (let offset = 16; offset + 4 <= Math.min(size, bytes.length); offset += 4) brands.push(ascii(offset, offset + 4));
    if (brands.some(brand => ['avif', 'avis'].includes(brand))) return { type: 'image/avif', extension: 'avif' };
    if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return { type: 'image/heic', extension: 'heic' };
    if (brands.some(brand => ['mif1', 'msf1', 'heif'].includes(brand))) return { type: 'image/heif', extension: 'heif' };
  }
  return null;
}
function originalFilename(name, extension) {
  const base = String(name || 'original').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'original';
  return /\.(jpe?g|png|webp|heic|heif|avif|tiff?|dng|gif|bmp|jxl)$/i.test(base) ? base : `${base}.${extension}`;
}

export async function handleApi(request, env, ctx = {}) {
  let bodySlot;
  let stage = 'request';
  let loggedPhotoId;
  try {
    const db = env.DB;
    if (!db) return failure(503, 'DATABASE_UNAVAILABLE', 'Сервис пока не настроен.');
    const incoming = new URL(request.url);
    const origin = new URL(env.PUBLIC_ORIGIN || '').origin;
    if (!origin.startsWith('https://') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('HTTPS origin required');
    const now = Date.now();
    const ip = await hash(request.headers.get('CF-Connecting-IP') || 'unknown');
    const enabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    if (request.method === 'POST' && request.headers.get('Origin') !== origin) return failure(403, 'INVALID_ORIGIN', 'Недопустимый источник запроса.');
    // A terminated isolate may leave a request in flight. Never automatically resend it.
    await db.prepare("UPDATE photos SET status='unknown' WHERE status='sending' AND created_at<?").bind(now - 300000).run();
    if (ctx.waitUntil) ctx.waitUntil(db.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(now - 86400000).run().catch(() => {}));
    if (request.method === 'GET' && incoming.pathname === '/api/session') {
      if (!await rate(db, `session:${ip}`, 300, 60000, now)) return failure(429, 'RATE_LIMIT', 'Слишком много запросов. Попробуйте позже.');
      let sessionId = await findSession(request, db); let cookie;
      if (!sessionId) {
        const day = new Date(now).toISOString().slice(0, 10);
        if (!await rate(db, `new-session:${ip}:${day}`, numberSetting(env.SESSIONS_PER_IP_PER_DAY, 200), 86400000, now)) return failure(429, 'SESSION_LIMIT', 'Лимит новых сессий для этой сети. Обратитесь к организатору.');
        const value = hex(crypto.getRandomValues(new Uint8Array(32))); sessionId = await hash(value);
        const inserted = await db.prepare('INSERT INTO sessions(id,created_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM sessions)<? RETURNING id').bind(sessionId, now, numberSetting(env.MAX_SESSIONS, 10000)).first();
        if (!inserted) return failure(503, 'SESSION_LIMIT', 'Новые сессии временно недоступны.');
        cookie = `wedding_guest=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${origin.startsWith('https:') ? '; Secure' : ''}`;
      }
      return reply(200, { remaining: await shotsRemaining(db, sessionId), maxShots: 15, uploadsEnabled: enabled }, cookie ? { 'Set-Cookie': cookie } : {});
    }
    if (request.method === 'POST' && incoming.pathname === '/api/admin/session') {
      if (!await rate(db, `pin:${ip}`, 5, 900000, now)) return failure(429, 'RATE_LIMIT', 'Слишком много попыток входа. Попробуйте позже.');
      if (!env.ADMIN_PIN) return failure(503, 'ADMIN_DISABLED', 'Вход организаторов пока не настроен.');
      const sessionId = await findSession(request, db);
      if (!sessionId) return failure(401, 'SESSION_REQUIRED', 'Обновите страницу для создания сессии.');
      if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return failure(415, 'INVALID_REQUEST', 'Ожидается JSON.');
      let submitted;
      try { submitted = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))); }
      catch { return failure(400, 'INVALID_REQUEST', 'Некорректный запрос.'); }
      if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted) || typeof submitted.pin !== 'string') return failure(400, 'INVALID_REQUEST', 'Некорректный запрос.');
      const [actual, expected] = await Promise.all([digest(submitted.pin), digest(env.ADMIN_PIN)]);
      let different = 0; for (let i = 0; i < actual.length; i++) different |= actual[i] ^ expected[i];
      if (different) return failure(401, 'INVALID_PIN', 'Неверный ПИН-код.');
      await db.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at').bind(`admin-session:${sessionId}`, now + 1800000).run();
      return reply(200, { ok: true });
    }
    if (request.method !== 'POST' || incoming.pathname !== '/api/photos') return failure(404, 'NOT_FOUND', 'Не найдено.');
    if (!enabled) return failure(503, 'UPLOADS_DISABLED', 'Отправка фотографий пока не настроена.');
    const sessionId = await findSession(request, db);
    if (!sessionId) return failure(401, 'SESSION_REQUIRED', 'Обновите страницу для создания сессии.');
    if (!await rate(db, `upload-session:${sessionId}`, 30, 60000, now) || !await rate(db, `upload-ip:${ip}`, 300, 60000, now)) return failure(429, 'RATE_LIMIT', 'Слишком много загрузок. Попробуйте позже.');
    const photoId = request.headers.get('X-Photo-Id');
    if (!PHOTO_UUID.test(photoId || '')) return failure(400, 'INVALID_PHOTO_ID', 'Некорректный идентификатор снимка.');
    loggedPhotoId = photoId;
    console.info('wedding_upload_stage', { stage: 'received', photoId });
    async function previousResult() {
      const previous = await db.prepare('SELECT session_id,status FROM photos WHERE id=?').bind(photoId).first();
      if (!previous) return null;
      if (previous.session_id !== sessionId) return failure(409, 'PHOTO_ID_CONFLICT', 'Идентификатор снимка уже используется.');
      if (previous.status === 'delivered') return reply(200, { ok: true, photoId, remaining: await shotsRemaining(db, sessionId) });
      if (previous.status === 'unknown') return failure(409, 'UNKNOWN_DELIVERY', 'Результат отправки неизвестен. Проверьте снимок в Telegram с организатором; не отправляйте повторно.');
      if (previous.status === 'sending') return failure(409, 'DELIVERY_IN_PROGRESS', 'Снимок ещё отправляется. Проверьте позже.');
      return null;
    }
    const previous = await previousResult(); if (previous) return previous;
    const contentType = request.headers.get('Content-Type') || '';
    const mediaType = contentType.split(';')[0].trim();
    if (!['image/jpeg', 'multipart/form-data'].includes(mediaType)) return failure(415, 'INVALID_IMAGE', 'Ожидается фотография с JPEG-предпросмотром.');
    let author;
    try { author = decodeURIComponent(request.headers.get('X-Guest-Name') || '').trim() || 'Гость'; }
    catch { return failure(400, 'INVALID_NAME', 'Некорректное имя.'); }
    if (author.length > 100 || /[\x00-\x1f\x7f]/.test(author)) return failure(400, 'INVALID_NAME', 'Имя должно содержать не более 100 символов без управляющих знаков.');
    const slotKey = `body-slot:${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
    const slotNow = Date.now();
    const acquired = await db.prepare(`INSERT INTO rate_limits(key,count,expires_at)
      SELECT ?,1,? WHERE (SELECT COUNT(*) FROM rate_limits WHERE key LIKE 'body-slot:%' AND expires_at>?)<? RETURNING key`)
      .bind(slotKey, slotNow + 300000, slotNow, numberSetting(env.MAX_CONCURRENT_UPLOADS, 1)).first();
    if (!acquired) return failure(503, 'SERVER_BUSY', 'Сервер занят отправкой снимков. Попробуйте позже.');
    bodySlot = slotKey;
    let previewBytes; let documentBlob; let documentName;
    if (mediaType === 'multipart/form-data') {
      const maxDocument = Math.min(numberSetting(env.MAX_DOCUMENT_BYTES, 50000000), 50000000);
      const maxPreview = 1024 * 1024;
      stage = 'multipart_read';
      let fields;
      try { fields = await multipartFields(request, maxDocument + maxPreview + 64 * 1024, contentType); }
      catch (error) {
        if (error?.code === 'FILE_TOO_LARGE' || error?.code === 'BODY_TIMEOUT') throw error;
        logFailure(stage, photoId, error);
        return failure(400, 'INVALID_REQUEST', 'Некорректная загрузка фотографии.');
      }
      const previewFile = fields.get('preview'); const documentFile = fields.get('document');
      if (!documentFile || typeof documentFile.slice !== 'function' || (previewFile && typeof previewFile.arrayBuffer !== 'function')) return failure(400, 'INVALID_REQUEST', 'Нужен оригинальный файл фотографии.');
      if ((previewFile?.size || 0) > maxPreview || documentFile.size > maxDocument) return failure(413, 'FILE_TOO_LARGE', 'Предпросмотр должен быть до 1 МиБ, оригинал — до 50 МБ.');
      if (previewFile) {
        previewBytes = new Uint8Array(await previewFile.arrayBuffer());
        if (!validJpeg(previewBytes, 1280, 1280 * 1280)) return failure(415, 'INVALID_PREVIEW', 'Нужен JPEG-предпросмотр до 1280 × 1280 пикселей.');
      }
      stage = 'signature_check';
      const format = await originalFormat(documentFile);
      if (!format) return failure(415, 'INVALID_IMAGE', 'Нужен JPEG, PNG, WebP, HEIC, HEIF, AVIF, TIFF/DNG, GIF или BMP.');
      documentBlob = documentFile.slice(0, documentFile.size, format.type);
      documentName = originalFilename(documentFile.name, format.extension);
    } else {
      previewBytes = await boundedBody(request, numberSetting(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024));
      if (!validJpeg(previewBytes)) return failure(415, 'INVALID_IMAGE', 'Некорректный JPEG или превышен предел 24 Мп / 12000 пикселей по стороне.');
      documentBlob = new Blob([previewBytes], { type: 'image/jpeg' });
      documentName = `wedding_${photoId}.jpg`;
    }
    // SQLite serializes this entire statement: cross-isolate quotas and retry ownership are atomic.
    const reservation = await db.prepare(`INSERT INTO photos(id,session_id,status,created_at,message_id)
      SELECT ?,?,'sending',?,NULL WHERE
        (SELECT COUNT(*) FROM photos WHERE session_id=? AND status IN ${COUNTED})<15 AND
        (SELECT COUNT(*) FROM photos WHERE status IN ${COUNTED})<? AND
        (SELECT COUNT(*) FROM photos WHERE status='sending')<?
      ON CONFLICT(id) DO UPDATE SET status='sending',created_at=excluded.created_at,message_id=NULL
        WHERE photos.session_id=excluded.session_id AND photos.status='failed'
      RETURNING id`).bind(photoId, sessionId, Date.now(), sessionId, numberSetting(env.EVENT_UPLOAD_CAP, 3000), numberSetting(env.MAX_CONCURRENT_UPLOADS, 1)).first();
    if (!reservation) {
      const raced = await previousResult(); if (raced) return raced;
      if (!await shotsRemaining(db, sessionId)) return failure(429, 'SHOT_LIMIT', 'Лимит 15 снимков исчерпан.');
      const total = await db.prepare(`SELECT COUNT(*) AS total FROM photos WHERE status IN ${COUNTED}`).first();
      if (Number(total.total) >= numberSetting(env.EVENT_UPLOAD_CAP, 3000)) return failure(429, 'EVENT_LIMIT', 'Достигнут общий лимит мероприятия.');
      return failure(503, 'SERVER_BUSY', 'Сервер занят отправкой снимков. Попробуйте позже.');
    }
    const deliver = async () => {
      try {
        stage = 'preview_checkpoint';
        const checkpoint = await db.prepare('SELECT preview_message_id FROM photos WHERE id=? AND session_id=?').bind(photoId, sessionId).first();
        if (!checkpoint) throw new Error('Missing delivery reservation');
        let previewStatus = checkpoint.preview_message_id > 0 ? 'sent' : checkpoint.preview_message_id === -1 ? 'rejected' : checkpoint.preview_message_id === -2 ? 'unknown' : 'skipped';
        if (checkpoint.preview_message_id == null && previewBytes) {
          const previewForm = new FormData();
          previewForm.append('chat_id', env.TELEGRAM_CHAT_ID);
          previewForm.append('photo', new Blob([previewBytes], { type: 'image/jpeg' }), `wedding_${photoId}.jpg`);
          previewForm.append('caption', `📸 Фото от гостя: ${author}`);
          let previewId;
          stage = 'preview_send';
          console.info('wedding_upload_stage', { stage, photoId });
          try {
            const previewResponse = await (ctx.fetchImpl || fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: previewForm, signal: AbortSignal.timeout(Math.min(numberSetting(env.TELEGRAM_TIMEOUT_MS, 30000), 30000)) });
            const preview = await previewResponse.json();
            if (preview.ok === false) {
              previewId = -1; previewStatus = 'rejected';
              logFailure(stage, photoId, { name: 'TelegramRejected' });
            } else if (preview.ok === true && Number.isSafeInteger(preview.result?.message_id) && preview.result.message_id > 0) {
              previewId = preview.result.message_id; previewStatus = 'sent';
            } else throw new Error('Unrecognized preview response');
          } catch (error) {
            previewId = -2; previewStatus = 'unknown'; logFailure(stage, photoId, error);
          }
          stage = 'preview_checkpoint';
          // Sentinel checkpoints also prevent repeated preview attempts after a document rejection.
          await db.prepare("UPDATE photos SET preview_message_id=? WHERE id=? AND session_id=? AND status='sending'").bind(previewId, photoId, sessionId).run();
        }
        stage = 'document_send';
        console.info('wedding_upload_stage', { stage, photoId });
        const upload = documentRequest(env.TELEGRAM_CHAT_ID, documentBlob, documentName, `📎 Оригинал снимка\nФото от гостя: ${author}`);
        const telegram = await (ctx.fetchImpl || fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', ...upload, signal: AbortSignal.timeout(Math.min(numberSetting(env.TELEGRAM_TIMEOUT_MS, 30000), 30000)) });
        const result = await telegram.json();
        if (result.ok === true) {
          await db.prepare("UPDATE photos SET status='delivered',message_id=? WHERE id=? AND session_id=? AND status IN ('sending','unknown')").bind(result.result?.message_id ?? null, photoId, sessionId).run();
          console.info('wedding_upload_stage', { stage: 'delivered', photoId });
          return reply(200, { ok: true, photoId, remaining: await shotsRemaining(db, sessionId), previewStatus });
        }
        if (result.ok === false) {
          await db.prepare("UPDATE photos SET status='failed' WHERE id=? AND session_id=? AND status IN ('sending','unknown')").bind(photoId, sessionId).run();
          logFailure(stage, photoId, { name: 'TelegramRejected' });
          return failure(502, 'TELEGRAM_REJECTED', 'Telegram отклонил отправку. Попробуйте позже.');
        }
        throw new Error('Unrecognized response');
      } catch (error) {
        logFailure(stage, photoId, error);
        await db.prepare("UPDATE photos SET status='unknown' WHERE id=? AND session_id=? AND status='sending'").bind(photoId, sessionId).run();
        return failure(409, 'UNKNOWN_DELIVERY', 'Результат отправки неизвестен. Организатор должен проверить предпросмотр и файл в Telegram перед повторной отправкой.');
      }
    };
    const delivery = deliver();
    // Keep the same ordered delivery alive briefly even if the browser disconnects.
    if (ctx.waitUntil) ctx.waitUntil(delivery.then(() => {}, () => {}));
    return await delivery;
  } catch (error) {
    logFailure(stage, loggedPhotoId, error);
    if (error?.code === 'FILE_TOO_LARGE') return failure(413, 'FILE_TOO_LARGE', 'Файл слишком большой.');
    if (error?.code === 'BODY_TIMEOUT') return failure(408, 'BODY_TIMEOUT', 'Загрузка заняла слишком много времени. Попробуйте позже.');
    return failure(503, 'SERVER_ERROR', 'Сервис временно недоступен. Попробуйте позже.');
  } finally {
    if (bodySlot) await env.DB.prepare('DELETE FROM rate_limits WHERE key=?').bind(bodySlot).run().catch(() => {});
  }
}
