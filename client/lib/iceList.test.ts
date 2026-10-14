import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ICE_LIST_MAX_AGE_MS, STUN_DEFAULTS, createIceList, iceListStale, freshenWithin } from './iceList';

const TURN = [{ urls: 'stun:stun.example:3478' }, { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];

function harness(answers: Array<unknown | Error>) {
    let clock = 1_000_000;
    let reads = 0;
    const list = createIceList({
        read: async () => {
            const answer = answers[Math.min(reads, answers.length - 1)];
            reads += 1;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        now: () => clock,
    });
    return {
        list,
        reads: () => reads,
        advance: (ms: number) => {
            clock += ms;
        },
    };
}

describe('iceListStale', () => {
    it('is stale before any good read, and once the list is an hour old', () => {
        expect(iceListStale(null, 5)).toBe(true);
        expect(iceListStale(0, ICE_LIST_MAX_AGE_MS - 1)).toBe(false);
        expect(iceListStale(0, ICE_LIST_MAX_AGE_MS)).toBe(true);
    });

    it('is stale when the clock went backwards', () => {
        expect(iceListStale(100, 50)).toBe(true);
    });
});

describe('createIceList', () => {
    it('starts on the STUN defaults and takes the server list once read', async () => {
        const h = harness([TURN]);
        expect(h.list.current()).toEqual(STUN_DEFAULTS);
        await h.list.read();
        expect(h.list.current()).toEqual(TURN);
    });

    it('reads again before a connection when the first read failed', async () => {
        const h = harness([new Error('503'), TURN]);
        await h.list.read();
        expect(h.list.current()).toEqual(STUN_DEFAULTS);
        await h.list.freshen();
        expect(h.reads()).toBe(2);
        expect(h.list.current()).toEqual(TURN);
    });

    it('counts an answer that is not a list as a failed read', async () => {
        const h = harness([{ error: 'Too many requests' }, TURN]);
        await h.list.read();
        await h.list.freshen();
        expect(h.reads()).toBe(2);
        expect(h.list.current()).toEqual(TURN);
    });

    it('does not read a fresh list again', async () => {
        const h = harness([TURN]);
        await h.list.read();
        h.advance(ICE_LIST_MAX_AGE_MS - 1);
        await h.list.freshen();
        expect(h.reads()).toBe(1);
    });

    it('reads a list an hour old again, and keeps the old one if that read fails', async () => {
        const newer = [{ urls: 'turn:turn.example:443', username: 'u2', credential: 'c2' }];
        const h = harness([TURN, new Error('down'), newer]);
        await h.list.read();
        h.advance(ICE_LIST_MAX_AGE_MS);
        await h.list.freshen();
        expect(h.reads()).toBe(2);
        expect(h.list.current()).toEqual(TURN);
        await h.list.freshen();
        expect(h.reads()).toBe(3);
        expect(h.list.current()).toEqual(newer);
    });

    it('shares one read between callers that ask at the same time', async () => {
        const h = harness([new Error('503'), TURN]);
        await h.list.read();
        await Promise.all([h.list.freshen(), h.list.freshen()]);
        expect(h.reads()).toBe(2);
    });
});

describe('freshenWithin', () => {
    it('gives up waiting at the bound and leaves the read running', async () => {
        let finish: () => void = () => {};
        const list = {
            freshen: () => new Promise<void>((resolve) => { finish = resolve; }),
        };
        const started = Date.now();
        await freshenWithin(list, 30);
        expect(Date.now() - started).toBeLessThan(1_000);
        finish();
    });
});

// W2-06. The receiver's rebuild after a blip waits for the list, then checks
// that the page is still mounted. The flag is set by the mount effect's
// cleanup, so the effect itself has to clear it again: a second mount (Strict
// Mode's double run, were it ever on) would otherwise turn every later rebuild
// into a silent no-op over a working link.
describe('the main page after a remount', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

    it('clears the unmounted flag each time the mount effect runs', () => {
        const page = read('../components/P2PTransfer.tsx');
        const mount = page.indexOf('let cancelled = false;');
        const reset = page.indexOf('unmountedRef.current = false;');
        const cleanup = page.indexOf('unmountedRef.current = true;');
        expect(mount).toBeGreaterThan(-1);
        expect(reset).toBeGreaterThan(mount);
        expect(reset).toBeLessThan(cleanup);
    });
});
