/**
 * Shared Request link fixtures for the render tests and the Wails mock in
 * setup.ts. A module of its own because setup.ts runs as a setup file, and a
 * test importing it directly would be a second path into that side effect.
 */

/** The snapshot the stubbed lane answers with: off, nothing open. Also the
 *  base a test spreads when it builds a live snapshot of its own. */
export const offSnapshot = {
    state: 'off',
    code: '',
    gen: 0,
    seq: 0,
    promptGen: 0,
    link: '',
    label: '',
    saveDir: '',
    expiresAt: 0,
    route: '',
    suggestClose: false,
};

/** Every Request link binding (the eight of E-11). The switch-off test asserts
 *  none of these runs at mount, so a new binding belongs here too. */
export const REQUEST_BINDINGS = [
    'AnswerRequest',
    'CancelRequestDrop',
    'CloseRequestLink',
    'GetRequestLink',
    'MakeRequestLink',
    'RequestLinkSupport',
    'RetryRequestLink',
    'SetRequestLinks',
] as const;
