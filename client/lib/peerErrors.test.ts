import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
    PEER_ERROR_CODES,
    RECEIVER_PEER_ERROR,
    SENDER_PEER_ERROR,
    classifyPeerError,
    peerErrorBanner,
    peerErrorCodeOf,
    peerErrorReport,
    senderErrorBlamesRelay,
} from './peerErrors';

describe('classifyPeerError', () => {
    describe('receiver (relayEnabled defaulted to true)', () => {
        it('treats an ICE failure as expected', () => {
            expect(classifyPeerError('Ice connection failed.')).toEqual({
                isExpected: true,
                reason: 'ice-failed',
            });
        });

        it('treats a generic connection failure as expected', () => {
            expect(classifyPeerError('Connection failed.')).toEqual({
                isExpected: true,
                reason: 'conn-failed',
            });
        });

        it('treats a user-initiated abort (substring match) as expected', () => {
            expect(classifyPeerError('Error: User-Initiated Abort, reason=x')).toEqual({
                isExpected: true,
                reason: 'abort',
            });
        });

        it('treats any other message as an unexpected bug', () => {
            expect(classifyPeerError('RTCDataChannel send queue full')).toEqual({
                isExpected: false,
                reason: 'unknown',
            });
        });

        it('treats an undefined message as unexpected', () => {
            expect(classifyPeerError(undefined)).toEqual({
                isExpected: false,
                reason: 'unknown',
            });
        });

        it('never reports relay-disabled when relay is not a concern', () => {
            expect(classifyPeerError('Ice connection failed.', { relayEnabled: true }).reason).toBe(
                'ice-failed'
            );
        });
    });

    describe('sender with relay forced off', () => {
        it('marks every error expected and attributes it to relay-disabled', () => {
            expect(classifyPeerError('Ice connection failed.', { relayEnabled: false })).toEqual({
                isExpected: true,
                reason: 'relay-disabled',
            });
        });

        it('attributes even an otherwise-unknown error to relay-disabled', () => {
            expect(classifyPeerError('weird internal error', { relayEnabled: false })).toEqual({
                isExpected: true,
                reason: 'relay-disabled',
            });
        });
    });

    describe('sender with relay enabled', () => {
        it('classifies like the receiver does', () => {
            expect(classifyPeerError('Connection failed.', { relayEnabled: true })).toEqual({
                isExpected: true,
                reason: 'conn-failed',
            });
        });

        it('captures an unexpected error', () => {
            expect(classifyPeerError('boom', { relayEnabled: true })).toEqual({
                isExpected: false,
                reason: 'unknown',
            });
        });
    });
});

describe('senderErrorBlamesRelay', () => {
    it('blames the relay setting for a failure to connect with the box unchecked', () => {
        expect(senderErrorBlamesRelay('Ice connection failed.', false)).toBe(true);
        expect(senderErrorBlamesRelay('Connection failed.', false)).toBe(true);
        expect(senderErrorBlamesRelay('something else went wrong', false)).toBe(true);
        expect(senderErrorBlamesRelay(undefined, false)).toBe(true);
    });

    // With the box unchecked every early error took the relay sentence, and
    // that sentence now tells the sender to reload and make a new link. A
    // recipient who closed their tab during the handshake ends in an abort,
    // and for them the link still works.
    it('does not blame it when the other side simply left', () => {
        expect(senderErrorBlamesRelay('User-Initiated Abort, reason=Close called', false)).toBe(false);
    });

    it('never blames it while the box is checked', () => {
        expect(senderErrorBlamesRelay('Ice connection failed.', true)).toBe(false);
        expect(senderErrorBlamesRelay('User-Initiated Abort, reason=Close called', true)).toBe(false);
    });
});

// The text of a peer error is not Floe's and not always the browser's own.
// simple-peer hands over the browser's exception, and Chromium quotes the SDP
// line it could not parse inside it ("Failed to parse SessionDescription.
// <line> ..."); a data channel abort carries the reason the other end gave.
// The other peer chooses both. Until this was fixed the page drew that text
// after "Connection error:" and sent it to Sentry as the exception's value.
const HOSTILE = [
    'Failed to parse SessionDescription. x=Your link has expired. Open evil.example and paste it there Expect line: o=',
    'Link Expired or Busy',
    'User-Initiated Abort, reason=<img src=x onerror=alert(1)>',
    'a'.repeat(60_000),
    'line one\nline two\u202Edesrever\u0000',
    '',
];

