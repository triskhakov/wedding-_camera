import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { cwd: root, stdio: 'pipe' });
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const source = readFileSync(resolve(root, 'dist/server/index.js'), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;

test('built Worker serves the exact source interface at both page URLs', async () => {
    for (const pathname of ['/', '/index.html']) {
        const response = await worker.fetch(new Request('https://wedding.example' + pathname), {}, {});
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.equal(await response.text(), html);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
});

test('HEAD serves page headers without a body', async () => {
    const response = await worker.fetch(new Request('https://wedding.example/', { method: 'HEAD' }), {}, {});
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
});

test('source interface contains no bot credentials or persistent photo storage', () => {
    assert.doesNotMatch(html, /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
    assert.doesNotMatch(html, /api\.telegram\.org|telegramBotToken|CLOUD_CONFIG/);
    assert.doesNotMatch(html, /indexedDB|persistPhoto|wedding_local_photos|toDataURL/);
    assert.match(html, /fetch\('\/api\/photos'/);
    assert.match(html, /credentials:\s*'same-origin'/);
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (match[1].trim()) new vm.Script(match[1]);
    }
});

test('artifact contains only the Worker and hosting manifest', () => {
    assert.deepEqual(readdirSync(resolve(root, 'dist')).sort(), ['.openai', 'server']);
    assert.deepEqual(readdirSync(resolve(root, 'dist/server')), ['index.js']);
    assert.deepEqual(readdirSync(resolve(root, 'dist/.openai')), ['hosting.json']);
    assert.deepEqual(JSON.parse(readFileSync(resolve(root, 'dist/.openai/hosting.json'), 'utf8')),
        JSON.parse(readFileSync(resolve(root, '.openai/hosting.json'), 'utf8')));
    assert.equal(readFileSync(resolve(root, 'worker/index.js'), 'utf8'), source);
});
