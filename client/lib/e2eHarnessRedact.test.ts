import { describe, expect, it } from 'vitest';
import { describeHarness } from '../e2e/harness-redact';

// B15: a key in the Go harness's stderr must not survive into a test log or a CI
// artifact. It lives here because vitest reads lib/ and app/ only, and a *.test.ts
// under e2e/ would be collected by Playwright.

const KEY = 'AbC_dEf-GhIjKlMnOpQrSw';
const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

describe('describeHarness', () => {
    it('takes every part of a link out of the stderr tail', () => {
        for (const line of [
            `http://localhost:3000/#k=${KEY}&room=${ROOM}`,
            `http://localhost:3000/?s=deadbeef#k=${KEY}&room=${ROOM}`,
            `http://localhost:3000/#room=${ROOM}&k=${KEY}`,
            `http://localhost:3000/#k=${KEY}`,
            `http://localhost:3000/#k=${KEY.slice(0, 12)}`,
            `http://localhost:3000/r/Xk3p9Q0aB1c#${ROOM}.${KEY}`,
            `http://localhost:3000/r/Xk3p9Q0aB1c#${ROOM}.${KEY.slice(0, 12)}`,
            `${ROOM}.${KEY}`,
            `k=${KEY}`,
            `a key on its own: ${KEY}.`,
        ]) {
            const text = describeHarness([], `dial failed: ${line} (retrying)\n`, false);
            expect(text, line).not.toContain(KEY.slice(0, 12));
            expect(text, line).not.toContain(ROOM);
            expect(text, line).not.toContain('Xk3p9Q0aB1c');
            expect(text, line).toContain('dial failed');
        }
    });

    it('takes the link and the room id out of the events, and keeps the rest', () => {
        const text = describeHarness(
            [
                { event: 'joined', role: 'host', roomId: ROOM },
                { event: 'link', link: `http://localhost:3000/r/Xk3p9Q0aB1c#${ROOM}.${KEY}` },
                { event: 'refused', code: 'unverified' },
            ],
            '',
            false,
        );
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(ROOM);
        expect(text).toContain('"code":"unverified"');
        expect(text).toContain('"role":"host"');
    });

    it('leaves ordinary words alone', () => {
        for (const line of ['connection refused', 'risk=high', 'task=1', 'a word of twenty-one', 'exit code 1']) {
            expect(describeHarness([], line, false)).toContain(line);
        }
    });

    it('drops the first line of a tail that was cut', () => {
        expect(describeHarness([], `half of ${KEY}\nwhole line`, true)).toBe('[] stderr tail: whole line');
    });
});
