import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { handleApi } from '../worker/api.mjs';

// A real 1x1 JPEG; no image bytes are stored in the metadata database.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==', 'base64');
const origin = 'https://wedding.test';

async function telegramForm(options) {
  if (options.body instanceof FormData) return options.body;
  const headers = new Headers(options.headers);
  const bytes = await new Response(options.body).arrayBuffer();
  assert.equal(Number(headers.get('Content-Length')), bytes.byteLength, 'streamed multipart length must match the actual body');
  return new Response(bytes, { headers }).formData();
}

// Exercise the actual SQL against SQLite instead of mocking query outcomes.
class D1Adapter {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) {
    const stmt = this.sqlite.prepare(sql);
    const make = args => ({
      bind: (...next) => make(next),
      first: async column => { const row = stmt.get(...args); return column ? row?.[column] ?? null : row ?? null; },
      all: async () => ({ success: true, results: stmt.all(...args) }),
      run: async () => { const result = stmt.run(...args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    });
    return make([]);
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = await Promise.all(statements.map(stmt => stmt.all())); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

function fixture(t, { env = {}, telegram } = {}) {
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
  const sqlite = new DatabaseSync(':memory:');
  for (const filename of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  let calls = 0;
  const settings = { DB: new D1Adapter(sqlite), PUBLIC_ORIGIN: origin, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat', ADMIN_PIN: 'secret-pin', MAX_UPLOAD_BYTES: '1024', ...env };
  const pending = [];
  const context = () => ({
    fetchImpl: async (...args) => { calls++; return telegram ? telegram(...args) : { json: async () => ({ ok: true, result: { message_id: calls } }) }; },
    waitUntil: promise => pending.push(promise),
  });
  async function request(path, { method = 'GET', cookie, body, headers = {} } = {}) {
    const req = new Request(origin + path, { method, body, headers: { 'CF-Connecting-IP': '192.0.2.1', ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: origin } : {}), ...headers } });
    const response = await handleApi(req, settings, context());
    await Promise.all(pending.splice(0));
    return response;
  }
  async function session() {
    const res = await request('/api/session');
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
    return { cookie: cookie.split(';')[0], body: await res.json() };
  }
  const upload = (cookie, { id = randomUUID(), body = jpeg, headers = {} } = {}) => request('/api/photos', { method: 'POST', cookie, body, headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Id': id, 'X-Guest-Name': encodeURIComponent('Гость'), ...headers } });
  return { sqlite, settings, request, session, upload, calls: () => calls };
}

test('session metadata persists across request contexts and cannot expose secrets', async t => {
  const app = fixture(t);
  const { cookie, body } = await app.session();
  assert.equal(body.remaining, 15); assert.equal(body.uploadsEnabled, true);
  const res = await app.request('/api/session', { cookie });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(app.sqlite.prepare('SELECT count(*) n FROM sessions').get().n, 1);
  assert.doesNotMatch(await res.text(), /test-token|secret-pin/);
});

test('origin, authentication, JPEG structure and payload bounds are enforced', async t => {
  const app = fixture(t); const { cookie } = await app.session();
  assert.equal((await app.upload(cookie, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await app.upload('wedding_guest=' + 'a'.repeat(64))).status, 401);
  assert.equal((await app.upload(cookie, { body: Buffer.alloc(1025) })).status, 413);
  assert.equal((await app.upload(cookie, { body: Buffer.from([255, 216, 255, 0, 255, 217]) })).status, 415);
  assert.equal((await app.upload(cookie, { headers: { 'Content-Type': 'text/html' } })).status, 415);
  assert.equal((await app.upload(cookie, { id: 'invalid' })).status, 400);
  assert.equal(app.calls(), 0);
});

test('delivered ID retries across contexts do not send twice or cross sessions', async t => {
  const app = fixture(t); const { cookie } = await app.session(); const id = randomUUID();
  assert.equal((await app.upload(cookie, { id })).status, 200);
  const retry = await app.upload(cookie, { id }); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).remaining, 14); assert.equal(app.calls(), 2);
  const other = await app.session(); assert.equal((await app.upload(other.cookie, { id })).status, 409);
});

test('atomic SQL reservation enforces 15 shots across concurrent contexts', async t => {
  const app = fixture(t, { env: { MAX_CONCURRENT_UPLOADS: '20' }, telegram: async () => {
    await new Promise(resolve => setTimeout(resolve, 10)); return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  const { cookie } = await app.session();
  const responses = await Promise.all(Array.from({ length: 16 }, () => app.upload(cookie)));
  assert.equal(responses.filter(r => r.status === 200).length, 15);
  assert.equal(responses.filter(r => r.status === 429).length, 1); assert.equal(app.calls(), 30);
});

test('known Telegram rejection permits retry, unknown result forbids resend', async t => {
  let mode = 'reject';
  const app = fixture(t, { telegram: async () => {
    if (mode === 'unknown') throw new Error('connection lost');
    return { json: async () => ({ ok: mode === 'success', result: { message_id: 1 } }) };
  } });
  const { cookie } = await app.session(); const id = randomUUID();
  assert.equal((await app.upload(cookie, { id })).status, 502);
  mode = 'success'; assert.equal((await app.upload(cookie, { id })).status, 200);
  mode = 'unknown'; const ambiguous = randomUUID();
  assert.equal((await app.upload(cookie, { id: ambiguous })).status, 409);
  const retry = await app.upload(cookie, { id: ambiguous });
  assert.equal((await retry.json()).code, 'UNKNOWN_DELIVERY'); assert.equal(app.calls(), 5);
});

test('event quota is shared by different guest sessions', async t => {
  const app = fixture(t, { env: { EVENT_UPLOAD_CAP: '1', MAX_CONCURRENT_UPLOADS: '20' } });
  const first = await app.session(); const second = await app.session();
  const responses = await Promise.all([app.upload(first.cookie), app.upload(second.cookie)]);
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  const rejected = responses.find(r => r.status === 429);
  assert.ok(rejected); assert.equal((await rejected.json()).code, 'EVENT_LIMIT');
  assert.equal(app.calls(), 2);
});

test('concurrent duplicate photo ID has a single Telegram owner', async t => {
  const app = fixture(t, { env: { MAX_CONCURRENT_UPLOADS: '20' }, telegram: async () => {
    await new Promise(resolve => setTimeout(resolve, 10)); return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  const { cookie } = await app.session(); const id = randomUUID();
  const responses = await Promise.all([app.upload(cookie, { id }), app.upload(cookie, { id })]);
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 1);
  assert.equal(app.calls(), 2);
});

test('abandoned sending reservation becomes unknown without a new Telegram attempt', async t => {
  const app = fixture(t); const { cookie } = await app.session(); const id = randomUUID();
  const sessionId = app.sqlite.prepare('SELECT id FROM sessions').get().id;
  app.sqlite.prepare("INSERT INTO photos(id,session_id,status,created_at) VALUES (?,?,'sending',?)").run(id, sessionId, Date.now() - 400000);
  const retry = await app.upload(cookie, { id }); assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, 'UNKNOWN_DELIVERY'); assert.equal(app.calls(), 0);
});

test('admin authentication rejects incorrect PIN and records only server-side expiry', async t => {
  const app = fixture(t); const { cookie } = await app.session();
  const login = pin => app.request('/api/admin/session', { method: 'POST', cookie, body: JSON.stringify({ pin }), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await login('wrong')).status, 401); assert.equal((await login('secret-pin')).status, 200);
  assert.equal(app.sqlite.prepare("SELECT count(*) n FROM rate_limits WHERE key LIKE 'admin-session:%' AND expires_at>?").get(Date.now()).n, 1);
  app.settings.ADMIN_PIN = ''; assert.equal((await login('')).status, 503);
});

test('multipart sends preview first and preserves every original document byte', async t => {
  const sent = [];
  const app = fixture(t, { telegram: async (url, options) => {
    const method = url.split('/').at(-1);
    const fields = await telegramForm(options);
    const file = fields.get(method === 'sendPhoto' ? 'photo' : 'document');
    sent.push({ method, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
    return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  } });
  const { cookie } = await app.session(); const id = randomUUID();
  // APP1 data stands for original metadata that must not be stripped/re-encoded.
  const original = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 225, 0, 8, 69, 88, 73, 70, 0, 0]), jpeg.subarray(2)]);
  const body = new FormData();
  body.append('preview', new Blob([jpeg], { type: 'image/jpeg' }), 'preview.jpg');
  body.append('document', new Blob([original], { type: 'image/jpeg' }), 'original-camera.jpg');
  const res = await app.request('/api/photos', { method: 'POST', cookie, body, headers: { 'X-Photo-Id': id, 'X-Guest-Name': encodeURIComponent('Гость') } });
  assert.equal(res.status, 200);
  assert.deepEqual(sent.map(item => item.method), ['sendPhoto', 'sendDocument']);
  assert.deepEqual(sent[0].bytes, jpeg);
  assert.deepEqual(sent[1].bytes, original);
  assert.equal(sent[1].name, 'original-camera.jpg');
  const saved = app.sqlite.prepare('SELECT status,preview_message_id,message_id FROM photos WHERE id=?').get(id);
  assert.deepEqual({ ...saved }, { status: 'delivered', preview_message_id: 1, message_id: 2 });
});

test('document rejection retries only the document after preview checkpoint', async t => {
  const sent = []; let rejectDocument = true;
  const app = fixture(t, { telegram: async url => {
    const method = url.split('/').at(-1); sent.push(method);
    return { json: async () => ({ ok: !(method === 'sendDocument' && rejectDocument), result: { message_id: sent.length } }) };
  } });
  const { cookie } = await app.session(); const id = randomUUID();
  assert.equal((await app.upload(cookie, { id })).status, 502);
  assert.equal(app.sqlite.prepare('SELECT preview_message_id FROM photos WHERE id=?').get(id).preview_message_id, 1);
  rejectDocument = false;
  assert.equal((await app.upload(cookie, { id })).status, 200);
  assert.deepEqual(sent, ['sendPhoto', 'sendDocument', 'sendDocument']);
  assert.equal((await app.upload(cookie, { id })).status, 200);
  assert.equal(app.calls(), 3);
});

test('unknown document delivery never resends either preview or original', async t => {
  const sent = [];
  const app = fixture(t, { telegram: async url => {
    const method = url.split('/').at(-1); sent.push(method);
    if (method === 'sendDocument') throw new Error('Connection lost after document submission');
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  const { cookie } = await app.session(); const id = randomUUID();
  const first = await app.upload(cookie, { id });
  assert.equal(first.status, 409); assert.equal((await first.json()).code, 'UNKNOWN_DELIVERY');
  const retry = await app.upload(cookie, { id });
  assert.equal(retry.status, 409); assert.equal((await retry.json()).code, 'UNKNOWN_DELIVERY');
  assert.deepEqual(sent, ['sendPhoto', 'sendDocument']);
  assert.equal(app.sqlite.prepare('SELECT preview_message_id FROM photos WHERE id=?').get(id).preview_message_id, 1);
});

function originalUpload(app, cookie, { id = randomUUID(), original = jpeg, preview, name = 'camera.jpg', headers = {} } = {}) {
  const body = new FormData();
  if (preview) body.append('preview', new Blob([preview], { type: 'image/jpeg' }), 'preview.jpg');
  body.append('document', new Blob([original]), name);
  return app.request('/api/photos', { method: 'POST', cookie, body, headers: { 'X-Photo-Id': id, ...headers } });
}

test('an original HEIC file is sent unchanged when browser cannot create a preview', async t => {
  const original = Buffer.concat([Buffer.from('000000186674797068656963000000006d69663168656963', 'hex'), Buffer.from('camera metadata and original encoded pixels')]);
  const sent = [];
  const app = fixture(t, { telegram: async (url, options) => {
    sent.push(url.split('/').at(-1));
    const fields = await telegramForm(options);
    const file = fields.get('document');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), original);
    assert.equal(file.name, 'camera.heic');
    return { json: async () => ({ ok: true, result: { message_id: 5 } }) };
  } });
  const { cookie } = await app.session(); const id = randomUUID();
  const res = await originalUpload(app, cookie, { id, original, name: 'camera.heic' });
  assert.equal(res.status, 200);
  assert.deepEqual(sent, ['sendDocument']);
  assert.equal((await app.upload(cookie, { id })).status, 200);
  assert.equal(app.calls(), 1);
});

for (const mode of ['rejected', 'unknown']) {
  test(`preview ${mode} does not block the original or repeat on retry`, async t => {
    const sent = []; let rejectDocument = true;
    const app = fixture(t, { telegram: async (url, options) => {
      const method = url.split('/').at(-1); sent.push(method);
      if (method === 'sendPhoto') {
        if (mode === 'unknown') throw new Error('Preview transport failed');
        return { json: async () => ({ ok: false, error_code: 400, description: 'Preview refused' }) };
      }
      const fields = await telegramForm(options);
      assert.deepEqual(Buffer.from(await fields.get('document').arrayBuffer()), jpeg);
      return { json: async () => ({ ok: !rejectDocument, result: { message_id: 9 } }) };
    } });
    const { cookie } = await app.session(); const id = randomUUID();
    assert.equal((await originalUpload(app, cookie, { id, preview: jpeg })).status, 502);
    const checkpoint = app.sqlite.prepare('SELECT preview_message_id FROM photos WHERE id=?').get(id).preview_message_id;
    assert.equal(checkpoint, mode === 'rejected' ? -1 : -2);
    rejectDocument = false;
    const retry = await originalUpload(app, cookie, { id, preview: jpeg });
    assert.equal(retry.status, 200);
    assert.deepEqual(sent, ['sendPhoto', 'sendDocument', 'sendDocument']);
  });
  test(`preview ${mode} still reports success when the original is delivered`, async t => {
    const sent = [];
    const app = fixture(t, { telegram: async url => {
      const method = url.split('/').at(-1); sent.push(method);
      if (method === 'sendPhoto') {
        if (mode === 'unknown') throw new Error('Preview connection lost');
        return { json: async () => ({ ok: false }) };
      }
      return { json: async () => ({ ok: true, result: { message_id: 7 } }) };
    } });
    const { cookie } = await app.session(); const id = randomUUID();
    const res = await originalUpload(app, cookie, { id, preview: jpeg });
    assert.equal(res.status, 200);
    assert.deepEqual(sent, ['sendPhoto', 'sendDocument']);
    assert.equal(app.sqlite.prepare('SELECT status FROM photos WHERE id=?').get(id).status, 'delivered');
  });
}

test('configured original file limit rejects oversized multipart before Telegram', async t => {
  const app = fixture(t, { env: { MAX_DOCUMENT_BYTES: '64' } });
  const { cookie } = await app.session();
  const res = await originalUpload(app, cookie, { original: jpeg });
  assert.equal(res.status, 413);
  assert.equal(app.calls(), 0);
});

test('diagnostics exclude Telegram credentials, guest names and raw error details', async t => {
  const app = fixture(t, { telegram: async () => {
    throw new Error('https://api.telegram.org/bottest-token/sendDocument guest=PrivateGuest chat=test-chat');
  } });
  const errors = t.mock.method(console, 'error', () => {});
  const { cookie } = await app.session();
  const res = await originalUpload(app, cookie, { headers: { 'X-Guest-Name': 'PrivateGuest' } });
  assert.equal(res.status, 409);
  assert.ok(errors.mock.callCount() > 0);
  const diagnostics = JSON.stringify(errors.mock.calls.map(call => call.arguments));
  assert.doesNotMatch(diagnostics, /test-token|PrivateGuest|test-chat|api\.telegram\.org/);
  assert.doesNotMatch(await res.text(), /test-token|PrivateGuest|test-chat|api\.telegram\.org/);
});
