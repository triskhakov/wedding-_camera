import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('let MAX_SHOTS'));
const MiB = 1024 * 1024;
const originalBytes = new Uint8Array([255, 216, 255, 225, 0, 8, 69, 88, 73, 70, 1, 2, 3, 255, 217]);

function fixture({ width = 8000, height = 6000, decode = 'success', storedNames = null,
    encodedSize = () => 300, uploadError = null } = {}) {
    const encodings = [], overlays = [], posts = [], storage = [], timers = new Map(), revoked = [];
    let timerId = 0;
    let now = Date.now();
    const canvas = {
        width: 0, height: 0,
        getContext() { return { drawImage() {} }; },
        toBlob(callback, type, quality) {
            encodings.push({ width: this.width, height: this.height, quality });
            const size = encodedSize({ width: this.width, height: this.height, quality });
            queueMicrotask(() => callback(size === null ? null : new Blob([new Uint8Array(size)], { type })));
        }
    };
    const elements = new Map([['hidden-canvas', canvas]]);
    const context = {
        console, Blob, File, FormData, AbortController, crypto: webcrypto,
        Date: class extends Date { static now() { return now; } },
        location: { href: 'https://wedding.example/' },
        setTimeout(action, delay) { const id = ++timerId; timers.set(id, { action, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        addEventListener() {},
        URL: { createObjectURL() { return 'blob:temporary'; }, revokeObjectURL(url) { revoked.push(url); } },
        Image: class {
            naturalWidth = width;
            naturalHeight = height;
            set src(value) {
                if (decode === 'timeout') return;
                queueMicrotask(() => decode === 'success' ? this.onload?.() : this.onerror?.({ type: 'error' }));
            }
        },
        localStorage: {
            getItem(key) { storage.push(['read', key]); return key === 'wedding_cfg_names' ? storedNames : null; },
            setItem(key, value) { storage.push(['write', key, value]); }
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} } });
                return elements.get(id);
            }
        },
        fetch: async (url, options) => {
            if (url === '/api/session') return { ok: true, json: async () => ({ remaining: 15, maxShots: 15, uploadsEnabled: true }) };
            assert.equal(url, '/api/photos');
            posts.push(options);
            return uploadError ? { ok: false, json: async () => uploadError }
                : { ok: true, json: async () => ({ ok: true, photoId: options.headers['X-Photo-Id'], remaining: 14 }) };
        }
    };
    Object.defineProperty(context, 'indexedDB', { get() { throw new Error('Persistent photo storage is forbidden'); } });
    context.window = context;
    vm.createContext(context);
    vm.runInContext(script, context);
    context.trackOverlay = (w, h) => overlays.push({ width: w, height: h });
    vm.runInContext(`
        var toasts = [], statuses = [];
        showToast = value => toasts.push(value);
        engineStatus = value => statuses.push(value);
        renderMiniGallery = renderSharedAlbumFromLocal = updateShotsCounterUI = () => {};
        playShutterSound = triggerFlash = openModal = () => {};
        applyCanvasWeddingOverlay = (ctx, w, h) => trackOverlay(w, h);
        uploadsEnabled = sessionReady = true;
    `, context);
    const run = source => vm.runInContext(source, context);
    const original = new File([originalBytes], 'IMG_8123.jpg', { type: 'image/jpeg' });
    async function capture(file = original) {
        context.captureEvent = { target: { files: [file], value: 'camera-image' } };
        await run('handleNativeCameraCapture(captureEvent)');
    }
    async function fireRetry() {
        const entry = [...timers].find(([, timer]) => timer.delay < 75000);
        assert.ok(entry, 'expected one scheduled retry');
        const [id, timer] = entry;
        timers.delete(id);
        now += timer.delay;
        await timer.action();
    }
    return { capture, context, run, canvas, encodings, overlays, posts, storage, timers, revoked, original, elements, fireRetry };
}

test('48MP capture sends separate preview and unmodified original bytes/name/type', async () => {
    const f = fixture();
    await f.capture();
    assert.equal(f.posts.length, 1);
    const post = f.posts[0];
    assert.ok(post.body instanceof FormData);
    assert.equal(Object.keys(post.headers).some(key => key.toLowerCase() === 'content-type'), false);
    const document = post.body.get('document'), preview = post.body.get('preview');
    assert.equal(document.name, f.original.name);
    assert.equal(document.type, f.original.type);
    assert.deepEqual(new Uint8Array(await document.arrayBuffer()), originalBytes);
    assert.equal(preview.type, 'image/jpeg');
    assert.ok(preview.size <= MiB);
    assert.notDeepEqual(new Uint8Array(await preview.arrayBuffer()), originalBytes);
    assert.equal(f.encodings[0].width, 1280);
    assert.equal(f.encodings[0].height, 960);
    assert.equal(f.encodings[0].quality, 0.90);
    assert.equal(f.overlays.length, 1);
    assert.equal(f.run('guestPhotos[0].blob'), f.original);
    assert.equal(f.run('guestPhotos[0].status'), 'delivered');
    assert.equal(f.canvas.width, 0);
    assert.equal(f.canvas.height, 0);
    assert.equal(f.context.captureEvent.target.value, '');
    assert.equal(f.run('captureBusy'), false);
});

