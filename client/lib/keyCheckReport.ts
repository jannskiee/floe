// O7: one Sentry warning for each link-key check that did not verify, so a mismatch
// between two engines' hashes shows up during the soak instead of as a mystery. The
// main page calls reportLinkKey from its session's onReport, and so will /r, by this
// one name (decision W2).
//
// Enums and nothing else. A report never holds the link, the key, a tag, a certificate
// or anything the other device sent: keySession.ts hands over four enums, this copies
// those four through an allowlist, and it attaches no context, no extra and no user. A
// value outside a list sends nothing, so free text has no way to ride a field. The
// event then goes through the same send hooks as any other (lib/scrubUrl.ts,
// lib/failClosed.ts), which take the room link out of the page address it carries.
//
// The privacy page names what this sends (lib/privacyText.test.ts holds the two
// together), so a change here moves with that page.

import * as Sentry from '@sentry/nextjs';
import type { KeyReport } from './transfer/keySession';

const ROLES: ReadonlySet<string> = new Set(['sender', 'receiver', 'visitor']);
const PATHS: ReadonlySet<string> = new Set(['der', 'sdp', 'none']);
const OUTCOMES: ReadonlySet<string> = new Set(['bad-tag', 'malformed', 'missing', 'silent', 'unavailable', 'peer-refused']);
const MODES: ReadonlySet<string> = new Set(['enforce', 'detect', 'observe']);

export interface KeyCheckEvent {
    message: string;
    level: 'warning';
    tags: {
        'linkkey.role': string;
        'linkkey.path': string;
        'linkkey.outcome': string;
        'linkkey.mode': string;
    };
    fingerprint: string[];
}

/** What Sentry is told about a check, or null for a report it must not hear of. One
 *  issue per role, outcome and path. */
export function keyCheckReport(report: KeyReport): KeyCheckEvent | null {
    const { role, path, outcome, mode } = report;
    if (!ROLES.has(role) || !PATHS.has(path) || !OUTCOMES.has(outcome) || !MODES.has(mode)) return null;
    // Silence is every web send to a released floe, which has no kc to send, and a
    // warning per such send would bury what this exists to show. keySession.ts decides
    // silence only in enforce mode, and this holds the same line a second time.
    if (outcome === 'silent' && mode !== 'enforce') return null;
    return {
        message: 'Link key check failed',
        level: 'warning',
        tags: {
            'linkkey.role': role,
            'linkkey.path': path,
            'linkkey.outcome': outcome,
            'linkkey.mode': mode,
        },
        fingerprint: ['link-key', role, outcome, path],
    };
}

/** Sends it. Runs inside the data callback that delivered the frame, so a telemetry
 *  failure stops here: it must not cost the transfer its stop, or the person their
 *  explanation. */
export function reportLinkKey(report: KeyReport): void {
    const event = keyCheckReport(report);
    if (!event) return;
    try {
        Sentry.withScope((scope) => {
            scope.setTags(event.tags);
            scope.setFingerprint(event.fingerprint);
            Sentry.captureMessage(event.message, event.level);
        });
    } catch {
        // Telemetry is best effort.
    }
}
