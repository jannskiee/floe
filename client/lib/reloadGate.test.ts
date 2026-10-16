import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createReloadGate, RELEASE_SETTLE_MS } from './reloadGate';
import { reloadIfStaleBundle } from './staleBundle';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// A gate with its clock in the test's hands: `later` holds what the gate
// scheduled, and `run` plays it.
function harness(canAsk = false) {
    let reloads = 0;
    const later: { fn: () => void; ms: number }[] = [];
    const gate = createReloadGate({
        reload: () => {
            reloads += 1;
        },
        schedule: (fn, ms) => {
            later.push({ fn, ms });
        },
        canAsk: () => canAsk,
    });
    const run = () => {
        for (const job of later.splice(0)) job.fn();
    };
    return { gate, reloads: () => reloads, later, run };
}

describe('the reload gate', () => {
    it('reloads at once when nothing holds the tab, as the page always did', () => {
        const h = harness();
        h.gate.request('stale-bundle');
        expect(h.reloads()).toBe(1);
    });

    it('holds a room-link reload on a page the browser cannot ask on, and runs it once the hold lets go', () => {
        const h = harness();
        const release = h.gate.hold();
        h.gate.request('room-link');
        expect(h.reloads()).toBe(0);
        release();
        // A moment after the hold lets go, not inside it: see RELEASE_SETTLE_MS.
        expect(h.reloads()).toBe(0);
        expect(h.later.map((j) => j.ms)).toEqual([RELEASE_SETTLE_MS]);
        h.run();
        expect(h.reloads()).toBe(1);
    });

    it('waits for the last of several holds', () => {
        const h = harness();
        const a = h.gate.hold();
        const b = h.gate.hold();
        h.gate.request('room-link');
        a();
        h.run();
        expect(h.reloads()).toBe(0);
        b();
        h.run();
        expect(h.reloads()).toBe(1);
    });

    it('does not reload when a new hold began during the settle time', () => {
        const h = harness();
        const first = h.gate.hold();
        h.gate.request('room-link');
        first();
        const second = h.gate.hold();
        h.run();
        expect(h.reloads()).toBe(0);
        second();
        h.run();
        expect(h.reloads()).toBe(1);
    });

    it('drops a stale-bundle request while held and still reloads once for the room link', () => {
        const h = harness();
        const release = h.gate.hold();
        const asked: string[] = [];
        h.gate.request('stale-bundle', () => {
            asked.push('stale-bundle');
            return true;
        });
        h.gate.request('room-link', () => {
            asked.push('room-link');
            return true;
        });
        expect(asked).toEqual([]);
        release();
        h.run();
        expect(h.reloads()).toBe(1);
        // The stale-bundle request was dropped when it came, so only the room
        // link is asked.
        expect(asked).toEqual(['room-link']);
    });

    it('keeps one request per kind, the latest', () => {
        const h = harness();
        const release = h.gate.hold();
        let first = 0;
        let latest = 0;
        h.gate.request('room-link', () => {
            first += 1;
            return true;
        });
        h.gate.request('room-link', () => {
            latest += 1;
            return true;
        });
        release();
        h.run();
        expect([first, latest]).toEqual([0, 1]);
        expect(h.reloads()).toBe(1);
    });

    it('drops a request that no longer wants the reload when the hold lets go', () => {
        const h = harness();
        const release = h.gate.hold();
        h.gate.request('room-link', () => false);
        release();
        h.run();
        expect(h.reloads()).toBe(0);
        // And it is gone: a later hold and release reloads nothing.
        h.gate.hold()();
        h.run();
        expect(h.reloads()).toBe(0);
    });

    it('lets go of a hold once, however often its release is called', () => {
        const h = harness();
        const a = h.gate.hold();
        const b = h.gate.hold();
        h.gate.request('room-link');
        a();
        a();
        h.run();
        expect(h.reloads()).toBe(0);
        b();
        h.run();
        expect(h.reloads()).toBe(1);
    });

    it('drops a stale-bundle request made while the tab is held: nothing waits and nothing reloads', () => {
        const h = harness(true);
        const release = h.gate.hold();
        h.gate.request('stale-bundle');
        expect(h.reloads()).toBe(0);
        release();
        expect(h.later).toEqual([]);
        h.run();
        expect(h.reloads()).toBe(0);
    });

    it('reloads at once for a room link on a page the person used, so the browser asks them', () => {
        const h = harness(true);
        h.gate.hold();
        h.gate.request('room-link');
        expect(h.reloads()).toBe(1);
        expect(h.later).toEqual([]);
    });

    it('reloads nothing for a room link that is no longer wanted, on a used page', () => {
        const h = harness(true);
        h.gate.hold();
        h.gate.request('room-link', () => false);
        expect(h.reloads()).toBe(0);
    });

    it('schedules nothing when a hold lets go with no reload waiting', () => {
        const h = harness();
        h.gate.hold()();
        expect(h.later).toEqual([]);
    });
});