test('empty MIME is accepted when decoded and document bytes remain untouched', async () => {
    const f = fixture({ width: 640, height: 480 });
    const original = new File([originalBytes], 'camera-file', { type: '' });
    await f.capture(original);
    assert.equal(f.posts.length, 1);
    assert.deepEqual(new Uint8Array(await f.posts[0].body.get('document').arrayBuffer()), originalBytes);
    assert.equal(f.posts[0].body.get('document').name, 'camera-file');
    assert.equal(f.encodings[0].width, 640);
    assert.equal(f.encodings[0].height, 480);
});

test('oversized preview is recompressed without changing the original', async () => {
    const f = fixture({ encodedSize: ({ quality }) => quality > 0.82 ? 2 * MiB : 500 });
    await f.capture();
    assert.deepEqual(f.encodings.map(({ quality }) => quality), [0.90, 0.82]);
    assert.equal(f.posts[0].body.get('preview').size, 500);
    assert.deepEqual(new Uint8Array(await f.posts[0].body.get('document').arrayBuffer()), originalBytes);
});

test('original over50MB is explicitly rejected without compression or upload', async () => {
    const f = fixture();
    await f.capture({ size: 50_000_001, type: 'image/jpeg', name: 'huge.jpg' });
    assert.equal(f.posts.length, 0);
    assert.equal(f.encodings.length, 0);
    assert.match(f.run('toasts.at(-1)'), /Оригинал превышает 50 МБ/);
});

test('decode failure and timeout still upload unchanged original without a preview', async () => {
    const failed = fixture({ decode: 'failure' });
    await failed.capture();
    assert.equal(failed.posts.length, 1);
    assert.equal(failed.posts[0].body.get('preview'), null);
    assert.deepEqual(new Uint8Array(await failed.posts[0].body.get('document').arrayBuffer()), originalBytes);
    assert.match(failed.run('toasts[0]'), /Отправляем исходный файл/);
    assert.match(failed.run('guestPhotos[0].photoData'), /^data:image\/svg\+xml/);
    assert.equal(failed.run('captureBusy'), false);
    const timedOut = fixture({ decode: 'timeout' });
    const pending = timedOut.capture();
    [...timedOut.timers.values()].find(timer => timer.delay === 30000).action();
    await pending;
    assert.equal(timedOut.posts.length, 1);
    assert.equal(timedOut.posts[0].body.get('preview'), null);
    assert.deepEqual(new Uint8Array(await timedOut.posts[0].body.get('document').arrayBuffer()), originalBytes);
    assert.equal(timedOut.run('captureBusy'), false);
});

test('preview encoder failure never blocks the original', async () => {
    const f = fixture({ encodedSize: () => null });
    await f.capture();
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0].body.get('preview'), null);
    assert.deepEqual(new Uint8Array(await f.posts[0].body.get('document').arrayBuffer()), originalBytes);
    assert.equal(f.canvas.width, 0);
    assert.equal(f.canvas.height, 0);
});

test('25MB original is sent byte-for-byte without resizing or compression', async () => {
    const f = fixture();
    const data = new Uint8Array(25_000_000);
    data.set(originalBytes);
    data[data.length - 1] = 71;
    const original = new File([data], 'large-original.HEIC', { type: 'image/heic' });
    await f.capture(original);
    assert.equal(f.posts.length, 1);
    const document = f.posts[0].body.get('document');
    assert.equal(document.size, data.length);
    assert.equal(document.name, 'large-original.HEIC');
    assert.equal(document.type, 'image/heic');
    assert.deepEqual(new Uint8Array(await document.arrayBuffer()), data);
});

test('camera data exists only in current-tab RAM and lightbox downloads original', async () => {
    const f = fixture();
    await f.capture();
    assert.equal(f.storage.some(([, key]) => /photo|shots/i.test(key)), false);
    assert.doesNotMatch(script, /indexedDB|persistPhoto|wedding_local_photos|toDataURL/);
    assert.equal(fixture().run('guestPhotos.length'), 0);
    f.run("openLightbox('blob:preview', 'Guest', 'blob:original', 'original.HEIC')");
    assert.equal(f.elements.get('lightbox-download-link').href, 'blob:original');
    assert.equal(f.elements.get('lightbox-download-link').download, 'original.HEIC');
});

test('old default names migrate, custom names remain intact, visible defaults are renamed', () => {
    assert.equal(fixture({ storedNames: 'Anvar & Ugiljon' }).run('weddingSettings.names'), 'Anvar & Oʻgʻiljon');
    assert.equal(fixture({ storedNames: 'Custom wedding' }).run('weddingSettings.names'), 'Custom wedding');
    const markup = html.slice(0, html.indexOf('<!-- JAVASCRIPT APPLICATION LOGIC -->'));
    assert.doesNotMatch(markup, /Anvar & Ugiljon/);
    assert.match(markup, /<title>Anvar & Oʻgʻiljon/);
    assert.match(markup, /hostname === "triskhakov.github.io"/);
});

