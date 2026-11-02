import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('let MAX_SHOTS'));

class Element {
    children = []; listeners = {}; classList = { add() {}, remove() {} };
    append(...elements) { this.children.push(...elements); }
    appendChild(element) { this.children.push(element); }
    replaceChildren() { this.children = []; }
    addEventListener(name, action) { this.listeners[name] = action; }
    removeAttribute(name) { delete this[name]; }
    click() {}
}
const record = (id = 'archive-1', extra = {}) => ({
    id, guestName: 'Guest', timestamp: 1000, originalName: 'original.jpg', originalSize: 3,
    photoData: `/api/archive/${id}/preview`, originalData: `/api/archive/${id}/original`, telegramUrl: null, ...extra,
});

function fixture(photos = []) {
    const elements = new Map(), events = new Map(), requests = [], storage = [], zipEntries = [];
    let zipGenerated = 0;
    const context = {
        console, Blob, File, FormData, AbortController, crypto: webcrypto,
        URL: class extends URL { static createObjectURL() { return 'blob:temporary'; } static revokeObjectURL() {} },
        location: { href: 'https://wedding.example/' },
        setTimeout() { return 1; }, clearTimeout() {},
        addEventListener(name, action) { events.set(name, action); },
        localStorage: {
            getItem(key) { storage.push(['read', key]); return null; },
            setItem(key) { storage.push(['write', key]); }
        },
        document: {
            getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
            createElement() { return new Element(); },
            createTextNode(textContent) { return { textContent }; }
        },
        JSZip: class {
            folder() { return { file(name, blob) { zipEntries.push({ name, blob }); } }; }
            async generateAsync() { zipGenerated++; return new Blob(['zip']); }
        },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url === '/api/session') return new Response(JSON.stringify({ remaining: 12, maxShots: 15, uploadsEnabled: true }));
            if (url === '/api/archive') return new Response(JSON.stringify({ photos }));
            if (url.endsWith('/original')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
            throw new Error('Unexpected request');
        }
    };
    Object.defineProperty(context, 'indexedDB', { get() { throw new Error('No local image storage'); } });
    context.window = context;
    vm.createContext(context);
    vm.runInContext(script, context);
    vm.runInContext('var toasts = []; showToast = value => toasts.push(value); openModal = () => {};', context);
    return { context, elements, events, requests, storage, zipEntries, zipGenerated: () => zipGenerated,
        run: source => vm.runInContext(source, context) };
}

test('reload restores own-session metadata without fetching source files or storing photos', async () => {
    const f = fixture([record()]);
    await f.events.get('DOMContentLoaded')();
    assert.deepEqual(f.requests.map(request => request.url), ['/api/session', '/api/archive']);
    assert.equal(f.requests[1].options.credentials, 'same-origin');
    assert.equal(f.requests[1].options.cache, 'no-store');
    assert.equal(f.run('guestPhotos.length'), 1);
    assert.equal(f.run('guestPhotos[0].status'), 'delivered');
    assert.equal(f.run('guestPhotos[0].archived'), true);
    assert.equal(f.run('guestPhotos[0].blob'), undefined);
    assert.equal(f.run('shotsTaken'), 3);
    assert.equal(f.elements.get('shared-album-grid').children.length, 1);
    assert.equal(f.elements.get('mini-gallery').children.length, 1);
    assert.equal(f.storage.some(([, key]) => /photo|shots/i.test(key)), false);
});

test('archive merge keeps RAM originals and pending/unknown/rejected photos without duplicates', async () => {
    const f = fixture([record()]);
    f.run(`sessionReady = true;
        var localBlob = new Blob(['original']);
        guestPhotos = [
            {id:'archive-1',guestId,guestName:'RAM',timestamp:2000,blob:localBlob,photoData:'blob:preview',originalData:'blob:original',status:'pending'},
            {id:'pending-1',guestId,timestamp:3000,status:'pending'},
            {id:'unknown-1',guestId,timestamp:4000,status:'unknown'},
            {id:'rejected-1',guestId,timestamp:5000,status:'rejected'}
        ];`);
    await f.run('refreshGuestArchive()');
    await f.run('refreshGuestArchive()');
    assert.equal(f.run('guestPhotos.length'), 4);
    assert.equal(f.run("guestPhotos.find(photo => photo.id === 'archive-1').blob === localBlob"), true);
    assert.equal(f.run("guestPhotos.find(photo => photo.id === 'archive-1').photoData"), 'blob:preview');
    assert.equal(f.run("guestPhotos.find(photo => photo.id === 'archive-1').status"), 'delivered');
    for (const status of ['pending', 'unknown', 'rejected']) assert.equal(f.run(`guestPhotos.find(photo => photo.id === '${status}-1').status`), status);
});

