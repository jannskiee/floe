import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => {
    const scope = {
        setTags: vi.fn(),
        setFingerprint: vi.fn(),
        setContext: vi.fn(),
        setTag: vi.fn(),
        setExtra: vi.fn(),
        setUser: vi.fn(),
    };
    return {
        scope,
        withScope: vi.fn(),
        captureMessage: vi.fn(),
        captureException: vi.fn(),
        addBreadcrumb: vi.fn(),
    };
});

vi.mock('@sentry/nextjs', () => sentry);

import { keyCheckReport, reportLinkKey } from './keyCheckReport';
import type { KeyReport } from './transfer/keySession';

const REPORT: KeyReport = { role: 'receiver', path: 'der', outcome: 'bad-tag', mode: 'enforce' };

beforeEach(() => {
    vi.clearAllMocks();
    sentry.withScope.mockImplementation((run: (s: typeof sentry.scope) => void) => run(sentry.scope));
});

// O7: one warning per failed check, so a hashing mismatch between engines shows up
// during the soak. Enums and nothing else.
describe('keyCheckReport', () => {
    it('is a fixed message at warning level with four enum tags and one issue per role, outcome and path', () => {
        expect(keyCheckReport(REPORT)).toEqual({
            message: 'Link key check failed',
            level: 'warning',
            tags: {
                'linkkey.role': 'receiver',
                'linkkey.path': 'der',
                'linkkey.outcome': 'bad-tag',
                'linkkey.mode': 'enforce',
            },
            fingerprint: ['link-key', 'receiver', 'bad-tag', 'der'],
        });
    });

    it('takes every value each enum can hold', () => {
        for (const role of ['sender', 'receiver', 'visitor'] as const) {
            for (const path of ['der', 'sdp', 'none'] as const) {
                for (const outcome of ['bad-tag', 'malformed', 'missing', 'unavailable', 'peer-refused'] as const) {
                    for (const mode of ['enforce', 'detect', 'observe'] as const) {
                        const report = keyCheckReport({ role, path, outcome, mode });
                        expect(report?.fingerprint).toEqual(['link-key', role, outcome, path]);
                    }
                }
            }
        }
    });

    // A check that only heard nothing is every web send to a released floe (it has
    // no kc to send), and a warning per such send would bury the signal this exists
    // for. keySession never reports it outside enforce; this holds the line again.
    it('never reports silence outside enforce mode', () => {
        expect(keyCheckReport({ ...REPORT, outcome: 'silent', mode: 'detect' })).toBeNull();
        expect(keyCheckReport({ ...REPORT, outcome: 'silent', mode: 'observe' })).toBeNull();
        expect(keyCheckReport({ ...REPORT, outcome: 'silent', mode: 'enforce' })?.tags['linkkey.outcome']).toBe('silent');
    });

    it('sends nothing for a value outside the enums: no free text can ride a field', () => {
        const hostile = '#k=AAECAwQFBgcICQoLDA0ODw&room=6f207790-92a6-4662-bb68-4c4059f75139';
        const shaped = (over: Record<string, unknown>) => ({ ...REPORT, ...over }) as unknown as KeyReport;
        expect(keyCheckReport(shaped({ role: hostile }))).toBeNull();
        expect(keyCheckReport(shaped({ path: hostile }))).toBeNull();
        expect(keyCheckReport(shaped({ outcome: hostile }))).toBeNull();
        expect(keyCheckReport(shaped({ mode: hostile }))).toBeNull();
        expect(keyCheckReport(shaped({ outcome: undefined }))).toBeNull();
    });

    it('copies only the four fields: an extra one on the report goes nowhere', () => {
        const extra = { ...REPORT, why: 'AAECAwQFBgcICQoLDA0ODw', room: '6f207790', tag: 'abc' } as KeyReport;
        const sent = JSON.stringify(keyCheckReport(extra));
        expect(sent).not.toContain('AAECAw');
        expect(sent).not.toContain('6f207790');
        expect(sent).not.toContain('abc');
    });
});

describe('reportLinkKey', () => {
    it('sends the one message, in a scope of its own, with the tags and the fingerprint', () => {
        reportLinkKey(REPORT);
        expect(sentry.withScope).toHaveBeenCalledTimes(1);
        expect(sentry.scope.setTags).toHaveBeenCalledWith({
            'linkkey.role': 'receiver',
            'linkkey.path': 'der',
            'linkkey.outcome': 'bad-tag',
            'linkkey.mode': 'enforce',
        });
        expect(sentry.scope.setFingerprint).toHaveBeenCalledWith(['link-key', 'receiver', 'bad-tag', 'der']);
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(sentry.captureMessage).toHaveBeenCalledWith('Link key check failed', 'warning');
    });

    it('attaches no context, no extra and no user, and never an exception', () => {
        reportLinkKey(REPORT);
        expect(sentry.scope.setContext).not.toHaveBeenCalled();
        expect(sentry.scope.setExtra).not.toHaveBeenCalled();
        expect(sentry.scope.setUser).not.toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();
    });

    it('sends nothing for a report the allowlist refuses', () => {
        reportLinkKey({ ...REPORT, outcome: 'silent', mode: 'detect' });
        expect(sentry.withScope).not.toHaveBeenCalled();
        expect(sentry.captureMessage).not.toHaveBeenCalled();
    });

    // It runs inside the data callback that delivered the frame. A telemetry failure
    // must not cost the transfer its stop, or the person the explanation.
    it('never throws into the frame that triggered it', () => {
        sentry.withScope.mockImplementation(() => {
            throw new Error('sentry is broken');
        });
        expect(() => reportLinkKey(REPORT)).not.toThrow();
    });
});
