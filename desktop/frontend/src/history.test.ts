import {describe, expect, it} from 'vitest';
import {histKey, loadHistory, fmtWhen, requestHistoryEntry} from './history';
import {OFF_SNAPSHOT, type RequestLinkSnapshot} from './requestLink';

describe('histKey', () => {
    // The whole point of the key: it must not encode list position, so a
    // removal above an expanded row cannot change which row reads as open.
    it('is position-independent and stable for the same entry', () => {
        const h = {at: 1755200000000, names: ['a.txt', 'b.txt'], count: 2};
        expect(histKey(h)).toBe(histKey({...h}));
        expect(histKey(h)).toBe('1755200000000-a.txt-2');
    });
    it('separates same-timestamp entries by name and count', () => {
        const at = 1755200000000;
        expect(histKey({at, names: ['a.txt'], count: 1}))
            .not.toBe(histKey({at, names: ['b.txt'], count: 1}));
        expect(histKey({at, names: ['a.txt'], count: 1}))
            .not.toBe(histKey({at, names: ['a.txt', 'c'], count: 2}));
    });
    it('tolerates entries with no names', () => {
        expect(histKey({at: 5, names: [], count: 0})).toBe('5--0');
    });
});

describe('loadHistory', () => {
    it('parses a stored list', () => {
        const raw = JSON.stringify([{kind: 'send', names: ['a.txt'], count: 1, at: 1}]);
        expect(loadHistory(() => raw)).toHaveLength(1);
    });

    it('returns empty for an absent store', () => {
        expect(loadHistory(() => null)).toEqual([]);
    });

    it('returns empty for corrupt JSON rather than throwing', () => {
        // The caller's persist effect is separately guarded so the unreadable
        // bytes stay on disk; this only has to not break the app.
        expect(loadHistory(() => '{not json')).toEqual([]);
    });

    it('returns empty when the stored value is valid JSON but not a list', () => {
        expect(loadHistory(() => '{"kind":"send"}')).toEqual([]);
        expect(loadHistory(() => '"a string"')).toEqual([]);
        expect(loadHistory(() => 'null')).toEqual([]);
    });
});

describe('fmtWhen', () => {
    // Timestamps are built from LOCAL components on purpose: the hh:mm half of
    // the output is local time, so an epoch or a UTC string would make these
    // assertions pass here and fail in CI's UTC.
    const now = new Date(2026, 6, 20, 12, 0);

    it('names today and yesterday by calendar day, not a 24h window', () => {
        expect(fmtWhen(new Date(2026, 6, 20, 19, 55).getTime(), now)).toBe('Today, 19:55');
        expect(fmtWhen(new Date(2026, 6, 19, 9, 12).getTime(), now)).toBe('Yesterday, 09:12');
        // 23:00 yesterday is 13 hours ago, inside a 24h window, but still
        // "Yesterday" because the comparison is by date.
        expect(fmtWhen(new Date(2026, 6, 19, 23, 0).getTime(), now)).toBe('Yesterday, 23:00');
    });

    it('falls back to a short month and day', () => {
        expect(fmtWhen(new Date(2026, 6, 18, 19, 55).getTime(), now)).toBe('Jul 18, 19:55');
    });

    it('crosses a month boundary correctly', () => {
        const firstOfAugust = new Date(2026, 7, 1, 8, 5);
        expect(fmtWhen(new Date(2026, 6, 31, 22, 30).getTime(), firstOfAugust)).toBe(
            'Yesterday, 22:30'
        );
    });

    it('zero-pads both fields', () => {
        expect(fmtWhen(new Date(2026, 6, 20, 5, 7).getTime(), now)).toBe('Today, 05:07');
    });
});

