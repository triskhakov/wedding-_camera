import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWeddingServer } from '../server.mjs';

const origin = 'http://127.0.0.1';
// Real 1x1 JPEG; keeps validation tests independent of a decoder package.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==', 'base64');
async function fixture(t, { env = {}, telegram } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wedding-security-'));
  let calls = 0;
  const options = {
    env: { PUBLIC_ORIGIN: origin, DATA_FILE: join(dir, 'uploads.json'), TELEGRAM_BOT_TOKEN: 'test-only-token', TELEGRAM_CHAT_ID: 'test-chat', MAX_UPLOAD_BYTES: '1024', ADMIN_PIN: 'test-secret-pin', ...env },
    fetchImpl: async (...args) => { calls++; return telegram ? telegram(...args) : { json: async () => ({ ok: true, result: { message_id: calls } }) }; },
  };
  let server = createWeddingServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  });
  async function session() {
    const res = await fetch(`${url}/api/session`);
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    return { cookie: cookie.split(';')[0], body: await res.json() };
  }
  async function upload(cookie, { id = randomUUID(), body = jpeg, headers = {} } = {}) {
    return fetch(`${url}/api/photos`, { method: 'POST', body, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'image/jpeg', 'X-Photo-Id': id, 'X-Guest-Name': encodeURIComponent('Гость'), ...headers } });
  }
  async function restart() {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    server = createWeddingServer(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  }
  return { get url() { return url; }, session, upload, restart, calls: () => calls };
}

test('HTML contains no Telegram credential or direct Telegram API upload', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
  assert.doesNotMatch(html, /api\.telegram\.org\/bot/);
});

test('server serves only explicitly public resources', async t => {
  const app = await fixture(t);
  for (const path of ['/.env', '/.env.example', '/data/uploads.json', '/server.mjs', '/package.json', '/%2e%2e/.env']) {
    const res = await fetch(app.url + path);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(await res.text(), /test-only-token|test-secret-pin/);
  }
});

test('uploads require same origin and a server-issued cookie', async t => {
  const app = await fixture(t);
  const { cookie, body } = await app.session();
  assert.equal(body.remaining, 15);
  assert.equal(body.uploadsEnabled, true);
  assert.equal((await app.upload(cookie, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await app.upload(cookie, { headers: { Origin: '' } })).status, 403);
  assert.equal((await app.upload('wedding_guest=' + 'a'.repeat(64))).status, 401);
  assert.equal(app.calls(), 0);
});

test('administrator login rejects bad origin, wrong PIN and absent configuration', async t => {
  const app = await fixture(t);
  const { cookie } = await app.session();
  const login = (url, pin, requestOrigin = origin, guestCookie = cookie) => fetch(`${url}/api/admin/session`, {
    method: 'POST', headers: { Origin: requestOrigin, Cookie: guestCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  assert.equal((await login(app.url, 'test-secret-pin', 'https://attacker.example')).status, 403);
  assert.ok((await login(app.url, 'wrong')).status >= 400);
  assert.equal((await login(app.url, 'test-secret-pin')).status, 200);
  const disabled = await fixture(t, { env: { ADMIN_PIN: '' } });
  const other = await disabled.session();
  assert.ok((await login(disabled.url, '', origin, other.cookie)).status >= 400);
});

test('validation rejects invalid JPEG, excess size, bad IDs and names', async t => {
  const app = await fixture(t);
  const { cookie } = await app.session();
  assert.equal((await app.upload(cookie, { headers: { 'Content-Type': 'text/html' } })).status, 415);
  assert.equal((await app.upload(cookie, { body: Buffer.from('not a JPEG') })).status, 415);
  assert.equal((await app.upload(cookie, { body: Buffer.alloc(1025) })).status, 413);
  assert.equal((await app.upload(cookie, { body: Buffer.from([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]) })).status, 415);
  const oversizedDimensions = Buffer.from(jpeg);
  const sof = oversizedDimensions.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0);
  oversizedDimensions.writeUInt16BE(13000, sof + 5);
  assert.equal((await app.upload(cookie, { body: oversizedDimensions })).status, 415);
  assert.equal((await app.upload(cookie, { id: '../../file' })).status, 400);
  assert.equal((await app.upload(cookie, { headers: { 'X-Guest-Name': encodeURIComponent('x'.repeat(101)) } })).status, 400);
  assert.equal((await app.upload(cookie, { headers: { 'X-Guest-Name': '%ZZ' } })).status, 400);
  assert.equal(app.calls(), 0);
});

test('delivered retries are idempotent and IDs cannot cross sessions', async t => {
  const app = await fixture(t);
  const { cookie } = await app.session();
  const id = randomUUID();
  assert.equal((await app.upload(cookie, { id })).status, 200);
  const retry = await app.upload(cookie, { id });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).remaining, 14);
  assert.equal(app.calls(), 1);
  const other = await app.session();
  assert.equal((await app.upload(other.cookie, { id })).status, 409);
  assert.equal(app.calls(), 1);
});

test('concurrent uploads reserve quota before contacting Telegram', async t => {
  const app = await fixture(t, { env: { MAX_CONCURRENT_UPLOADS: '20' }, telegram: async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return { json: async () => ({ ok: true }) };
  } });
  const { cookie } = await app.session();
  const responses = await Promise.all(Array.from({ length: 16 }, () => app.upload(cookie)));
  assert.equal(responses.filter(res => res.status === 200).length, 15);
  assert.equal(responses.filter(res => res.status === 429).length, 1);
  assert.equal(app.calls(), 15);
});

test('explicit Telegram rejection frees quota and permits retry', async t => {
  let reject = true;
  const app = await fixture(t, { telegram: async () => ({ json: async () => ({ ok: !reject }) }) });
  const { cookie } = await app.session();
  const id = randomUUID();
  assert.equal((await app.upload(cookie, { id })).status, 502);
  const session = await fetch(`${app.url}/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await session.json()).remaining, 15);
  reject = false;
  assert.equal((await app.upload(cookie, { id })).status, 200);
  assert.equal(app.calls(), 2);
});

test('ambiguous delivery does not silently duplicate a Telegram photo', async t => {
  const app = await fixture(t, { telegram: async () => { throw new Error('Network lost after sending'); } });
  const { cookie } = await app.session();
  const id = randomUUID();
  const first = await app.upload(cookie, { id });
  assert.equal(first.status, 409);
  assert.equal((await first.json()).code, 'UNKNOWN_DELIVERY');
  assert.equal((await app.upload(cookie, { id })).status, 409);
  assert.equal(app.calls(), 1);
});

test('delivered state and guest quota survive a server restart', async t => {
  const app = await fixture(t);
  const { cookie } = await app.session();
  const id = randomUUID();
  assert.equal((await app.upload(cookie, { id })).status, 200);
  await app.restart();
  const retry = await app.upload(cookie, { id });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).remaining, 14);
  assert.equal(app.calls(), 1);
});

test('unknown delivery survives restart and continues blocking duplicate sends', async t => {
  const app = await fixture(t, { telegram: async () => { throw new Error('Connection lost'); } });
  const { cookie } = await app.session();
  const id = randomUUID();
  assert.equal((await app.upload(cookie, { id })).status, 409);
  await app.restart();
  const retry = await app.upload(cookie, { id });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, 'UNKNOWN_DELIVERY');
  const session = await fetch(`${app.url}/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await session.json()).remaining, 14);
  assert.equal(app.calls(), 1);
});