test('INVALID_NAME is a permanent rejection and displays server message as text', async () => {
    const message = 'Имя должно содержать не более 100 символов.';
    const f = fixture({ uploadError: { ok: false, code: 'INVALID_NAME', message } });
    await f.capture();
    assert.equal(f.run('guestPhotos[0].status'), 'rejected');
    assert.ok(f.run('toasts.at(-1)').includes(message));
    assert.match(f.run('toasts.at(-1)'), /INVALID_NAME/);
    await f.run('retryPendingPhotos()');
    assert.equal(f.posts.length, 1);
});

test('malformed UTF16 name cannot throw before fetch', async () => {
    const f = fixture();
    f.run("guestName = '\\ud800'");
    await f.capture();
    assert.equal(f.posts.length, 1);
    assert.equal(decodeURIComponent(f.posts[0].headers['X-Guest-Name']), '\uFFFD');
});

test('request construction failure is distinct from network failure and never retried', async () => {
    const f = fixture();
    f.context.FormData = class { append() { throw new TypeError('Unsupported append'); } };
    await f.capture();
    assert.equal(f.posts.length, 0);
    assert.equal(f.run('guestPhotos[0].status'), 'rejected');
    assert.match(f.run('toasts.at(-1)'), /UPLOAD_PREPARE/);
    assert.equal(f.timers.size, 0);
});

test('missing AbortController still permits upload', async () => {
    const f = fixture();
    f.context.AbortController = undefined;
    await f.capture();
    assert.equal(f.posts.length, 1);
    assert.equal(f.run('guestPhotos[0].status'), 'delivered');
});

test('nonJSON gateway response reports HTTP status and retries without exposing response contents', async () => {
    const f = fixture();
    f.context.fetch = async () => ({ ok: false, status: 502, json: async () => { throw Error('private response content'); } });
    await f.capture();
    assert.match(f.run('toasts.at(-1)'), /HTTP 502, NON_JSON_RESPONSE/);
    assert.doesNotMatch(f.run('toasts.at(-1)'), /private response content/);
    assert.equal(f.run('guestPhotos[0].retryable'), true);
    assert.equal(f.timers.size, 1);
});

test('network retry queue is bounded to three retries and always reuses photo ID and original bytes', async () => {
    const f = fixture();
    const requests = [];
    f.context.fetch = async (url, options) => { requests.push(options); throw TypeError('Failed to fetch'); };
    await f.capture();
    assert.match(f.run('toasts.at(-1)'), /UPLOAD_NETWORK/);
    for (let attempt = 0; attempt < 3; attempt++) await f.fireRetry();
    assert.equal(requests.length, 4);
    assert.equal(new Set(requests.map(request => request.headers['X-Photo-Id'])).size, 1);
    for (const request of requests) assert.deepEqual(new Uint8Array(await request.body.get('document').arrayBuffer()), originalBytes);
    assert.equal(f.run('guestPhotos[0].retryCount'), 3);
    assert.equal(f.timers.size, 0);
});

test('busy response schedules retry; delivered response clears retry queue', async () => {
    const f = fixture({ uploadError: { ok: false, code: 'SERVER_BUSY', message: 'Busy' } });
    await f.capture();
    assert.equal(f.run('guestPhotos[0].status'), 'pending');
    assert.equal(f.timers.size, 1);
    f.context.fetch = async (url, options) => ({ ok: true, status: 200, json: async () => ({ ok: true, photoId: options.headers['X-Photo-Id'], remaining: 14 }) });
    await f.fireRetry();
    assert.equal(f.run('guestPhotos[0].status'), 'delivered');
    assert.equal(f.timers.size, 0);
});

test('only one retry worker uploads even when online and timer triggers overlap', async () => {
    const f = fixture({ uploadError: { ok: false, code: 'SERVER_BUSY', message: 'Busy' } });
    await f.capture();
    let calls = 0, resolveRequest;
    f.context.fetch = (url, options) => {
        calls++;
        return new Promise(resolve => {
            resolveRequest = () => resolve({ ok: true, status: 200,
                json: async () => ({ ok: true, photoId: options.headers['X-Photo-Id'], remaining: 14 }) });
        });
    };
    const pending = f.fireRetry();
    await f.run('retryPendingPhotos()');
    assert.equal(calls, 1);
    resolveRequest();
    await pending;
    assert.equal(f.run('guestPhotos[0].status'), 'delivered');
    assert.equal(f.timers.size, 0);
});

test('UNKNOWN_DELIVERY never creates a retry timer', async () => {
    const f = fixture({ uploadError: { ok: false, code: 'UNKNOWN_DELIVERY' } });
    await f.capture();
    assert.equal(f.run('guestPhotos[0].status'), 'unknown');
    assert.equal(f.timers.size, 0);
    await f.run('retryPendingPhotos()');
    assert.equal(f.posts.length, 1);
});