describe('peerErrorCodeOf', () => {
    it('returns the code simple-peer set, and only one from its own list', () => {
        for (const code of PEER_ERROR_CODES) {
            expect(peerErrorCodeOf(Object.assign(new Error('x'), { code }))).toBe(code);
        }
        expect(peerErrorCodeOf(Object.assign(new Error('x'), { code: 'ERR_SET_REMOTE_DESCRIPTION' }))).toBe(
            'ERR_SET_REMOTE_DESCRIPTION'
        );
    });

    it('answers unknown for anything else, whatever it is', () => {
        for (const err of [
            new Error('no code'),
            Object.assign(new Error('x'), { code: 'ERR_MADE_UP' }),
            Object.assign(new Error('x'), { code: HOSTILE[0] }),
            Object.assign(new Error('x'), { code: '__proto__' }),
            Object.assign(new Error('x'), { code: 'constructor' }),
            Object.assign(new Error('x'), { code: 42 }),
            Object.assign(new Error('x'), { code: { toString: () => 'ERR_SIGNALING' } }),
            Object.assign(new Error('x'), { code: ['ERR_SIGNALING'] }),
            { code: undefined },
            'ERR_SIGNALING',
            null,
            undefined,
            42,
        ]) {
            expect(peerErrorCodeOf(err)).toBe('unknown');
        }
    });

    it('lists every code the installed simple-peer can put on an error, and no other', () => {
        // A simple-peer that gains a code must add it here, or its errors
        // report as unknown; one that loses a code leaves a dead entry.
        const require = createRequire(import.meta.url);
        const source = readFileSync(require.resolve('simple-peer/index.js'), 'utf8');
        const inLibrary = new Set(source.match(/'ERR_[A-Z_]+'/g)?.map((m) => m.slice(1, -1)));
        expect(inLibrary.size).toBeGreaterThan(10);
        expect([...PEER_ERROR_CODES].sort()).toEqual([...inLibrary].sort());
    });
});

describe('what an unexpected peer error shows and reports', () => {
    it('shows one fixed sentence per role', () => {
        expect(peerErrorBanner('receiver')).toBe(RECEIVER_PEER_ERROR);
        expect(peerErrorBanner('sender')).toBe(SENDER_PEER_ERROR);
        expect(RECEIVER_PEER_ERROR).toBe(
            'Connection failed. Reload the page to try again. If it fails again, ask the sender for a new link.'
        );
        expect(SENDER_PEER_ERROR).toBe(
            'Connection failed. Ask the other device to open the link again. If it fails again, reload the page, add the files again, and share the new link.'
        );
    });

    it('reports a code, a role and nothing of the message, for every code and every text', () => {
        for (const role of ['receiver', 'sender'] as const) {
            for (const code of [...PEER_ERROR_CODES, 'ERR_MADE_UP', undefined]) {
                for (const text of HOSTILE) {
                    const err = Object.assign(new Error(text), code ? { code } : {});
                    const report = peerErrorReport(role, err);
                    const known = code !== undefined && PEER_ERROR_CODES.has(code) ? code : 'unknown';
                    expect(report).toEqual({
                        code: known,
                        message: `Unexpected peer error: ${known}`,
                        fingerprint: ['peer-error', role, known],
                        tags: { peerErrorRole: role, peerErrorCode: known },
                    });
                    const sent = JSON.stringify(report);
                    if (text.length > 3) expect(sent).not.toContain(text.slice(0, 24));
                    expect(sent).not.toContain('evil.example');
                    expect(sent).not.toContain('onerror');
                    expect(sent.length).toBeLessThan(300);
                    // And the banner is the constant whatever the error said.
                    expect(peerErrorBanner(role)).not.toContain('Link Expired');
                }
            }
        }
    });
});

// peerErrors.ts is pure; the handlers that call it live in a component no
// unit test mounts. These read its source, as relay.test.ts does for the
// relay sentences, so the wiring cannot go back without a test saying so.
describe('P2PTransfer puts no peer error text on the page or in a report', () => {
    const main = readFileSync(fileURLToPath(new URL('../components/P2PTransfer.tsx', import.meta.url)), 'utf8');

    it('has no banner built from an error message', () => {
        expect(main).not.toContain('Connection error:');
        // An error's message may pick between fixed sentences
        // (senderErrorBlamesRelay); it is never the sentence, or part of one.
        expect(main).not.toMatch(/setError\(\s*`[^`]*\$\{[^}]*\.message/);
        expect(main).not.toMatch(/setError\(\s*\(?\w+(?: as Error)?\)?\.message\s*\)/);
        expect(main).not.toMatch(/setError\([^;]*\+\s*\(?\w+(?: as Error)?\)?\.message/);
        expect(main.split("setError(peerErrorBanner('receiver'))")).toHaveLength(2);
        expect(main.split("setError(peerErrorBanner('sender'))")).toHaveLength(2);
    });

    it('never hands a peer error object or its message to Sentry', () => {
        expect(main).not.toContain('captureException(err)');
        expect(main).not.toContain('errorMessage');
        // Every breadcrumb message near a peer error is fixed text.
        expect(main).not.toMatch(/message: `[^`]*\$\{[^}]*\.message[^}]*\}/);
        expect(main).not.toMatch(/expected connection error [^'`]*\$\{/);
        expect(main.split("peerErrorReport('receiver', err)")).toHaveLength(2);
        expect(main.split("peerErrorReport('sender', err)")).toHaveLength(2);
        expect(main).toContain("message: 'Receiver: expected connection error'");
        expect(main).toContain("message: 'Sender: expected connection error'");
    });
});
