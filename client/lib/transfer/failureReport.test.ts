import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTERNAL_REPORT_MESSAGE, reportableCause } from './failureReport';

// Texts the other device could try to get into the message of an error the
// engine throws while this side handles its frames.
const HOSTILE = [
    'olive-tiger-castle',
    'C:\\Users\\someone\\secret.txt',
    'line one\nline two',
    'xyzzy\n    at fake (https://evil.example/a.js:1:1)',
    '<img src=x onerror=alert(1)>',
    'a'.repeat(5000),
];

const FRAMES =
    '    at processMessage (app:///_next/static/chunks/a.js:10:5)\n' +
    '    at runMessage (app:///_next/static/chunks/a.js:20:9)';

/** An Error as V8 builds it: "Name: message" on top, the frames under it. */
function v8Error(Ctor: ErrorConstructor, message: string): Error {
    const err = new Ctor(message);
    err.stack = message === '' ? `${err.name}\n${FRAMES}` : `${err.name}: ${message}\n${FRAMES}`;
    return err;
}

/** Everything a report could carry text in. */
const textOf = (e: Error) => `${e.name}\n${e.message}\n${e.stack ?? ''}`;

describe('reportableCause', () => {
    it('keeps the class and the frames, and nothing of the message', () => {
        for (const Ctor of [Error, TypeError, RangeError, SyntaxError] as ErrorConstructor[]) {
            for (const text of HOSTILE) {
                const report = reportableCause(v8Error(Ctor, text));
                expect(report).toBeInstanceOf(Error);
                expect(report.name).toBe(Ctor.name);
                expect(report.message).toBe(INTERNAL_REPORT_MESSAGE);
                expect(report.stack).toBe(`${Ctor.name}: ${INTERNAL_REPORT_MESSAGE}\n${FRAMES}`);
                // No line of the message survives, a line shaped like a frame included.
                for (const line of text.split('\n')) expect(textOf(report)).not.toContain(line.trim());
            }
        }
    });

    it('reads a V8 stack whose error had no message', () => {
        const report = reportableCause(v8Error(TypeError, ''));
        expect(report.stack).toBe(`TypeError: ${INTERNAL_REPORT_MESSAGE}\n${FRAMES}`);
    });

    it('keeps a stack of frames only, as Firefox and Safari write it', () => {
        const err = new TypeError('secret-text');
        err.stack = 'processMessage@app:///a.js:10:5\nrunMessage@app:///a.js:20:9';
        const report = reportableCause(err);
        expect(report.name).toBe('TypeError');
        expect(report.stack).toBe(
            `TypeError: ${INTERNAL_REPORT_MESSAGE}\nprocessMessage@app:///a.js:10:5\nrunMessage@app:///a.js:20:9`
        );
    });

    it('sends no stack at all when it cannot cut the message out of it', () => {
        const err = new TypeError('secret-text');
        // Not the header V8 writes, and the message is in it somewhere.
        err.stack = 'Uncaught secret-text\nprocessMessage@app:///a.js:10:5';
        const report = reportableCause(err);
        expect(report.stack).toBe(`TypeError: ${INTERNAL_REPORT_MESSAGE}`);
        expect(textOf(report)).not.toContain('secret-text');
    });

    it('takes a class name only when it reads as one', () => {
        for (const name of ['Bad Name', 'x\ny', '', 'a'.repeat(200), '<b>', 'lowercase']) {
            const err = v8Error(Error, 'secret-text');
            err.name = name;
            const report = reportableCause(err);
            expect(report.name).toBe('Error');
            expect(textOf(report)).not.toContain('secret-text');
            if (name.trim().length > 3) expect(textOf(report)).not.toContain(name);
        }
        // A DOMException's name is a class name too.
        const dom = v8Error(Error, 'm');
        dom.name = 'QuotaExceededError';
        expect(reportableCause(dom).name).toBe('QuotaExceededError');
    });

    it('makes a report out of anything that was thrown, and takes nothing from it', () => {
        const thrown: unknown[] = [
            'secret-text',
            42,
            null,
            undefined,
            { name: 'secret-text', message: 'secret-text', stack: 'secret-text' },
            ['secret-text'],
            Symbol('secret-text'),
        ];
        for (const value of thrown) {
            const report = reportableCause(value);
            expect(report).toBeInstanceOf(Error);
            expect(report.name).toBe('Error');
            expect(report.message).toBe(INTERNAL_REPORT_MESSAGE);
            expect(report.stack).toBe(`Error: ${INTERNAL_REPORT_MESSAGE}`);
        }
    });

    it('never throws, whatever the error does when it is read', () => {
        const err = new Error('secret-text');
        Object.defineProperty(err, 'stack', {
            get() {
                throw new Error('no stack for you');
            },
        });
        const report = reportableCause(err);
        expect(report.message).toBe(INTERNAL_REPORT_MESSAGE);
        expect(textOf(report)).not.toContain('secret-text');

        const frozen = Object.freeze(v8Error(RangeError, 'secret-text'));
        expect(reportableCause(frozen).stack).toBe(`RangeError: ${INTERNAL_REPORT_MESSAGE}\n${FRAMES}`);
    });

    it('says the same words every time', () => {
        expect(INTERNAL_REPORT_MESSAGE).toBe('The receiver failed while it was handling a frame');
    });
});

// The one place the receiving page hands a thrown value to Sentry. It goes
// through reportableCause, and no other captureException exists on the page.
describe('how the receiving page reports a failure of its own', () => {
    const page = readFileSync(fileURLToPath(new URL('../../components/P2PTransfer.tsx', import.meta.url)), 'utf8');

    it('sends the fixed report, never what was thrown', () => {
        expect(page).toContain('Sentry.captureException(reportableCause(failure.cause));');
        expect(page.match(/captureException\(/g)).toHaveLength(1);
        expect(page).not.toContain('captureException(failure.cause)');
    });
});
