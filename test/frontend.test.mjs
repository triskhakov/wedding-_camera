import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('let MAX_SHOTS'));

class Element {
    children = [];
    listeners = {};
    classList = { add() {}, remove() {} };
    append(...elements) { this.children.push(...elements); }
    appendChild(element) { this.children.push(element); }
    replaceChildren() { this.children = []; }
    addEventListener(name, action) { this.listeners[name] = action; }
}

function fixture({ seed = true } = {}) {
    const elements = new Map();
    const storageAccess = [];
    const events = new Map();
    const context = {
        console, Blob, URL, AbortController, crypto: webcrypto,
        location: { href: 'http://localhost/' },
        setTimeout() { return 1; }, clearTimeout() {},
        addEventListener(name, action) { events.set(name, action); },
        localStorage: {
            getItem(key) { storageAccess.push(['read', key]); return null; },
            setItem(key, value) { storageAccess.push(['write', key, value]); },
            removeItem(key) { storageAccess.push(['remove', key]); }
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, new Element());
                return elements.get(id);
            },
            createElement() { return new Element(); },
            createTextNode(text) { return { textContent: text }; }
        }
    };
    Object.defineProperty(context, 'indexedDB', { get() { throw new Error('Photo storage must not be accessed'); } });
    context.window = context;
    vm.createContext(context);
    vm.runInContext(script, context);
    vm.runInContext(`
        var toasts = [];
        showToast = message => toasts.push(message);
        engineStatus = () => {};
        updateShotsCounterUI = () => {};
        openModal = () => {};
        uploadsEnabled = true;
        var photo = {id: 'photo-1', guestName: "');globalThis.injected=1;//", blob: new Blob(['jpeg']), status: 'pending'};
    `, context);
    if (seed) vm.runInContext('guestPhotos = [photo]', context);
    return { context, elements, events, storageAccess, run: source => vm.runInContext(source, context) };
}

test('guest names remain inert in both gallery cards', () => {
    const { run, context, elements } = fixture();
    for (const mini of [true, false]) {
        const card = run(`photoCard({...photo, photoData: 'blob:local'}, ${mini})`);
        card.listeners.click();
        assert.equal(context.injected, undefined);
        assert.equal(elements.get('lightbox-author').innerText, "Фото от: ');globalThis.injected=1;//");
        assert.equal(card.children[0].src, 'blob:local');
    }
});

test('success requires server acknowledgement and uses server quota', async () => {
    const { run, context } = fixture();
    let resolveFetch;
    context.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
    const pending = run('uploadToCloud(photo)');
    await Promise.resolve();
    assert.equal(run('photo.status'), 'uploading');
    assert.equal(run('toasts.length'), 0);
    resolveFetch({ ok: true, json: async () => ({ ok: true, photoId: 'photo-1', remaining: 14 }) });
    await pending;
    assert.equal(run('photo.status'), 'delivered');
    assert.equal(run('shotsTaken'), 1);
});

test('unknown delivery remains in RAM and is never automatically retried', async () => {
    const { run, context } = fixture();
    context.fetch = async url => url === '/api/session'
        ? { ok: true, json: async () => ({ maxShots: 15, remaining: 14, uploadsEnabled: true }) }
        : { ok: false, json: async () => ({ ok: false, code: 'UNKNOWN_DELIVERY' }) };
    await run('uploadToCloud(photo)');
    assert.equal(run('photo.status'), 'unknown');
    let calls = 0;
    context.fetch = async () => { calls++; throw new Error('Unexpected retry'); };
    await run('retryPendingPhotos()');
    assert.equal(calls, 0);
});

test('lost response preserves pending data and retry uses same photo ID', async () => {
    const { run, context } = fixture();
    const ids = [];
    context.fetch = async (url, options) => {
        ids.push(options.headers['X-Photo-Id']);
        throw new Error('Connection lost');
    };
    await run('uploadToCloud(photo)');
    assert.equal(run('photo.status'), 'pending');
    assert.equal(run('guestPhotos[0].blob.size'), 4);
    await run('retryPendingPhotos()');
    assert.deepEqual(ids, ['photo-1', 'photo-1']);
});

test('photos are neither stored nor restored; reload starts with empty previews', async () => {
    const { run, context, events, storageAccess } = fixture({ seed: false });
    context.fetch = async url => {
        if (url === '/api/session') return { ok: true, json: async () => ({ maxShots: 15, remaining: 15, uploadsEnabled: true }) };
        throw new Error('Offline');
    };
    await events.get('DOMContentLoaded')();
    assert.equal(run('guestPhotos.length'), 0);
    await run("savePhotoEntry(new Blob(['jpeg']))");
    assert.equal(run('guestPhotos.length'), 1);
    assert.equal(run('guestPhotos[0].status'), 'pending');
    assert.equal(run('guestPhotos[0].blob.size'), 4);
    assert.equal(storageAccess.some(([, key]) => /photo|shots/i.test(key)), false);
    assert.equal(storageAccess.some(([action]) => action === 'remove'), false);
    assert.doesNotMatch(script, /indexedDB|persistPhoto|wedding_local_photos|toDataURL/);
    assert.equal(fixture({ seed: false }).run('guestPhotos.length'), 0);
    assert.equal(run("toasts.some(message => message.includes('сохранено на устройстве'))"), false);
});

test('permanently rejected images are not automatically sent again', async () => {
    const { run, context } = fixture();
    context.fetch = async url => url === '/api/session'
        ? { ok: true, json: async () => ({ maxShots: 15, remaining: 15, uploadsEnabled: true }) }
        : { ok: false, json: async () => ({ ok: false, code: 'INVALID_IMAGE' }) };
    await run('uploadToCloud(photo)');
    assert.equal(run('photo.status'), 'rejected');
    let calls = 0;
    context.fetch = async () => { calls++; };
    await run('retryPendingPhotos()');
    assert.equal(calls, 0);
});