// The stale-bundle reload, with its storage and clock in the test's hands.
function staleDeps(start: Record<string, string> = {}) {
    const store: Record<string, string> = { ...start };
    let now = 1_000_000;
    const h = harness();
    return {
        h,
        store,
        tick: (ms: number) => {
            now += ms;
        },
        deps: {
            storage: {
                getItem: (k: string) => (k in store ? store[k] : null),
                setItem: (k: string, v: string) => {
                    store[k] = v;
                },
            },
            now: () => now,
            gate: h.gate,
        },
    };
}

const STALE = 'Loading chunk 537 failed.';
const KEY = 'floe:stale-bundle-reloaded-at';

describe('reloadIfStaleBundle', () => {
    it('reloads at once on a stale-bundle error when nothing holds the tab', () => {
        const s = staleDeps();
        expect(reloadIfStaleBundle(STALE, s.deps)).toBe(true);
        expect(s.h.reloads()).toBe(1);
        expect(s.store[KEY]).toBe('1000000');
    });

    it('ignores every other error', () => {
        const s = staleDeps();
        expect(reloadIfStaleBundle('TypeError: x is undefined', s.deps)).toBe(false);
        expect(s.h.reloads()).toBe(0);
    });

    it('leaves a transfer alone, and reloads on the next stale chunk after it', () => {
        const s = staleDeps();
        const release = s.h.gate.hold();
        expect(reloadIfStaleBundle(STALE, s.deps)).toBe(true);
        expect(s.h.reloads()).toBe(0);
        // Nothing is stamped: the stamp is the loop guard's, and it has to say
        // when the page really reloaded.
        expect(s.store[KEY]).toBeUndefined();
        s.tick(60_000);
        release();
        s.h.run();
        // The request was dropped, so the outcome screen stays.
        expect(s.h.reloads()).toBe(0);
        expect(reloadIfStaleBundle(STALE, s.deps)).toBe(true);
        expect(s.h.reloads()).toBe(1);
        expect(s.store[KEY]).toBe('1060000');
    });

    it('still refuses a second reload within 10 seconds of the last one', () => {
        const s = staleDeps({ [KEY]: '995000' });
        expect(reloadIfStaleBundle(STALE, s.deps)).toBe(false);
        expect(s.h.reloads()).toBe(0);
    });

    it('reloads when storage throws, as it always has', () => {
        const s = staleDeps();
        const deps = {
            ...s.deps,
            storage: {
                getItem: () => {
                    throw new Error('blocked');
                },
                setItem: () => {
                    throw new Error('blocked');
                },
            },
        };
        expect(reloadIfStaleBundle(STALE, deps)).toBe(true);
        expect(s.h.reloads()).toBe(1);
    });
});

// The two pages hold the gate exactly while they hold the browser's leave
// prompt, through the one hook both call (usePageGuards.ts), and the main
// page's room-link reload goes through it. Read as text: the hooks and the
// component are mounted by no unit test.
describe('who holds the gate', () => {
    it('the leave prompt hook holds it while active', () => {
        const src = read('../hooks/usePageGuards.ts');
        expect(src).toMatch(/import \{ reloadGate \} from '@\/lib\/reloadGate';/);
        const hook = src.slice(src.indexOf('export function useLeavePrompt'), src.indexOf('export function useFullLoadLinks'));
        expect(hook).toContain('if (!active) return;');
        expect(hook).toContain('const release = reloadGate.hold();');
        expect(hook).toContain('release();');
    });

    it('the main page and the request page pass it what they hold the tab for', () => {
        expect(read('../components/P2PTransfer.tsx')).toContain('useLeavePrompt(holdsTab);');
        expect(read('../hooks/useVisitorGuards.ts')).toContain('useLeavePrompt(guards.beforeUnload);');
    });

    it('the main page asks the gate before it reloads for a new room link', () => {
        const src = read('../components/P2PTransfer.tsx');
        expect(src).toContain("reloadGate.request('room-link', roomChanged)");
        // The page reloads nowhere else on its own.
        expect(src).not.toContain('window.location.reload()');
    });

    it('the stale-bundle recovery asks the gate and never reloads by itself', () => {
        const src = read('./staleBundle.ts');
        expect(src).not.toContain('location.reload');
        expect(src).toContain("deps.gate.request('stale-bundle'");
    });
});