// One History row per finished request drop (S1-DSK-09).
describe('request drops in History', () => {
    const LINK = 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const result = {files: 12, saved: 12, bytes: 38 * 1024 ** 3, verified: 12, renamed: 1, folder: 'D:\\Footage\\Floe requests\\Acme footage 2026-09-14 1405', names: ['shoot/A001_C001.mov', 'x.url.floe-blocked']};
    const snap = (over: Partial<RequestLinkSnapshot>): RequestLinkSnapshot => ({
        ...OFF_SNAPSHOT, gen: 4, promptGen: 2, link: LINK, label: 'Acme footage', saveDir: 'D:\\Footage\\Floe requests', expiresAt: 9, ...over,
    });
    const AT = 1_758_000_000_000;

    it('old entries without request fields still load', () => {
        const raw = JSON.stringify([
            {kind: 'recv', names: ['a.txt'], count: 1, dir: 'C:\\dl', at: 1, bytes: 10},
            {kind: 'send', names: ['b.txt'], count: 1, at: 2},
        ]);
        const rows = loadHistory(() => raw);
        expect(rows).toHaveLength(2);
        expect(rows[0].via).toBeUndefined();
        expect(rows[0]).toEqual({kind: 'recv', names: ['a.txt'], count: 1, dir: 'C:\\dl', at: 1, bytes: 10});
    });

    it('histKey is unchanged for request rows', () => {
        const row = requestHistoryEntry(snap({state: 'done', result}), AT)!;
        expect(histKey(row)).toBe(`${AT}-shoot/A001_C001.mov-12`);
    });

    it('requestHistoryEntry returns a row for done', () => {
        expect(requestHistoryEntry(snap({state: 'done', result}), AT)).toEqual({
            kind: 'recv', names: result.names, count: 12, dir: result.folder, at: AT, bytes: result.bytes,
            via: 'request', label: 'Acme footage', verified: 12, renamed: 1, offered: 12,
        });
    });

    it('requestHistoryEntry returns a row with stopped set when files were saved', () => {
        const row = requestHistoryEntry(snap({state: 'stopped', code: 'disk-full', result: {...result, saved: 4, verified: 4}}), AT);
        expect(row).toMatchObject({via: 'request', count: 4, offered: 12, stopped: 'disk-full'});
        // A stop without a code is the ST14 case, stored as such.
        expect(requestHistoryEntry(snap({state: 'stopped', code: '', result: {...result, saved: 1}}), AT)?.stopped).toBe('unknown');
    });

    it('requestHistoryEntry returns null for a stop with nothing saved', () => {
        expect(requestHistoryEntry(snap({state: 'stopped', code: 'relay-cap', result: {...result, saved: 0}}), AT)).toBeNull();
        for (const state of ['waiting', 'deciding', 'receiving', 'declined', 'ended', 'error', 'off']) {
            expect(requestHistoryEntry(snap({state, result}), AT), state).toBeNull();
        }
        expect(requestHistoryEntry(snap({state: 'done'}), AT)).toBeNull(); // no result
    });

    it('a save-blocked stop with nothing saved still gets its row (D-128)', () => {
        // The engine keeps that file, complete and verified, as a .part in the
        // drop folder (E-36): the row keeps the folder and the code, and no
        // name, since nothing was saved under one.
        const blocked = {...result, files: 1, saved: 0, bytes: 0, verified: 0, renamed: 0, names: []};
        expect(requestHistoryEntry(snap({state: 'stopped', code: 'save-blocked', result: blocked}), AT)).toEqual({
            kind: 'recv', names: [], count: 0, dir: result.folder, at: AT, via: 'request', label: 'Acme footage',
            verified: 0, renamed: 0, offered: 1, stopped: 'save-blocked',
        });
        // Every other stop with nothing saved still adds nothing.
        for (const code of ['write-failed', 'disk-full', 'stopped', 'peer-abort', 'unknown', '']) {
            expect(requestHistoryEntry(snap({state: 'stopped', code, result: blocked}), AT), code).toBeNull();
        }
    });

    it('request rows keep at most 200 names and the real count', () => {
        const names = Array.from({length: 201}, (_, i) => `f${i}.bin`);
        const row = requestHistoryEntry(snap({state: 'done', result: {...result, files: 201, saved: 201, verified: 201, names}}), AT)!;
        expect(row.names).toHaveLength(200);
        expect(row.count).toBe(201);
    });

    it('a request row never stores the link or room id', () => {
        for (const s of [snap({state: 'done', result}), snap({state: 'stopped', code: 'peer-abort', result: {...result, saved: 3}})]) {
            const stored = JSON.stringify(requestHistoryEntry(s, AT));
            expect(stored).not.toContain('Xk3p9Q0aB1c');
            expect(stored).not.toContain('6f1c2b9e');
            expect(stored).not.toContain('localhost:3000');
            expect(stored).not.toMatch(/link|room/i);
        }
    });
});
