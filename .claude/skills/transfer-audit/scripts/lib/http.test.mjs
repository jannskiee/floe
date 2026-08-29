// node --test .claude/skills/<skill>/scripts/lib/http.test.mjs
// The source-grep safety test lives here: no script under scripts/** may
// name the POST method, pass a body to fetch, or mention the stats report
// path outside a route-abort line. The needles are assembled from parts so
// this file does not trip its own scan.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
    HttpError,
    get,
    getDerived,
    getJson,
    head,
    neverBody,
} from './http.mjs';

const SCRIPTS = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);

function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules') continue;
            walk(abs, out);
        } else if (/\.(mjs|js|ps1)$/.test(e.name)) out.push(abs);
    }
    return out;
}

const POST_NEEDLES = [
    `method: '${'PO' + 'ST'}'`,
    `method: "${'PO' + 'ST'}"`,
    `method:'${'PO' + 'ST'}'`,
    `method:"${'PO' + 'ST'}"`,
    `${'Invoke-WebRequest'} -Method ${'Po' + 'st'}`,
    `-Method ${'PO' + 'ST'}`,
];
const STATS_PATH = '/api/stats/' + 'report';

test('no script names the POST method or sends a fetch body', () => {
    const offenders = [];
    for (const file of walk(SCRIPTS)) {
        const src = readFileSync(file, 'utf8');
        for (const needle of POST_NEEDLES)
            if (src.includes(needle)) offenders.push(`${file}: ${needle}`);
        const re = /fetch(?:Impl)?\(([\s\S]{0,600}?)\)\s*[;.]/g;
        let m;
        while ((m = re.exec(src))) {
            if (/\bbody\s*:/.test(m[1]))
                offenders.push(
                    `${file}: fetch with a body near offset ${m.index}`
                );
        }
        const lines = src.split(/\r?\n/);
        lines.forEach((line, i) => {
            if (
                line.includes(STATS_PATH) &&
                !/route\(|abort|blocked|guardStats|\/\/|\*/.test(line)
            )
                offenders.push(
                    `${file}:${i + 1}: ${STATS_PATH} outside a route-abort line`
                );
        });
    }
    assert.deepEqual(offenders, []);
});

test('no script writes under os.tmpdir(): every scratch path descends from --out', () => {
    const offenders = [];
    const needle = 'tmpdir' + '(';
    for (const file of walk(SCRIPTS)) {
        if (file.endsWith('.test.mjs') || /[\\/]tests[\\/]/.test(file))
            continue;
        const src = readFileSync(file, 'utf8');
        src.split(/\r?\n/).forEach((line, i) => {
            if (!line.includes(needle)) return;
            // The one sanctioned use: the default --out itself (lta-runs),
            // which the fence then governs like any operator-supplied --out.
            if (path.basename(file) === 'args.mjs' && /lta-runs/.test(line))
                return;
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(offenders, []);
});

test('every corepack or pnpm shell-out sets COREPACK_ENABLE_AUTO_PIN=0', () => {
    const offenders = [];
    for (const file of walk(SCRIPTS)) {
        if (file.endsWith('.test.mjs')) continue;
        const src = readFileSync(file, 'utf8');
        const shellsOut =
            /(spawn|execFile|execFileSync|spawnSync)\([^)]*['"](corepack|pnpm)(\.cmd)?['"]/.test(
                src
            ) || /['"]corepack['"],\s*\[\s*['"]pnpm['"]/.test(src);
        if (shellsOut && !src.includes('COREPACK_ENABLE_AUTO_PIN'))
            offenders.push(file);
    }
    assert.deepEqual(offenders, []);
});

test('http.mjs exports are GET or HEAD only and neverBody is exported', () => {
    const src = readFileSync(path.join(SCRIPTS, 'lib', 'http.mjs'), 'utf8');
    const methods = [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
    assert.ok(methods.length >= 3);
    assert.ok(
        methods.every((m) => m === 'GET' || m === 'HEAD'),
        methods.join(',')
    );
    assert.equal(neverBody, true);
});

function serve(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () =>
            resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })
        );
    });
}

test('get, getJson, head and getDerived against a local server', async () => {
    const seen = [];
    const { srv, url } = await serve((req, res) => {
        seen.push(req.method);
        if (req.url === '/slow') return setTimeout(() => res.end('late'), 500);
        if (req.url === '/text') return res.end('hello');
        if (req.url === '/turn') {
            const body = JSON.stringify([
                { urls: 'stun:x' },
                {
                    urls: ['turn:x?transport=udp'],
                    username: 'USER-SECRET',
                    credential: 'CRED-SECRET',
                },
            ]);
            res.setHeader('content-length', Buffer.byteLength(body));
            return res.end(body);
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'healthy', uptime: 5 }));
    });
    try {
        const t = await get(`${url}/text`);
        assert.equal(t.status, 200);
        assert.equal(t.text, 'hello');
        const j = await getJson(`${url}/health`);
        assert.equal(j.json.status, 'healthy');
        const h = await head(`${url}/health`);
        assert.equal(h.status, 200);
        const d = await getDerived(`${url}/turn`, (json) => ({
            n: json.length,
        }));
        assert.deepEqual(d.derived, { n: 2 });
        assert.equal(d.bodyJson, true);
        assert.equal(d.neverBody, true);
        assert.ok(!JSON.stringify(d).includes('SECRET'));
        assert.ok(d.contentLength > 0);
        await assert.rejects(
            get(`${url}/slow`, { timeoutMs: 50 }),
            (e) => e instanceof HttpError && /timed out/.test(e.message)
        );
        const nonJson = await getDerived(`${url}/text`, (json) =>
            json === null ? 'not-json' : 'json'
        );
        assert.equal(nonJson.derived, 'not-json');
        assert.equal(
            nonJson.bodyJson,
            false,
            'the caller can tell "not JSON" from a JSON null'
        );
        assert.ok(
            seen.every((m) => m === 'GET' || m === 'HEAD'),
            seen.join(',')
        );
    } finally {
        srv.close();
    }
});

test('getDerived needs a derive function', async () => {
    await assert.rejects(getDerived('http://127.0.0.1:9/x', null), HttpError);
});