test('large files open their original in Telegram; historic rows never pretend preview is original', async () => {
    const f = fixture([record('large-1', { originalData: null, photoData: null, telegramUrl: 'https://t.me/c/123/45' }),
        record('historic-1', { originalData: null, photoData: null })]);
    await f.run('refreshGuestArchive()');
    f.run("var large = guestPhotos.find(photo => photo.id === 'large-1'); photoCard(large, false).listeners.click()");
    const link = f.elements.get('lightbox-download-link');
    assert.equal(link.href, 'https://t.me/c/123/45');
    assert.equal(link.target, '_blank');
    assert.equal(link.download, undefined);
    assert.match(f.run('toasts.at(-1)'), /исходным файлом/);
    f.run("photoCard(guestPhotos.find(photo => photo.id === 'historic-1'), false).listeners.click()");
    assert.equal(link.href, '#');
    let prevented = false;
    link.onclick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.match(f.run('toasts.at(-1)'), /нет ссылки скачивания/);
    assert.match(f.elements.get('lightbox-img').src, /^data:image\/svg\+xml/);
    assert.equal(f.requests.some(request => request.url.endsWith('/original')), false);
});

test('ZIP fetches original bytes on demand and never substitutes a preview', async () => {
    const f = fixture([record()]);
    await f.run('refreshGuestArchive()');
    assert.equal(f.requests.some(request => request.url.endsWith('/original')), false);
    await f.run('downloadAllPhotosZip()');
    assert.equal(f.zipGenerated(), 1);
    assert.equal(f.zipEntries.length, 1);
    assert.deepEqual(new Uint8Array(await f.zipEntries[0].blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.equal(f.requests.filter(request => request.url.endsWith('/original')).length, 1);
    assert.equal(f.requests.some(request => request.url.endsWith('/preview')), false);
});

test('ZIP refuses silently partial export when an original is Telegram-only', async () => {
    const f = fixture([record(), record('large-1', { originalData: null, telegramUrl: 'https://t.me/c/123/45' })]);
    await f.run('refreshGuestArchive()');
    await f.run('downloadAllPhotosZip()');
    assert.equal(f.zipGenerated(), 0);
    assert.equal(f.zipEntries.length, 0);
    assert.equal(f.requests.some(request => request.url.endsWith('/original')), false);
    assert.match(f.run('toasts.at(-1)'), /неполный ZIP не создаётся/);
});

test('archive error preserves upload capability and RAM data', async () => {
    const f = fixture();
    f.run("sessionReady = uploadsEnabled = true; guestPhotos = [{id:'pending-1',status:'pending',timestamp:1}]");
    f.context.fetch = async () => { throw new Error('Offline'); };
    assert.equal(await f.run('refreshGuestArchive()'), false);
    assert.equal(f.run('uploadsEnabled'), true);
    assert.equal(f.run('guestPhotos.length'), 1);
    assert.match(f.run('toasts.at(-1)'), /обновить ваши фотографии/);
    assert.doesNotMatch(f.run('toasts.at(-1)'), /подключиться к серверу/);
});

test('unsafe metadata URLs are not used as original or preview URLs', async () => {
    const f = fixture([record('unsafe-1', { originalData: 'https://evil.example/file', photoData: 'javascript:alert(1)', telegramUrl: 'https://evil.example/' })]);
    await f.run('refreshGuestArchive()');
    assert.equal(f.run('guestPhotos[0].originalData'), null);
    assert.equal(f.run('guestPhotos[0].telegramUrl'), null);
    assert.match(f.run('guestPhotos[0].photoData'), /^data:image\/svg\+xml/);
});
