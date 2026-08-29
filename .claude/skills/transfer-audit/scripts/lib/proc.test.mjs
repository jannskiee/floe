/**
 * Fixture tests for proc.mjs against tests/fake-floe.mjs, a Node script
 * that prints the shipped CLI's shapes (share box, markers, a \r-redrawn
 * progress bar, the summary box, cobra's "Error: " line) per
 * FAKE_FLOE_MODE, so the splitter, the transcript, the waiters and the
 * kill guard are exercised without a floe binary or a network.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/proc.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { PhaseError, SafetyError } from './surfaces.mjs';
import {
    EXIT_MAP,
    STDERR_CLASSES,
    classifyExit,
    creationTime,
    creationTimeAsync,
    firstErrorLine,
    imageOf,
    killAllStarted,
    killTree,
    processImage,
    registerPid,
    spawnFloe,
    started,
    tail,
} from './proc.mjs';

const FAKE = fileURLToPath(new URL('./tests/fake-floe.mjs', import.meta.url));
const WIN = process.platform === 'win32';
const made = [];

function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'transfer-audit-proc-'));
    made.push(dir);
    return dir;
}

function fake(mode, args, extraEnv = {}) {
    return spawnFloe({
        bin: process.execPath,
        args: [FAKE, ...args],
        env: {
            ...process.env,
            FAKE_FLOE_MODE: mode,
            FAKE_FLOE_DELAY_MS: '10',
            ...extraEnv,
        },
        label: `${mode}-${args[0]}`,
        evidenceDir: fresh(),
    });
}

after(() => {
    killAllStarted();
    for (const d of made)
        rmSync(d, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
        });
});

test('a normal send splits \\r redraws into lines and stamps the transcript', async () => {
    const h = fake('normal', [
        'send',
        'a.bin',
        '--server',
        'http://127.0.0.1:9',
    ]);
    const exit = await h.waitExit(10_000);
    assert.equal(exit.code, 0);
    const text = h.lines.map((l) => l.line);
    assert.ok(text.includes('  Waiting for peer...'));
    assert.ok(text.includes('  Connecting...'));
    assert.ok(text.includes('  Connected'));
    const redraws = h.lines.filter((l) => /^ {2}\[1\/1\] /.test(l.line));
    assert.ok(
        redraws.length >= 5,
        `expected 5 redraw lines, got ${redraws.length}`
    );
    assert.ok(text.every((l) => !l.includes('\r')));
    assert.ok(h.stdout.includes('\r'), 'raw stdout keeps the carriage returns');
    const transcript = readFileSync(h.transcriptPath, 'utf8');
    assert.match(transcript, /^\[\+\d+ms out\] /m);
    const stamps = [...transcript.matchAll(/\[\+(\d+)ms (out|err)\]/g)].map(
        (m) => Number(m[1])
    );
    assert.ok(stamps.length >= 3);
    for (let i = 1; i < stamps.length; i++)
        assert.ok(stamps[i] >= stamps[i - 1]);
    assert.ok(transcript.includes('\r'), 'transcript keeps the raw chunk');
    assert.equal(started.get(h.pid).image, imageOf(process.execPath));
});

test('waitLine resolves on a buffered line and on a future line', async () => {
    const h = fake('normal', ['send', 'a.bin'], { FAKE_FLOE_DELAY_MS: '150' });
    const first = await h.waitLine(/Waiting for peer/, 5000);
    assert.equal(first.line, '  Waiting for peer...');
    assert.equal(first.stream, 'out');
    // Already buffered by now.
    const again = await h.waitLine(/Waiting for peer/, 10);
    assert.equal(again.line, first.line);
    const later = await h.waitLine(/^ {2}Connected$/, 5000);
    assert.ok(later.t >= first.t);
    await h.waitExit(10_000);
});

test('waitLine times out with the tail of both streams', async () => {
    const h = fake('stall', ['send', 'a.bin']);
    await h.waitLine(/Connected/, 5000);
    await assert.rejects(h.waitLine(/never printed/, 300), (err) => {
        assert.ok(err instanceof PhaseError);
        assert.equal(err.phase, 'timeout');
        assert.match(err.message, /stdout: /);
        assert.match(err.message, /Waiting for peer/);
        return true;
    });
    assert.ok(h.exit === null);
    killTree(h.pid);
    const exit = await h.waitExit(5000);
    assert.ok(exit, 'killed process exits');
});

test('waitLine rejects on exit, or resolves null with exitIsError false', async () => {
    const h = fake('exit130', ['send', 'a.bin']);
    await assert.rejects(h.waitLine(/Sent/, 5000), (err) => {
        assert.equal(err.phase, 'exited');
        assert.match(err.message, /code 130/);
        return true;
    });
    assert.equal(h.exit.code, 130);
    assert.ok(
        h.lines.some((l) => l.stream === 'err' && l.line === '  Canceled.')
    );
    assert.equal(await h.waitLine(/Sent/, 5000, { exitIsError: false }), null);
});

test('waitExit returns null on timeout and the exit record after a kill', async () => {
    const h = fake('stall', ['receive', 'amber-otter-cloud']);
    await h.waitLine(/Connected/, 5000);
    assert.equal(await h.waitExit(300), null);
    assert.ok(h.stalledFor() >= 0);
    assert.equal(h.stalled(), false, 'well under the 60 s stall budget');
    const result = killTree(h.pid);
    assert.equal(result.killed, true);
    const exit = await h.waitExit(5000);
    assert.ok(exit && exit.code !== 0);
});

test('killTree refuses a pid this run did not start', () => {
    assert.throws(
        () => killTree(process.pid),
        (err) => {
            assert.ok(err instanceof SafetyError);
            assert.match(err.message, /not started by this run/);
            return true;
        }
    );
    assert.throws(() => killTree(999999), /not started by this run/);
});

test('killTree refuses when the image behind the pid changed', async () => {
    const h = fake('stall', ['send', 'a.bin']);
    await h.waitLine(/Connected/, 5000);
    const meta = started.get(h.pid);
    const real = meta.image;
    meta.image = 'decoy.exe';
    assert.throws(
        () => killTree(h.pid),
        (err) => {
            assert.ok(err instanceof SafetyError);
            assert.match(err.message, /image .* is not the decoy\.exe/);
            return true;
        }
    );
    assert.equal(h.exit, null, 'still running after the refusal');
    meta.image = real;
    assert.equal(killTree(h.pid).killed, true);
    await h.waitExit(5000);
});

test('killTree reports an exited pid as gone without consulting tasklist', async () => {
    const h = fake('normal', ['send', 'a.bin']);
    await h.waitExit(10_000);
    assert.equal(processImage(h.pid), null);
    assert.deepEqual(killTree(h.pid), {
        killed: false,
        reason: 'exited before the kill',
    });
    // An entry the registry never saw exit falls back to the image check.
    const meta = started.get(h.pid);
    meta.exited = null;
    assert.deepEqual(killTree(h.pid), {
        killed: false,
        reason: 'already gone',
    });
    meta.exited = h.exit;
});

test('the registry marks an exited pid and never kills a recycled one under a stale entry', async () => {
    const a = fake('normal', ['send', 'a.bin']);
    await a.waitExit(10_000);
    const stale = started.get(a.pid);
    assert.ok(stale.exited, 'the close event marks the entry');
    assert.equal(stale.exited.code, 0);
    // A live decoy whose pid the registry believes is the exited process
    // (what a same-image pid recycle looks like from here).
    const decoy = fake('stall', ['send', 'a.bin']);
    await decoy.waitLine(/Connected/, 5000);
    const own = started.get(decoy.pid);
    started.set(decoy.pid, stale);
    try {
        assert.deepEqual(killTree(decoy.pid), {
            killed: false,
            reason: 'exited before the kill',
        });
        assert.equal(
            await decoy.waitExit(300),
            null,
            'the decoy is still running'
        );
    } finally {
        started.set(decoy.pid, own);
    }
    const results = killAllStarted();
    assert.ok(!started.has(a.pid), 'killAllStarted prunes the exited entry');
    assert.ok(
        results.some((r) => r.pid === decoy.pid && r.killed),
        JSON.stringify(results)
    );
    assert.ok(await decoy.waitExit(5000));
});

test('creation time: recorded after the spawn, and a changed stamp refuses the kill', async () => {
    const h = fake('stall', ['send', 'a.bin']);
    await h.waitLine(/Connected/, 5000);
    const meta = started.get(h.pid);
    for (let i = 0; i < 150 && meta.creation === null; i++)
        await new Promise((r) => setTimeout(r, 100));
    assert.ok(meta.creation, 'the background lookup filled in the stamp');
    assert.equal(creationTime(h.pid), meta.creation, 'the sync lookup agrees');
    assert.equal(await creationTimeAsync(h.pid), meta.creation);
    const real = meta.creation;
    meta.creation = '1999-01-01T00:00:00.0000000Z';
    assert.throws(
        () => killTree(h.pid),
        (err) => {
            assert.ok(err instanceof SafetyError);
            assert.match(err.message, /created at .* not the 1999-01-01/);
            assert.equal(err.expected, '1999-01-01T00:00:00.0000000Z');
            return true;
        }
    );
    assert.equal(h.exit, null, 'still running after the refusal');
    meta.creation = real;
    assert.equal(killTree(h.pid).killed, true);
    await h.waitExit(5000);
    assert.equal(creationTime(999999), null);
    assert.equal(creationTime(0), null);
    assert.equal(await creationTimeAsync(-1), null);
});

test('registerPid records a pid the run caused but did not spawn, once per incarnation', async () => {
    const decoy = fake('stall', ['receive', 'x']);
    await decoy.waitLine(/Connected/, 5000);
    const own = started.get(decoy.pid);
    assert.equal(
        registerPid(decoy.pid, { image: 'other.exe', label: 'dup' }),
        own,
        'a live entry is kept as is'
    );
    assert.equal(registerPid(0, { image: 'x.exe' }), null);
    assert.equal(registerPid(12, {}), null, 'no image, no entry');
    killTree(decoy.pid);
    await decoy.waitExit(5000);
    // After the exit a fresh registration replaces the stale entry; an
    // explicit null creation skips the background lookup.
    const fresh = registerPid(decoy.pid, {
        image: 'FLOE-DESKTOP.EXE',
        label: 'desktop',
        argv: ['x'],
        creation: null,
    });
    assert.notEqual(fresh, own);
    assert.equal(fresh.image, 'floe-desktop.exe');
    assert.equal(fresh.creation, null);
    assert.equal(fresh.exited, null);
    assert.equal(killTree(decoy.pid).killed, false, 'gone, never a kill');
    started.delete(decoy.pid);
});

test('stderr is split and classified too', async () => {
    const h = fake('refusal', ['send', 'a.bin']);
    const exit = await h.waitExit(10_000);
    assert.equal(exit.code, 1);
    const err = h.lines.find((l) => l.stream === 'err');
    assert.match(
        err.line,
        /^Error: transfer blocked: relay connections are capped at 2 GB \(selected /
    );
    assert.deepEqual(classifyExit(exit.code, h.stderr), {
        code: 1,
        kind: 'error',
        class: 'relay-cap-refusal',
    });
    assert.equal(firstErrorLine(h.stderr), err.line);
    assert.match(tail(h), /^\nstderr: Error: transfer blocked/);
});

test('a missing binary settles the waiters with the spawn error', async () => {
    const h = spawnFloe({
        bin: 'transfer-audit-no-such-binary-xyz',
        args: ['send'],
        label: 'missing',
        evidenceDir: fresh(),
    });
    await assert.rejects(h.waitLine(/anything/, 5000), (err) => {
        assert.equal(err.phase, 'exited');
        assert.match(err.message, /ENOENT/);
        return true;
    });
    assert.equal(h.exit.code, null);
    assert.match(h.exit.error, /ENOENT/);
    assert.deepEqual(classifyExit(h.exit.code, h.stderr), {
        code: null,
        kind: 'killed',
        class: null,
    });
});

test('classifyExit: the exit map and every stderr class', () => {
    assert.deepEqual(EXIT_MAP, { 0: 'ok', 1: 'error', 130: 'canceled' });
    assert.equal(classifyExit(0, '').kind, 'ok');
    assert.equal(classifyExit(130, '\n  Canceled.\n').kind, 'canceled');
    assert.equal(classifyExit(7, '').kind, 'unknown');
    assert.equal(classifyExit(0, '').class, null);
    const samples = {
        'relay-cap-refusal':
            'Error: transfer blocked: relay connections are capped at 2 GB (selected 3.0 GB)\n',
        'stall-before-metadata':
            'Error: connected, but no data arrived from the sender within 30s\n',
        'stall-mid-file':
            'Error: transfer stalled: no data for 1m0s (5 of 12 bytes of "a.bin")\n',
        'role-race':
            'Error: expected sender role, got "receiver" (room may already have two peers)\n',
        'code-expired':
            'Error: could not resolve "x-y-z": code "x-y-z" not found or expired (codes expire after 10 minutes)\n',
        'code-spent':
            'Error: this code is no longer active; ask for a new one\n',
        'room-full':
            'Error: room is full (someone else may already be receiving)\n',
        'peer-refused':
            'Error: connection closed before any file arrived (the sender canceled, or the transfer was blocked)\n',
        'ack-timeout':
            'Error: error sending a.bin: timed out waiting for ack\n',
        'connect-timeout':
            'Error: WebRTC setup failed: timed out establishing a connection\n',
        incompatible:
            'Error: Cannot transfer: your floe is too old for this peer.\n  You: protocol 1 (1.10.5)  Peer: protocol 2 (1.11.0)\n  Run `floe update` to upgrade.\n',
        'ice-fetch-failed': 'Error: failed to fetch ICE credentials: x\n',
        'signaling-connect-failed':
            'Error: failed to connect to signaling server: cannot connect to signaling server at ws://127.0.0.1:9/ws: dial tcp 127.0.0.1:9: connectex: No connection could be made\n',
        'code-unreachable':
            'Error: could not resolve "a-b-c": could not reach signaling server: Get "http://127.0.0.1:9/api/code/a-b-c": dial tcp: refused\n',
        'peer-left-early': 'Error: peer disconnected before connecting\n',
    };
    for (const [name] of STDERR_CLASSES) {
        assert.ok(name in samples, `no sample for ${name}`);
        assert.equal(classifyExit(1, samples[name]).class, name, name);
    }
    assert.equal(
        classifyExit(
            1,
            'Error: WebRTC setup failed: timed out waiting for the peer to answer'
        ).class,
        'connect-timeout'
    );
    assert.equal(
        classifyExit(
            1,
            "Error: WebRTC setup failed: timed out waiting for the peer's offer"
        ).class,
        'connect-timeout'
    );
    assert.equal(classifyExit(1, 'Error: something new').class, null);
});

test('imageOf names what tasklist will report', () => {
    assert.equal(imageOf('C:\\Users\\x\\scoop\\shims\\floe.exe'), 'floe.exe');
    assert.equal(imageOf('/usr/local/bin/floe'), WIN ? 'floe.exe' : 'floe');
    assert.equal(imageOf('FLOE.EXE'), 'floe.exe');
});

test(
    'killTree: a pid that ends between the image check and taskkill is "exited during the kill", not a throw',
    { skip: !WIN },
    () => {
        const pid = 4_000_001;
        started.set(pid, {
            image: 'floe.exe',
            label: 'race',
            argv: [],
            t0: Date.now(),
            creation: null,
            exited: null,
        });
        try {
            let calls = 0;
            const image = () => (calls++ === 0 ? 'floe.exe' : null);
            const exec = () => {
                throw Object.assign(
                    new Error('ERROR: The process "4000001" not found.'),
                    { status: 128 }
                );
            };
            assert.deepEqual(killTree(pid, { exec, image }), {
                killed: false,
                reason: 'exited during the kill',
            });
            // Still alive after a failed taskkill: the error stands.
            assert.throws(
                () => killTree(pid, { exec, image: () => 'floe.exe' }),
                /not found/
            );
        } finally {
            started.delete(pid);
        }
    }
);
