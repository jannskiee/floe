// lib/caddy.mjs, the local Docker Caddy of TA-14 (H-DIR-W2D-reqcaddy), with a
// fake exec: no Docker, no container, no port. What a real run would issue
// is asserted command by command, so the one live unknown left is Docker
// itself (the card's INFERRED items), and a dry run of the cell costs nothing.
//
// Run: node --test .claude/skills/transfer-audit/scripts/lib/caddy.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
    CADDY_CONFIG,
    CADDY_IMAGE,
    CaddyProxy,
    caddyUpstream,
    dockerVersion,
    renderCaddyfile,
    startCaddy,
} from './caddy.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'caddy-test-'));
const ID = 'a'.repeat(64);

/** A fake exec that records every call and answers docker by argv. */
function fakeDocker({ version = '27.3.1', runOut = `${ID}\n`, fail = null } = {}) {
    const calls = [];
    const exec = (cmd, args, opts = {}) => {
        calls.push({ cmd, args: [...args], opts: { ...opts } });
        if (fail && fail(cmd, args)) throw new Error(`fake: ${cmd} ${args[0]} failed`);
        if (cmd !== 'docker') throw new Error(`fake: unexpected ${cmd}`);
        if (args[0] === 'version') return version;
        if (args[0] === 'run') return runOut;
        return '';
    };
    return { exec, calls };
}

test('renderCaddyfile: one loopback site proxying to the upstream, auto HTTPS off, and Caddy\'s own reload behavior (no stream_close_delay)', () => {
    const text = renderCaddyfile({ port: 45123, upstream: 'host.docker.internal:3001' });
    assert.match(text, /auto_https off/);
    assert.match(text, /^:45123 \{$/m);
    assert.match(text, /^\treverse_proxy host\.docker\.internal:3001$/m);
    assert.ok(!/stream_close_delay/.test(text), 'a reload must close the proxied WebSockets, as production does');
    assert.ok(!/\r/.test(text), 'LF only');
    assert.throws(() => renderCaddyfile({ port: 0, upstream: 'host.docker.internal:3001' }), /port/);
    assert.throws(() => renderCaddyfile({ port: 45123, upstream: 'api.floe.one:443' }), /loopback/);
});

test('caddyUpstream turns the local server into its Docker host address and refuses anything that is not loopback (never api.floe.one, OD-33)', () => {
    assert.equal(caddyUpstream('http://localhost:3001'), 'host.docker.internal:3001');
    assert.equal(caddyUpstream('http://127.0.0.1:3001/'), 'host.docker.internal:3001');
    for (const bad of ['https://api.floe.one', 'http://10.0.0.5:3001', 'ftp://localhost:3001', '', null])
        assert.throws(() => caddyUpstream(bad), /loopback/, String(bad));
});

test('CaddyProxy: start publishes on 127.0.0.1 only and mounts the rendered file, reload is the one caddy reload, stop removes only its own container, once', async () => {
    const dir = tmp();
    try {
        const { exec, calls } = fakeDocker();
        const c = new CaddyProxy({ exec, runDir: dir, port: 45123, upstream: 'host.docker.internal:3001', now: () => 1000 });
        const s = await c.start();
        assert.equal(s.url, 'http://127.0.0.1:45123');
        assert.equal(c.url, 'http://127.0.0.1:45123');
        const file = path.join(dir, 'Caddyfile');
        assert.ok(existsSync(file));
        assert.match(readFileSync(file, 'utf8'), /reverse_proxy host\.docker\.internal:3001/);
        const run = calls.find((x) => x.args[0] === 'run');
        assert.deepEqual(run.args, [
            'run', '--rm', '-d',
            '-p', '127.0.0.1:45123:45123',
            '-v', `${file}:${CADDY_CONFIG}:ro`,
            CADDY_IMAGE,
        ]);
        assert.equal(run.opts.windowsHide, true, 'no console window takes the foreground (FU-02)');
        const r = await c.reload();
        assert.equal(r.at, 1000);
        const reload = calls.find((x) => x.args[0] === 'exec');
        assert.deepEqual(reload.args, ['exec', ID, 'caddy', 'reload', '--config', CADDY_CONFIG, '--force']);
        await c.stop();
        await c.stop();
        const rms = calls.filter((x) => x.args[0] === 'rm');
        assert.equal(rms.length, 1, 'one stop, however many callers');
        assert.deepEqual(rms[0].args, ['rm', '-f', ID]);
        for (const x of calls) assert.equal(x.opts.windowsHide, true, x.args.join(' '));
        await assert.rejects(c.reload(), /stopped/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('CaddyProxy refuses an id docker run did not print, and an upstream or port it cannot vouch for, before anything starts', async () => {
    const dir = tmp();
    try {
        const odd = fakeDocker({ runOut: 'Unable to find image locally\n' });
        const c = new CaddyProxy({ exec: odd.exec, runDir: dir, port: 45124, upstream: 'host.docker.internal:3001' });
        await assert.rejects(c.start(), /container id/);
        assert.throws(
            () => new CaddyProxy({ exec: odd.exec, runDir: dir, port: 45125, upstream: 'api.floe.one:443' }),
            /loopback/
        );
        assert.throws(
            () => new CaddyProxy({ exec: odd.exec, runDir: dir, port: 80, upstream: 'host.docker.internal:3001' }),
            /port/
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('startCaddy without Docker is SKIP docker-absent and writes nothing; with it, one version read, then the container', async () => {
    const dir = tmp();
    try {
        const absent = fakeDocker({ fail: (cmd, args) => cmd === 'docker' && args[0] === 'version' });
        await assert.rejects(
            startCaddy({ upstream: 'http://localhost:3001', exec: absent.exec, runDir: dir, port: 45126 }),
            (e) => e.verdict === 'SKIP' && e.reason === 'docker-absent'
        );
        assert.equal(existsSync(path.join(dir, 'Caddyfile')), false);
        assert.equal(absent.calls.filter((x) => x.args[0] === 'run').length, 0);

        const ok = fakeDocker();
        assert.equal(dockerVersion({ exec: ok.exec }).ok, true);
        const before = ok.calls.length;
        const c = await startCaddy({ upstream: 'http://localhost:3001', exec: ok.exec, runDir: dir, port: 45127 });
        assert.equal(c.url, 'http://127.0.0.1:45127');
        assert.deepEqual(ok.calls.slice(before).map((x) => x.args[0]), ['version', 'run']);
        await c.stop();
        await assert.rejects(
            startCaddy({ upstream: 'https://api.floe.one', exec: ok.exec, runDir: dir, port: 45128 }),
            /loopback/
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
