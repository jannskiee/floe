/**
 * `floe send --to` on a request link: the real binary, the real signaling server and a
 * real Go host (e2ehost, on the engine Floe Desktop runs), with no browser in it. The Go
 * tests in cli/cmd/floe drive this command against a fake server and an in-process engine,
 * and rlvisitor is a hostile stand-in, so this is the one place the shipped command meets
 * the shipped server. The lines it pins are the frozen ones in cli/cmd/floe/sendto.go.
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CLI_TIMEOUT_MS, SERVER_URL, cliBinary } from './helpers';
import {
    deliveredMismatch,
    partsOfRequestLink,
    requestLink,
    startRequestHost,
    waitForHostEvent,
    type RequestHost,
    type RequestHostOptions,
} from './request-helpers';

const COULD_NOT_CONFIRM = "Couldn't confirm their computer. Nothing was sent.";
const INCOMPLETE = 'This link looks incomplete. Copy the whole link again, including everything after the # sign. Put the link in quotes.';
const VERIFIED = "Their app reports every file's SHA-256 matched.";

interface Scratch {
    root: string;
    file: string;
    sha256: string;
    outDir: string;
    hosts: RequestHost[];
}

let scratch: Scratch;

test.beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'floe-request-cli-'));
    const outDir = join(root, 'out');
    mkdirSync(outDir);
    const bytes = randomBytes(256 * 1024);
    const file = join(root, 'a.bin');
    writeFileSync(file, bytes);
    scratch = { root, file, sha256: createHash('sha256').update(bytes).digest('hex'), outDir, hosts: [] };
});

test.afterEach(async () => {
    for (const h of scratch.hosts) h.stop();
    await Promise.all(scratch.hosts.map((h) => h.exited));
    rmSync(scratch.root, { recursive: true, force: true });
});

function host(opts: Omit<RequestHostOptions, 'outDir'> = {}): RequestHost {
    const h = startRequestHost({ outDir: scratch.outDir, key: true, decide: 'accept', ...opts });
    scratch.hosts.push(h);
    return h;
}

/** One run of the command to its end: its exit code and everything it printed. */
function sendTo(link: string): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cliBinary(), ['send', scratch.file, '--to', link, '--server', SERVER_URL, '--no-relay'], {
            env: { ...process.env, FLOE_NO_UPDATE_CHECK: '1' },
        });
        let out = '';
        proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        proc.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`floe send --to did not end within ${CLI_TIMEOUT_MS} ms`));
        }, CLI_TIMEOUT_MS);
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

function expectNothingAsked(h: RequestHost) {
    expect(h.events.some((e) => e.event === 'deciding'), h.describe()).toBe(false);
    expect(h.events.some((e) => e.event === 'file-committed'), h.describe()).toBe(false);
}

test('a keyed link: the file arrives whole, and the key stays off the terminal', async () => {
    const h = host();
    const link = await requestLink(h);
    const { key } = partsOfRequestLink(link);
    expect(key).not.toBeNull();
    const r = await sendTo(link);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(VERIFIED);
    expect(r.out).not.toContain(key as string);
    await waitForHostEvent(h, 'done');
    expect(deliveredMismatch(scratch.outDir, { 'a.bin': scratch.sha256 })).toBeNull();
});

// The line is the visitor's own check, and it wins whichever came first of the host's bad
// proof and the host's refusal: a queued proof is judged ahead of a queued stop.
test('a tampered key: its own line, nothing named, nothing saved', async () => {
    const h = host();
    const link = await requestLink(h);
    const { room } = partsOfRequestLink(link);
    const tampered = `${link.slice(0, link.lastIndexOf('#'))}#${room}.${randomBytes(16).toString('base64url')}`;
    const r = await sendTo(tampered);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(COULD_NOT_CONFIRM);
    expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });
    expectNothingAsked(h);
    expect(deliveredMismatch(scratch.outDir, {})).toBeNull();
});

test('a host under another key: the same line', async () => {
    const h = host({ kc: 'bad' });
    const r = await sendTo(await requestLink(h));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(COULD_NOT_CONFIRM);
    expectNothingAsked(h);
});

// KeyCheckWait is 15 s. A host that holds no key sends no proof at all, which is what a
// server that seats itself in the host's place looks like.
test('a host that shows no proof: the same line, after the wait', async () => {
    test.setTimeout(90_000);
    const h = host({ kc: 'none' });
    const r = await sendTo(await requestLink(h));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(COULD_NOT_CONFIRM);
    expect(h.events.some((e) => e.event === 'file-committed'), h.describe()).toBe(false);
});

// The visitor read a bare link, so it holds nothing to check, and a host that holds a key
// refuses it. It says what the remedy is: copy the whole link.
test('a link cut before its key: the incomplete line, once the host has refused it', async () => {
    const h = host();
    const link = await requestLink(h);
    const r = await sendTo(link.slice(0, link.lastIndexOf('.')));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(INCOMPLETE);
    expectNothingAsked(h);
});

// Every link Floe Desktop 1.0 makes.
test('a bare link: the file arrives whole, as it always has', async () => {
    const h = host({ key: false });
    const link = await requestLink(h);
    expect(partsOfRequestLink(link).key).toBeNull();
    const r = await sendTo(link);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(VERIFIED);
    await waitForHostEvent(h, 'done');
    expect(deliveredMismatch(scratch.outDir, { 'a.bin': scratch.sha256 })).toBeNull();
});
